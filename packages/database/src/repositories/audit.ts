import type { Database } from '../pool.js';

export interface AuditLogEntry {
  guildId?: string | null;
  actorId?: string | null;
  actorType?: 'user' | 'system' | 'dashboard' | 'bot';
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: unknown;
  ipHash?: string | null;
}

export class AuditRepository {
  constructor(private readonly db: Database) {}

  async log(entry: AuditLogEntry): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_logs (guild_id, actor_id, actor_type, action, target_type, target_id, metadata, ip_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [
        entry.guildId ?? null,
        entry.actorId ?? null,
        entry.actorType ?? 'user',
        entry.action,
        entry.targetType ?? null,
        entry.targetId ?? null,
        entry.metadata === undefined ? null : JSON.stringify(entry.metadata),
        entry.ipHash ?? null,
      ],
    );
  }

  async logMany(entries: readonly AuditLogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const values: unknown[] = [];
    const placeholders: string[] = [];
    entries.forEach((entry, index) => {
      const base = index * 8;
      placeholders.push(
        `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7}::jsonb,$${base + 8})`,
      );
      values.push(
        entry.guildId ?? null,
        entry.actorId ?? null,
        entry.actorType ?? 'user',
        entry.action,
        entry.targetType ?? null,
        entry.targetId ?? null,
        entry.metadata === undefined ? null : JSON.stringify(entry.metadata),
        entry.ipHash ?? null,
      );
    });
    await this.db.query(
      `INSERT INTO audit_logs (guild_id, actor_id, actor_type, action, target_type, target_id, metadata, ip_hash)
       VALUES ${placeholders.join(',')}`,
      values,
    );
  }

  async list(
    options: {
      guildId?: string | null;
      actorId?: string;
      action?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<{
    rows: {
      id: number;
      guild_id: string | null;
      actor_id: string | null;
      actor_type: string;
      action: string;
      target_type: string | null;
      target_id: string | null;
      metadata: unknown;
      created_at: Date;
    }[];
    total: number;
  }> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);
    const params: unknown[] = [];
    const filters: string[] = [];
    if (options.guildId) {
      params.push(options.guildId);
      filters.push(`guild_id = $${params.length}`);
    }
    if (options.actorId) {
      params.push(options.actorId);
      filters.push(`actor_id = $${params.length}`);
    }
    if (options.action) {
      params.push(options.action);
      filters.push(`action = $${params.length}`);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const { rows } = await this.db.query(
      `SELECT id, guild_id, actor_id, actor_type, action, target_type, target_id, metadata, created_at,
              count(*) OVER()::int AS total
         FROM audit_logs ${where} ORDER BY created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    return { rows: rows as never, total: Number((rows[0] as { total?: number } | undefined)?.total ?? 0) };
  }

  /** Retention cleanup used by the scheduled task worker. */
  async pruneOlderThan(days: number): Promise<number> {
    if (days <= 0) return 0;
    const { rowCount } = await this.db.query(
      `DELETE FROM audit_logs WHERE created_at < now() - ($1::int * interval '1 day')`,
      [days],
    );
    return rowCount ?? 0;
  }
}

export class CommandUsageRepository {
  constructor(private readonly db: Database) {}

  async record(input: {
    guildId: string | null;
    userId: string | null;
    commandName: string;
    success: boolean;
    errorCode?: string | null;
    durationMs?: number | null;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO command_usage (guild_id, user_id, command_name, success, error_code, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        input.guildId,
        input.userId,
        input.commandName,
        input.success,
        input.errorCode ?? null,
        input.durationMs ?? null,
      ],
    );
  }

  async statsForGuild(guildId: string, days = 30): Promise<
    { day: string; total: number; failed: number }[]
  > {
    const { rows } = await this.db.query<{ day: string; total: number; failed: number }>(
      `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
              count(*)::int AS total,
              count(*) FILTER (WHERE success = FALSE)::int AS failed
         FROM command_usage
        WHERE guild_id = $1 AND created_at > now() - ($2::int * interval '1 day')
        GROUP BY 1 ORDER BY 1 ASC`,
      [guildId, days],
    );
    return rows;
  }

  async topCommands(guildId: string, days = 30, limit = 10): Promise<{ command_name: string; uses: number }[]> {
    const { rows } = await this.db.query<{ command_name: string; uses: number }>(
      `SELECT command_name, count(*)::int AS uses FROM command_usage
        WHERE guild_id = $1 AND created_at > now() - ($2::int * interval '1 day')
        GROUP BY 1 ORDER BY uses DESC LIMIT $3`,
      [guildId, days, Math.min(Math.max(limit, 1), 50)],
    );
    return rows;
  }

  async globalStats(days = 7): Promise<{ total: number; failed: number; activeGuilds: number }> {
    const { rows } = await this.db.query<{ total: string; failed: string; guilds: string }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE success = FALSE)::text AS failed,
              count(DISTINCT guild_id)::text AS guilds
         FROM command_usage WHERE created_at > now() - ($1::int * interval '1 day')`,
      [days],
    );
    const row = rows[0];
    return {
      total: Number(row?.total ?? 0),
      failed: Number(row?.failed ?? 0),
      activeGuilds: Number(row?.guilds ?? 0),
    };
  }
}
