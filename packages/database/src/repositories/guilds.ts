import type { Database, Queryable } from '../pool.js';
import type { ModuleName } from '@bot-by-ai/shared';
import { MODULE_SCHEMAS, moduleDefaults } from '@bot-by-ai/shared';

export interface GuildRow {
  id: string;
  name: string;
  icon: string | null;
  owner_id: string | null;
  member_count: number;
  features: string[];
  joined_at: Date | null;
  left_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface SettingsChangeContext {
  actorId: string | null;
  source: 'dashboard' | 'command' | 'system' | 'custom_command';
}

export class GuildRepository {
  constructor(private readonly db: Database) {}

  async ensureGuild(input: {
    id: string;
    name?: string;
    icon?: string | null;
    ownerId?: string | null;
    memberCount?: number;
  }): Promise<GuildRow> {
    const { rows } = await this.db.query<GuildRow>(
      `INSERT INTO guilds (id, name, icon, owner_id, member_count, joined_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (id) DO UPDATE SET
         name = COALESCE(EXCLUDED.name, guilds.name),
         icon = COALESCE(EXCLUDED.icon, guilds.icon),
         owner_id = COALESCE(EXCLUDED.owner_id, guilds.owner_id),
         member_count = GREATEST(EXCLUDED.member_count, guilds.member_count),
         left_at = NULL,
         updated_at = now()
       RETURNING *`,
      [
        input.id,
        input.name ?? 'unknown',
        input.icon ?? null,
        input.ownerId ?? null,
        input.memberCount ?? 0,
      ],
    );
    return rows[0] as GuildRow;
  }

  async markLeft(guildId: string): Promise<void> {
    await this.db.query('UPDATE guilds SET left_at = now(), updated_at = now() WHERE id = $1', [
      guildId,
    ]);
  }

  async getGuild(guildId: string): Promise<GuildRow | null> {
    const { rows } = await this.db.query<GuildRow>('SELECT * FROM guilds WHERE id = $1', [guildId]);
    return rows[0] ?? null;
  }

  async listGuildsForIds(ids: readonly string[]): Promise<GuildRow[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.db.query<GuildRow>(
      'SELECT * FROM guilds WHERE id = ANY($1::text[])',
      [ids as unknown as string[]],
    );
    return rows;
  }

  async updateGuildStats(guildId: string, memberCount: number, name?: string): Promise<void> {
    await this.db.query(
      `UPDATE guilds SET member_count = $2, name = COALESCE($3, name), updated_at = now() WHERE id = $1`,
      [guildId, memberCount, name ?? null],
    );
  }

  /** Reads a settings module, falling back to schema defaults when absent. */
  async getModuleSettings<T extends Record<string, unknown>>(
    guildId: string,
    module: ModuleName,
  ): Promise<T> {
    const { rows } = await this.db.query<{ modules: Record<string, unknown> }>(
      'SELECT modules FROM guild_settings WHERE guild_id = $1',
      [guildId],
    );
    const stored = (rows[0]?.modules ?? {}) as Record<string, unknown>;
    const values = (stored[module] ?? {}) as Record<string, unknown>;
    const parsed = MODULE_SCHEMAS[module].safeParse(values);
    const defaults = moduleDefaults(module);
    return (
      parsed.success ? { ...defaults, ...(parsed.data as Record<string, unknown>) } : defaults
    ) as T;
  }

  async getAllModuleSettings(guildId: string): Promise<Record<string, Record<string, unknown>>> {
    const { rows } = await this.db.query<{ modules: Record<string, unknown> }>(
      'SELECT modules FROM guild_settings WHERE guild_id = $1',
      [guildId],
    );
    const stored = (rows[0]?.modules ?? {}) as Record<string, Record<string, unknown>>;
    const out: Record<string, Record<string, unknown>> = {};
    for (const module of Object.keys(MODULE_SCHEMAS) as ModuleName[]) {
      const parsed = MODULE_SCHEMAS[module].safeParse(stored[module] ?? {});
      out[module] = {
        ...moduleDefaults(module),
        ...(parsed.success ? (parsed.data as object) : {}),
      };
    }
    return out;
  }

  /**
   * Deep-merges a validated patch into the module and records the previous value
   * in `guild_settings_history` for auditing inside a single transaction.
   */
  async patchModuleSettings(
    guildId: string,
    module: ModuleName,
    patch: Record<string, unknown>,
    context: SettingsChangeContext,
  ): Promise<Record<string, unknown>> {
    return this.db.transaction(async (client) => {
      const { rows } = await client.query<{ modules: Record<string, unknown>; version: number }>(
        `INSERT INTO guild_settings (guild_id, modules) VALUES ($1, '{}'::jsonb)
         ON CONFLICT (guild_id) DO UPDATE SET updated_at = guild_settings.updated_at
         RETURNING modules, version`,
        [guildId],
      );
      const current = (rows[0]?.modules ?? {}) as Record<string, unknown>;
      const previous = (current[module] ?? {}) as Record<string, unknown>;
      const merged = { ...previous, ...patch };
      const parsed = MODULE_SCHEMAS[module].safeParse(merged);
      if (!parsed.success) {
        throw new Error(
          `invalid ${module} settings: ${parsed.error.issues
            .map(
              (issue: { path: (string | number)[]; message: string }) =>
                `${issue.path.join('.')} ${issue.message}`,
            )
            .join('; ')}`,
        );
      }
      const next = { ...current, [module]: parsed.data };
      await client.query(
        `UPDATE guild_settings
            SET modules = $2::jsonb, version = version + 1, updated_by = $3, updated_at = now()
          WHERE guild_id = $1`,
        [guildId, JSON.stringify(next), context.actorId],
      );
      await client.query(
        `INSERT INTO guild_settings_history (guild_id, module, changed_by, source, old_values, new_values)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
        [
          guildId,
          module,
          context.actorId,
          context.source,
          JSON.stringify(previous),
          JSON.stringify(parsed.data),
        ],
      );
      return parsed.data as Record<string, unknown>;
    });
  }

  async getSettingsHistory(
    guildId: string,
    limit = 50,
  ): Promise<
    {
      id: number;
      module: string;
      changed_by: string | null;
      source: string;
      changed_at: Date;
      old_values: unknown;
      new_values: unknown;
    }[]
  > {
    const { rows } = await this.db.query<{
      id: number;
      module: string;
      changed_by: string | null;
      source: string;
      changed_at: Date;
      old_values: unknown;
      new_values: unknown;
    }>(
      `SELECT id, module, changed_by, source, changed_at, old_values, new_values
         FROM guild_settings_history WHERE guild_id = $1
        ORDER BY changed_at DESC LIMIT $2`,
      [guildId, Math.min(Math.max(limit, 1), 200)],
    );
    return rows;
  }

  /**
   * Atomic per-guild counter (moderation case numbers, ticket numbers).
   * Uses an UPSERT so concurrent callers can never receive the same number.
   */
  async nextCounter(guildId: string, name: string, client?: Queryable): Promise<number> {
    const runner: Queryable = client ?? this.db;
    const { rows } = await runner.query<{ value: number }>(
      `INSERT INTO counters (guild_id, name, value) VALUES ($1, $2, 1)
       ON CONFLICT (guild_id, name) DO UPDATE SET value = counters.value + 1
       RETURNING value`,
      [guildId, name],
    );
    return Number(rows[0]?.value ?? 1);
  }
}
