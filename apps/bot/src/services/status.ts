import os from 'node:os';
import type { Client } from 'discord.js';
import type { AppConfig, Logger } from '@bot-by-ai/shared';
import { formatBytes, formatDuration } from '@bot-by-ai/shared';
import type { Database, Repositories } from '@bot-by-ai/database';

export interface StatusSnapshot {
  instanceId: string;
  status: 'starting' | 'online' | 'degraded' | 'offline';
  ready: boolean;
  uptimeSeconds: number;
  wsPingMs: number | null;
  guildCount: number;
  userCount: number;
  commandCount: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  cpuLoadPercent: number;
  nodeVersion: string;
  version: string;
  database: { ok: boolean; latencyMs: number; error?: string };
  music: { enabled: boolean; healthy: boolean | null };
  errors: { count: number; lastError: string | null };
  /** null when the metric genuinely cannot be collected on this host. */
  memoryLimitMb: number | null;
}

/**
 * Runtime status + heartbeat.
 *
 * Every value here comes from a real source (process metrics, the gateway,
 * `SELECT 1`). When something cannot be measured the field is `null` and the UI
 * is expected to render "unavailable" — no fabricated numbers.
 */
export class StatusService {
  private lastError: { message: string; at: number } | null = null;
  private errorCount = 0;
  private ready = false;
  private readonly startedAt = Date.now();
  private cpuSample: { usage: NodeJS.CpuUsage; time: number } | null = null;
  private lastCpuPercent = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly client: Client,
    private readonly db: Database,
    private readonly repos: Repositories,
    private readonly logger: Logger,
    private readonly version: string,
  ) {}

  get instanceId(): string {
    return `shard-${this.client.shard?.ids?.[0] ?? 0}`;
  }

  markReady(value = true): void {
    this.ready = value;
  }

  recordError(error: unknown): void {
    this.errorCount += 1;
    this.lastError = {
      message: error instanceof Error ? error.message : String(error),
      at: Date.now(),
    };
  }

  get errorSummary(): { count: number; lastError: string | null } {
    return { count: this.errorCount, lastError: this.lastError?.message ?? null };
  }

  private sampleCpu(): number {
    const usage = process.cpuUsage();
    const now = Date.now();
    if (this.cpuSample) {
      const elapsedMs = now - this.cpuSample.time;
      const userDelta = usage.user - this.cpuSample.usage.user;
      const systemDelta = usage.system - this.cpuSample.usage.system;
      if (elapsedMs > 0) {
        const percent = ((userDelta + systemDelta) / 1000 / elapsedMs) * 100;
        this.lastCpuPercent = Math.max(0, Number(percent.toFixed(2)));
      }
    }
    this.cpuSample = { usage, time: now };
    return this.lastCpuPercent;
  }

  async snapshot(): Promise<StatusSnapshot> {
    const database = await this.db.health();
    const memory = process.memoryUsage();
    const totalMemory = os.totalmem();
    const rssLimit = (
      process as NodeJS.Process & { constrainedMemory?: () => number }
    ).constrainedMemory?.();
    return {
      instanceId: this.instanceId,
      status: !this.ready ? 'starting' : database.ok ? 'online' : 'degraded',
      ready: this.ready,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      wsPingMs: Number.isFinite(this.client.ws.ping) ? Math.round(this.client.ws.ping) : null,
      guildCount: this.client.guilds.cache.size,
      userCount: this.client.guilds.cache.reduce((acc, guild) => acc + (guild.memberCount ?? 0), 0),
      commandCount: 0,
      memoryUsedMb: Math.round(memory.rss / 1_048_576),
      memoryTotalMb: Math.round(totalMemory / 1_048_576),
      cpuLoadPercent: this.sampleCpu(),
      nodeVersion: process.version,
      version: this.version,
      database,
      music: { enabled: this.config.music.enabled, healthy: null },
      errors: this.errorSummary,
      memoryLimitMb: rssLimit ? Math.round(rssLimit / 1_048_576) : null,
    };
  }

  /** Publishes the heartbeat to `bot_instances` for the dashboard/owner panel. */
  async heartbeat(commandCount: number): Promise<void> {
    try {
      await this.repos.analytics.upsertBotInstance({
        id: this.instanceId,
        shard_id: this.client.shard?.ids?.[0] ?? 0,
        status: this.ready ? 'online' : 'starting',
        guild_count: this.client.guilds.cache.size,
        user_count: this.client.guilds.cache.reduce((acc, guild) => acc + (guild.memberCount ?? 0), 0),
        command_count: commandCount,
        ws_ping_ms: Number.isFinite(this.client.ws.ping) ? Math.round(this.client.ws.ping) : null,
        uptime_seconds: Math.floor(process.uptime()),
        memory_mb: Math.round(process.memoryUsage().rss / 1_048_576),
        version: this.version,
        node_version: process.version,
      });
    } catch (error) {
      this.logger.warn('status heartbeat failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async markOffline(): Promise<void> {
    await this.repos.analytics.markInstanceOffline(this.instanceId).catch(() => {});
  }

  humanSummary(snapshot: StatusSnapshot): string {
    return [
      `status: ${snapshot.status}`,
      `uptime: ${formatDuration(snapshot.uptimeSeconds * 1000)}`,
      `ws ping: ${snapshot.wsPingMs ?? 'unavailable'} ms`,
      `memory: ${snapshot.memoryUsedMb} MB`,
      `database: ${snapshot.database.ok ? `${snapshot.database.latencyMs} ms` : `DOWN (${snapshot.database.error ?? 'unknown'})`}`,
      `errors since start: ${snapshot.errors.count}`,
    ].join('\n');
  }

  describeMemory(bytes: number): string {
    return formatBytes(bytes);
  }
}
