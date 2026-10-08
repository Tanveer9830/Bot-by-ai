import type { Database } from '../pool.js';

export interface ScheduledTask {
  id: number;
  guild_id: string | null;
  task_type: string;
  payload: Record<string, unknown>;
  run_at: Date;
  status: 'pending' | 'running' | 'done' | 'failed';
  attempts: number;
  last_error: string | null;
  locked_at: Date | null;
  locked_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Durable task queue.
 *
 * `claimDue` uses SELECT ... FOR UPDATE SKIP LOCKED so multiple bot shards /
 * worker processes can poll the same table without double-executing a task.
 */
export class TaskRepository {
  constructor(private readonly db: Database) {}

  async enqueue(input: {
    taskType: string;
    guildId?: string | null;
    payload?: Record<string, unknown>;
    runAt?: Date;
  }): Promise<number> {
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO scheduled_tasks (guild_id, task_type, payload, run_at) VALUES ($1,$2,$3::jsonb,$4)
       RETURNING id`,
      [input.guildId ?? null, input.taskType, JSON.stringify(input.payload ?? {}), input.runAt ?? new Date()],
    );
    return Number(rows[0]?.id);
  }

  async claimDue(workerId: string, limit = 10, maxAttempts = 5): Promise<ScheduledTask[]> {
    return this.db.transaction(async (client) => {
      const { rows } = await client.query<ScheduledTask>(
        `WITH due AS (
           SELECT id FROM scheduled_tasks
            WHERE status = 'pending' AND run_at <= now() AND attempts < $3
            ORDER BY run_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT $2
         )
         UPDATE scheduled_tasks t
            SET status = 'running', locked_at = now(), locked_by = $1, attempts = t.attempts + 1, updated_at = now()
           FROM due
          WHERE t.id = due.id
          RETURNING t.*`,
        [workerId, limit, maxAttempts],
      );
      // Also reclaim tasks whose worker died mid-run.
      await client.query(
        `UPDATE scheduled_tasks SET status = 'pending', locked_at = NULL, locked_by = NULL, updated_at = now()
          WHERE status = 'running' AND locked_at < now() - interval '10 minutes'`,
      );
      return rows;
    });
  }

  async complete(id: number): Promise<void> {
    await this.db.query(
      `UPDATE scheduled_tasks SET status = 'done', locked_at = NULL, locked_by = NULL, updated_at = now()
        WHERE id = $1`,
      [id],
    );
  }

  /** Failed tasks are retried with backoff until `maxAttempts` is reached. */
  async fail(id: number, error: string, retryDelayMs = 60_000, maxAttempts = 5): Promise<void> {
    await this.db.query(
      `UPDATE scheduled_tasks
          SET last_error = $2,
              status = CASE WHEN attempts >= $5 THEN 'failed' ELSE 'pending' END,
              run_at = now() + ($3::int * interval '1 millisecond'),
              locked_at = NULL, locked_by = NULL, updated_at = now()
        WHERE id = $1`,
      [id, error.slice(0, 2000), Math.max(0, retryDelayMs), maxAttempts, maxAttempts],
    );
  }

  async cleanup(days = 7): Promise<number> {
    const { rowCount } = await this.db.query(
      `DELETE FROM scheduled_tasks
        WHERE status IN ('done', 'failed') AND updated_at < now() - ($1::int * interval '1 day')`,
      [days],
    );
    return rowCount ?? 0;
  }

  async pendingCount(): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM scheduled_tasks WHERE status = 'pending'`,
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** Removes a pending task matching a type+payload key (used to cancel timers). */
  async cancelByPayload(taskType: string, payloadKey: string, payloadValue: string): Promise<number> {
    const { rowCount } = await this.db.query(
      `DELETE FROM scheduled_tasks WHERE task_type = $1 AND status = 'pending' AND payload->>$2 = $3`,
      [taskType, payloadKey, payloadValue],
    );
    return rowCount ?? 0;
  }
}
