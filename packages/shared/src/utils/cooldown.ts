/**
 * In-memory cooldown + sliding-window rate limiting.
 *
 * Redis is optional: when configured, callers can mirror these buckets into
 * Redis for multi-process deployments (see `RateLimiter.snapshot`). Local
 * enforcement always runs so a Redis outage cannot disable anti-abuse.
 */
import { CooldownError, RateLimitError } from './errors.js';

export interface CooldownBucketOptions {
  /** Milliseconds a bucket stays locked after use. */
  windowMs: number;
  /** Uses allowed per user in the window (default 1). */
  uses?: number;
  /** Maximum number of tracked keys before a sweep happens. */
  maxKeys?: number;
}

export class CooldownBucket {
  private readonly hits = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly uses: number;
  private readonly maxKeys: number;

  constructor(options: CooldownBucketOptions) {
    this.windowMs = options.windowMs;
    this.uses = Math.max(1, options.uses ?? 1);
    this.maxKeys = options.maxKeys ?? 25_000;
  }

  /** Remaining wait in ms (0 = ready). */
  remaining(key: string, now = Date.now()): number {
    const timestamps = this.hits.get(key);
    if (!timestamps || timestamps.length === 0) return 0;
    const valid = timestamps.filter((ts) => now - ts < this.windowMs);
    if (valid.length < this.uses) return 0;
    const oldest = valid[valid.length - this.uses] as number;
    return Math.max(0, this.windowMs - (now - oldest));
  }

  consume(key: string, now = Date.now()): { ok: boolean; retryAfterMs: number } {
    const wait = this.remaining(key, now);
    if (wait > 0) return { ok: false, retryAfterMs: wait };
    const timestamps = (this.hits.get(key) ?? []).filter((ts) => now - ts < this.windowMs);
    timestamps.push(now);
    this.hits.set(key, timestamps);
    if (this.hits.size > this.maxKeys) this.sweep(now);
    return { ok: true, retryAfterMs: 0 };
  }

  /** Throwing variant for command handlers. */
  assert(key: string, now = Date.now()): void {
    const result = this.consume(key, now);
    if (!result.ok) throw new CooldownError(result.retryAfterMs, { bucketKey: key });
  }

  private sweep(now: number): void {
    for (const [key, timestamps] of this.hits) {
      const valid = timestamps.filter((ts) => now - ts < this.windowMs);
      if (valid.length === 0) this.hits.delete(key);
      else this.hits.set(key, valid);
    }
  }

  clear(): void {
    this.hits.clear();
  }

  get size(): number {
    return this.hits.size;
  }
}

export interface RateLimiterOptions {
  /** Rolling window length in ms. */
  windowMs: number;
  /** Max requests allowed inside the window. */
  limit: number;
  maxKeys?: number;
}

/** Generic sliding-window limiter (used for HTTP routes and message-driven features). */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly options: RateLimiterOptions) {}

  check(
    key: string,
    now = Date.now(),
  ): { allowed: boolean; remaining: number; retryAfterMs: number } {
    const timestamps = (this.hits.get(key) ?? []).filter((ts) => now - ts < this.options.windowMs);
    if (timestamps.length >= this.options.limit) {
      const oldest = timestamps[0] as number;
      const retryAfterMs = Math.max(0, this.options.windowMs - (now - oldest));
      this.hits.set(key, timestamps);
      return { allowed: false, remaining: 0, retryAfterMs };
    }
    timestamps.push(now);
    this.hits.set(key, timestamps);
    if (this.hits.size > (this.options.maxKeys ?? 25_000)) this.sweep(now);
    return { allowed: true, remaining: this.options.limit - timestamps.length, retryAfterMs: 0 };
  }

  assert(key: string, now = Date.now()): void {
    const result = this.check(key, now);
    if (!result.allowed) throw new RateLimitError(result.retryAfterMs);
  }

  private sweep(now: number): void {
    for (const [key, timestamps] of this.hits) {
      const valid = timestamps.filter((ts) => now - ts < this.options.windowMs);
      if (valid.length === 0) this.hits.delete(key);
      else this.hits.set(key, valid);
    }
  }

  clear(): void {
    this.hits.clear();
  }

  get size(): number {
    return this.hits.size;
  }
}
