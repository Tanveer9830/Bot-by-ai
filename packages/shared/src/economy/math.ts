/**
 * Pure economy math. Every function here is deterministic and unit-tested so
 * that the transactional layer in the database has no hidden arithmetic.
 */
import { BusinessError, ValidationError } from '../utils/errors.js';

export const MAX_CURRENCY_AMOUNT = 1_000_000_000_000; // 1 trillion units, guards bigint->int8 overflow

export function assertValidAmount(amount: unknown, field = 'amount'): number {
  const value = typeof amount === 'string' ? Number(amount) : amount;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${field} must be a finite number.`);
  }
  if (!Number.isInteger(value)) {
    throw new ValidationError(`${field} must be a whole number.`);
  }
  if (value <= 0) {
    throw new ValidationError(`${field} must be greater than zero.`);
  }
  if (value > MAX_CURRENCY_AMOUNT) {
    throw new ValidationError(`${field} must be at most ${MAX_CURRENCY_AMOUNT}.`);
  }
  return value;
}

export function assertSufficientFunds(balance: number, amount: number, account = 'wallet'): void {
  if (balance < amount) {
    throw new BusinessError(
      'INSUFFICIENT_FUNDS',
      `Insufficient ${account} balance: you have ${balance} but need ${amount}.`,
      { balance, amount },
    );
  }
}

/** Daily reward with a streak bonus, capped so the streak cannot run away. */
export function computeDailyReward(options: {
  base: number;
  streak: number;
  streakBonusPercent?: number;
  maxMultiplier?: number;
}): { amount: number; multiplier: number } {
  const { base, streak } = options;
  const bonusPercent = options.streakBonusPercent ?? 5;
  const maxMultiplier = options.maxMultiplier ?? 5;
  const safeBase = Math.max(0, Math.floor(base));
  const safeStreak = Math.max(0, Math.floor(streak));
  const multiplier = Math.min(1 + (bonusPercent / 100) * safeStreak, maxMultiplier);
  const amount = Math.floor(safeBase * multiplier);
  return {
    amount: Math.min(amount, MAX_CURRENCY_AMOUNT),
    multiplier: Number(multiplier.toFixed(4)),
  };
}

/** Work cooldown rewards scale with level so progression stays meaningful. */
export function computeWorkReward(options: {
  min: number;
  max: number;
  level: number;
  levelScalingPercent?: number;
  roll: number;
}): number {
  const min = Math.max(0, Math.floor(options.min));
  const max = Math.max(min, Math.floor(options.max));
  const scaling = 1 + ((options.levelScalingPercent ?? 2) / 100) * Math.max(0, options.level);
  const roll = Math.min(Math.max(options.roll, 0), 0.999999);
  const raw = min + roll * (max - min);
  return Math.max(min, Math.min(Math.floor(raw * scaling), MAX_CURRENCY_AMOUNT));
}

/** Transfer fee handling (fee is burned, never credited to the recipient). */
export function computeTransfer(options: {
  amount: number;
  feePercent?: number;
  maxFee?: number;
}): { amount: number; fee: number; total: number; credited: number } {
  const amount = assertValidAmount(options.amount);
  const feePercent = Math.max(0, options.feePercent ?? 0);
  const rawFee = Math.floor((amount * feePercent) / 100);
  const fee = options.maxFee === undefined ? rawFee : Math.min(rawFee, Math.max(0, options.maxFee));
  return { amount, fee, total: amount + fee, credited: amount };
}

/** Streak accounting for daily/weekly rewards. */
export function nextStreak(options: {
  lastClaimAt: number | null;
  now: number;
  periodMs: number;
  graceMs?: number;
  currentStreak?: number;
}): { streak: number; reset: boolean; claimable: boolean; nextClaimAt: number } {
  const grace = options.graceMs ?? 0;
  const current = Math.max(0, options.currentStreak ?? 0);
  if (options.lastClaimAt === null) {
    return {
      streak: 1,
      reset: false,
      claimable: true,
      nextClaimAt: options.now + options.periodMs,
    };
  }
  const elapsed = options.now - options.lastClaimAt;
  if (elapsed < options.periodMs) {
    return {
      streak: current,
      reset: false,
      claimable: false,
      nextClaimAt: options.lastClaimAt + options.periodMs,
    };
  }
  const claimable = true;
  const withinGrace = elapsed <= options.periodMs * 2 + grace;
  return {
    streak: withinGrace ? current + 1 : 1,
    reset: !withinGrace,
    claimable,
    nextClaimAt: options.now + options.periodMs,
  };
}

/** Deterministic hash used for idempotency keys of reward operations. */
export function idempotencyKey(parts: readonly (string | number)[]): string {
  const input = parts.join('|');
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `idem_${(hash >>> 0).toString(36)}_${input.length.toString(36)}`;
}
