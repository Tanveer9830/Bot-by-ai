import type { Database } from '../pool.js';

export interface BotInstanceRow {
  id: string;
  shard_id: number | null;
  status: string;
  guild_count: number;
  user_count: number;
  command_count: number;
  ws_ping_ms: number | null;
  uptime_seconds: number;
  memory_mb: number | null;
  version: string | null;
  node_version: string | null;
  started_at: Date;
  last_heartbeat_at: Date;
}

/**
 * Read-mostly aggregate queries for the dashboard. Everything here returns real
 * observed data or `null`/0 — the UI renders "unavailable" rather than fakes.
 */
export class AnalyticsRepository {
  constructor(private readonly db: Database) {}

  async moderationByAction(
    guildId: string,
    days = 30,
  ): Promise<{ action: string; count: number }[]> {
    const { rows } = await this.db.query<{ action: string; count: number }>(
      `SELECT action, count(*)::int AS count FROM moderation_cases
        WHERE guild_id = $1 AND created_at > now() - ($2::int * interval '1 day')
        GROUP BY action ORDER BY count DESC`,
      [guildId, days],
    );
    return rows;
  }

  async moderationByDay(guildId: string, days = 30): Promise<{ day: string; count: number }[]> {
    const { rows } = await this.db.query<{ day: string; count: number }>(
      `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*)::int AS count
         FROM moderation_cases
        WHERE guild_id = $1 AND created_at > now() - ($2::int * interval '1 day')
        GROUP BY 1 ORDER BY 1`,
      [guildId, days],
    );
    return rows;
  }

  async securityByDay(guildId: string, days = 30): Promise<{ day: string; count: number; high: number }[]> {
    const { rows } = await this.db.query<{ day: string; count: number; high: number }>(
      `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
              count(*)::int AS count,
              count(*) FILTER (WHERE severity >= 3)::int AS high
         FROM security_events
        WHERE guild_id = $1 AND created_at > now() - ($2::int * interval '1 day')
        GROUP BY 1 ORDER BY 1`,
      [guildId, days],
    );
    return rows;
  }

  async topOffenders(
    guildId: string,
    days = 30,
    limit = 5,
  ): Promise<{ user_id: string; violations: number }[]> {
    const { rows } = await this.db.query<{ user_id: string; violations: number }>(
      `SELECT user_id, count(*)::int AS violations FROM automod_violations
        WHERE guild_id = $1 AND created_at > now() - ($2::int * interval '1 day')
        GROUP BY user_id ORDER BY violations DESC LIMIT $3`,
      [guildId, days, limit],
    );
    return rows;
  }

  async guildOverview(guildId: string): Promise<{
    moderationCases30d: number;
    warnings30d: number;
    securityEvents30d: number;
    openTickets: number;
    giveawaysActive: number;
    suggestions30d: number;
    economyAccounts: number;
    levelsTracked: number;
    trackedUsers: number;
  }> {
    const { rows } = await this.db.query<Record<string, string>>(
      `SELECT
         (SELECT count(*) FROM moderation_cases WHERE guild_id = $1 AND created_at > now() - interval '30 days') AS mod30,
         (SELECT count(*) FROM warnings WHERE guild_id = $1 AND created_at > now() - interval '30 days') AS warn30,
         (SELECT count(*) FROM security_events WHERE guild_id = $1 AND created_at > now() - interval '30 days') AS sec30,
         (SELECT count(*) FROM tickets WHERE guild_id = $1 AND status <> 'closed') AS tickets,
         (SELECT count(*) FROM giveaways WHERE guild_id = $1 AND ended = FALSE AND cancelled = FALSE) AS giveaways,
         (SELECT count(*) FROM suggestions WHERE guild_id = $1 AND created_at > now() - interval '30 days') AS sugg30,
         (SELECT count(*) FROM economy_accounts WHERE guild_id = $1) AS econ,
         (SELECT count(*) FROM member_levels WHERE guild_id = $1) AS levels,
         (SELECT count(*) FROM users) AS users`,
      [guildId],
    );
    const row = rows[0] ?? {};
    const num = (key: string) => Number(row[key] ?? 0);
    return {
      moderationCases30d: num('mod30'),
      warnings30d: num('warn30'),
      securityEvents30d: num('sec30'),
      openTickets: num('tickets'),
      giveawaysActive: num('giveaways'),
      suggestions30d: num('sugg30'),
      economyAccounts: num('econ'),
      levelsTracked: num('levels'),
      trackedUsers: num('users'),
    };
  }

  // ------------------------------------------------------------ bot instances

  async upsertBotInstance(row: Partial<BotInstanceRow> & { id: string }): Promise<void> {
    await this.db.query(
      `INSERT INTO bot_instances
         (id, shard_id, status, guild_count, user_count, command_count, ws_ping_ms, uptime_seconds, memory_mb, version, node_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         guild_count = EXCLUDED.guild_count,
         user_count = EXCLUDED.user_count,
         command_count = EXCLUDED.command_count,
         ws_ping_ms = EXCLUDED.ws_ping_ms,
         uptime_seconds = EXCLUDED.uptime_seconds,
         memory_mb = EXCLUDED.memory_mb,
         version = EXCLUDED.version,
         node_version = EXCLUDED.node_version,
         last_heartbeat_at = now()`,
      [
        row.id,
        row.shard_id ?? null,
        row.status ?? 'online',
        row.guild_count ?? 0,
        row.user_count ?? 0,
        row.command_count ?? 0,
        row.ws_ping_ms ?? null,
        row.uptime_seconds ?? 0,
        row.memory_mb ?? null,
        row.version ?? null,
        row.node_version ?? null,
      ],
    );
  }

  async listBotInstances(): Promise<BotInstanceRow[]> {
    const { rows } = await this.db.query<BotInstanceRow>(
      'SELECT * FROM bot_instances ORDER BY last_heartbeat_at DESC',
    );
    return rows;
  }

  async markInstanceOffline(id: string): Promise<void> {
    await this.db.query(`UPDATE bot_instances SET status = 'offline' WHERE id = $1`, [id]);
  }

  /** Counts rows created per day for a table, used by the dashboard charts. */
  async countByDay(
    table:
      | 'moderation_cases'
      | 'security_events'
      | 'command_usage'
      | 'tickets'
      | 'suggestions'
      | 'economy_transactions',
    guildId: string,
    days = 14,
  ): Promise<{ day: string; count: number }[]> {
    const allowed = new Set([
      'moderation_cases',
      'security_events',
      'command_usage',
      'tickets',
      'suggestions',
      'economy_transactions',
    ]);
    if (!allowed.has(table)) throw new Error(`unsupported table ${table}`);
    const { rows } = await this.db.query<{ day: string; count: number }>(
      `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*)::int AS count
         FROM ${table}
        WHERE guild_id = $1 AND created_at > now() - ($2::int * interval '1 day')
        GROUP BY 1 ORDER BY 1`,
      [guildId, days],
    );
    return rows;
  }
}
