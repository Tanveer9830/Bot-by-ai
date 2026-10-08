import { randomUUID } from 'node:crypto';
import type { Client } from 'discord.js';
import type { Logger } from '@bot-by-ai/shared';
import { errorForLog } from '@bot-by-ai/shared';
import type { Repositories, ScheduledTask } from '@bot-by-ai/database';
import type { BotServices } from '../core/context.js';

const MAX_ATTEMPTS = 5;

/**
 * Durable background worker.
 *
 * Tasks are claimed from the `scheduled_tasks` table with `FOR UPDATE SKIP
 * LOCKED`, so running several processes (or restarts) never double-executes a
 * scheduled job. Failures are retried with linear backoff and eventually marked
 * `failed` instead of looping forever.
 */
export class SchedulerService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private readonly workerId = `worker-${randomUUID().slice(0, 8)}`;
  private readonly services: () => BotServices;

  constructor(
    private readonly client: Client,
    private readonly repos: Repositories,
    private readonly logger: Logger,
    services: () => BotServices,
    private readonly pollIntervalMs = 5_000,
  ) {
    this.services = services;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    this.timer.unref?.();
    this.logger.info('scheduler started', { workerId: this.workerId });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Give an in-flight tick a moment to finish so we do not leave tasks 'running'.
    const deadline = Date.now() + 5_000;
    while (this.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Single poll iteration; exported for tests. */
  async tick(): Promise<number> {
    if (this.running || this.stopped) return 0;
    this.running = true;
    let processed = 0;
    try {
      const tasks = await this.repos.tasks.claimDue(this.workerId, 10, MAX_ATTEMPTS);
      for (const task of tasks) {
        await this.handle(task);
        processed += 1;
      }
    } catch (error) {
      this.logger.error('scheduler tick failed', errorForLog(error));
    } finally {
      this.running = false;
    }
    return processed;
  }

  private async handle(task: ScheduledTask): Promise<void> {
    try {
      const result = await this.execute(task);
      await this.repos.tasks.complete(task.id);
      this.logger.debug('task completed', { taskType: task.task_type, id: task.id, result });
      // Recurring tasks re-enqueue themselves so maintenance jobs keep running
      // without an external cron or an in-memory timer that dies on restart.
      const recurringMs = Number((task.payload ?? {}).recurringMs ?? 0);
      if (Number.isFinite(recurringMs) && recurringMs >= 60_000) {
        await this.rescheduleRecurring(task.task_type, recurringMs).catch(() => {});
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const backoff = Math.min(10 * 60_000, 5_000 * 2 ** Math.max(0, task.attempts - 1));
      await this.repos.tasks
        .fail(task.id, message, backoff, MAX_ATTEMPTS)
        .catch((failError) =>
          this.logger.error('failed to mark task as failed', errorForLog(failError)),
        );
      this.logger.warn('task failed', {
        taskType: task.task_type,
        id: task.id,
        attempts: task.attempts,
        error: message,
      });
    }
  }

  private async execute(task: ScheduledTask): Promise<string> {
    const services = this.services();
    const payload = task.payload ?? {};
    switch (task.task_type) {
      case 'giveaway_end': {
        const giveawayId = Number(payload.giveawayId);
        const guildId = task.guild_id;
        if (!guildId || !Number.isFinite(giveawayId)) return 'skipped: invalid payload';
        const guild =
          this.client.guilds.cache.get(guildId) ??
          (await this.client.guilds.fetch(guildId).catch(() => null));
        if (!guild) return 'skipped: guild unavailable';
        const result = await services.community.endGiveaway({ guild, giveawayId });
        return `winners: ${result.winners.length}`;
      }
      case 'reminder_deliver': {
        const reminderId = Number(payload.reminderId);
        const guild = task.guild_id
          ? (this.client.guilds.cache.get(task.guild_id) ??
            (await this.client.guilds.fetch(task.guild_id).catch(() => null)))
          : null;
        const delivered = await services.community.deliverReminder(guild, reminderId);
        return delivered ? 'delivered' : 'skipped: reminder not found';
      }
      case 'ticket_autoclose': {
        const guild = task.guild_id
          ? (this.client.guilds.cache.get(task.guild_id) ??
            (await this.client.guilds.fetch(task.guild_id).catch(() => null)))
          : null;
        if (!guild) return 'skipped: guild unavailable';
        const closed = await services.tickets.autoCloseStale(guild);
        return `closed: ${closed}`;
      }
      case 'case_expire': {
        const expired = await services.moderation.expireCases();
        return `expired: ${expired}`;
      }
      case 'lockdown_expire': {
        const lifted = await services.security.expireLockdowns(this.client);
        return `lifted: ${lifted}`;
      }
      case 'birthday_announce': {
        let announced = 0;
        for (const guild of this.client.guilds.cache.values()) {
          announced += await services.community.announceBirthdays(guild).catch(() => 0);
        }
        return `announced: ${announced}`;
      }
      case 'retention_cleanup': {
        const days = Number(payload.days ?? 90);
        const removed = await services.repos.audit.pruneOlderThan(days);
        const sessions = await services.repos.sessions.cleanup();
        const tasks = await services.repos.tasks.cleanup(7);
        return `audit: ${removed}, sessions: ${sessions}, tasks: ${tasks}`;
      }
      case 'status_heartbeat': {
        await services.status.heartbeat(0);
        return 'heartbeat sent';
      }
      default:
        return `unknown task type: ${task.task_type}`;
    }
  }

  /** Enqueues the recurring maintenance tasks once per startup (idempotent keys). */
  async ensureRecurringTasks(): Promise<void> {
    const recurring: { taskType: string; everyMs: number; payload?: Record<string, unknown> }[] = [
      { taskType: 'case_expire', everyMs: 10 * 60_000 },
      { taskType: 'lockdown_expire', everyMs: 60_000 },
      { taskType: 'ticket_autoclose', everyMs: 30 * 60_000 },
      { taskType: 'birthday_announce', everyMs: 60 * 60_000 },
      { taskType: 'retention_cleanup', everyMs: 24 * 60 * 60_000, payload: { days: 90 } },
      { taskType: 'status_heartbeat', everyMs: 60_000 },
    ];
    for (const entry of recurring) {
      const nextRun = new Date(Date.now() + entry.everyMs);
      await this.repos.tasks
        .enqueue({
          taskType: entry.taskType,
          guildId: null,
          payload: { ...(entry.payload ?? {}), recurringMs: entry.everyMs },
          runAt: nextRun,
        })
        .catch((error) =>
          this.logger.warn('failed to enqueue recurring task', {
            taskType: entry.taskType,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
    }
  }

  /** Re-enqueues a recurring task after it completes (called from execute wrappers). */
  async rescheduleRecurring(taskType: string, intervalMs: number): Promise<void> {
    await this.repos.tasks.enqueue({
      taskType,
      guildId: null,
      payload: { recurringMs: intervalMs },
      runAt: new Date(Date.now() + intervalMs),
    });
  }
}
