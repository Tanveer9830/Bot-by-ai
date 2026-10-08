import type { Database } from '../pool.js';

export interface CustomCommandRow {
  id: number;
  scope: 'global' | 'guild';
  guild_id: string | null;
  name: string;
  description: string;
  payload: Record<string, unknown>;
  enabled: boolean;
  published: boolean;
  uses: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CustomCommandData {
  name: string;
  description: string;
  payload: Record<string, unknown>;
  enabled?: boolean;
  published?: boolean;
}

/**
 * Global commands (scope='global') are owner-only; guild commands are managed by
 * server admins. The repository deliberately exposes separate methods so an
 * authorization mistake in one path cannot silently affect the other scope.
 */
export class CustomCommandRepository {
  constructor(private readonly db: Database) {}

  // ------------------------------------------------------------------ global

  async upsertGlobal(input: CustomCommandData & { ownerId: string }): Promise<CustomCommandRow> {
    const { rows } = await this.db.query<CustomCommandRow>(
      `INSERT INTO custom_commands (scope, guild_id, name, description, payload, enabled, published, created_by, updated_by)
       VALUES ('global', NULL, $1, $2, $3::jsonb, $4, $5, $6, $6)
       ON CONFLICT (lower(name)) WHERE scope = 'global' DO UPDATE SET
         description = EXCLUDED.description,
         payload = EXCLUDED.payload,
         enabled = EXCLUDED.enabled,
         published = EXCLUDED.published,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       RETURNING *`,
      [
        input.name.toLowerCase(),
        input.description,
        JSON.stringify(input.payload),
        input.enabled ?? true,
        input.published ?? false,
        input.ownerId,
      ],
    );
    return rows[0] as CustomCommandRow;
  }

  async listGlobal(): Promise<CustomCommandRow[]> {
    const { rows } = await this.db.query<CustomCommandRow>(
      `SELECT * FROM custom_commands WHERE scope = 'global' ORDER BY name ASC`,
    );
    return rows;
  }

  async getGlobal(name: string): Promise<CustomCommandRow | null> {
    const { rows } = await this.db.query<CustomCommandRow>(
      `SELECT * FROM custom_commands WHERE scope = 'global' AND lower(name) = lower($1)`,
      [name],
    );
    return rows[0] ?? null;
  }

  /** Published + enabled global command, used by the runtime resolver. */
  async getGlobalPublished(name: string): Promise<CustomCommandRow | null> {
    const { rows } = await this.db.query<CustomCommandRow>(
      `SELECT * FROM custom_commands
        WHERE scope = 'global' AND published = TRUE AND enabled = TRUE AND lower(name) = lower($1)`,
      [name],
    );
    return rows[0] ?? null;
  }

  async deleteGlobal(name: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `DELETE FROM custom_commands WHERE scope = 'global' AND lower(name) = lower($1)`,
      [name],
    );
    return (rowCount ?? 0) > 0;
  }

  async setGlobalPublished(name: string, published: boolean, ownerId: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE custom_commands SET published = $2, updated_by = $3, updated_at = now()
        WHERE scope = 'global' AND lower(name) = lower($1)`,
      [name, published, ownerId],
    );
    return (rowCount ?? 0) > 0;
  }

  // ------------------------------------------------------------------- guild

  async upsertGuild(
    guildId: string,
    input: CustomCommandData & { actorId: string },
  ): Promise<CustomCommandRow> {
    const { rows } = await this.db.query<CustomCommandRow>(
      `INSERT INTO custom_commands (scope, guild_id, name, description, payload, enabled, published, created_by, updated_by)
       VALUES ('guild', $1, $2, $3, $4::jsonb, $5, TRUE, $6, $6)
       ON CONFLICT (guild_id, lower(name)) WHERE scope = 'guild' DO UPDATE SET
         description = EXCLUDED.description,
         payload = EXCLUDED.payload,
         enabled = EXCLUDED.enabled,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       RETURNING *`,
      [
        guildId,
        input.name.toLowerCase(),
        input.description,
        JSON.stringify(input.payload),
        input.enabled ?? true,
        input.actorId,
      ],
    );
    return rows[0] as CustomCommandRow;
  }

  async listGuild(guildId: string): Promise<CustomCommandRow[]> {
    const { rows } = await this.db.query<CustomCommandRow>(
      `SELECT * FROM custom_commands WHERE scope = 'guild' AND guild_id = $1 ORDER BY name ASC`,
      [guildId],
    );
    return rows;
  }

  async getGuild(guildId: string, name: string): Promise<CustomCommandRow | null> {
    const { rows } = await this.db.query<CustomCommandRow>(
      `SELECT * FROM custom_commands WHERE scope = 'guild' AND guild_id = $1 AND lower(name) = lower($2)`,
      [guildId, name],
    );
    return rows[0] ?? null;
  }

  async deleteGuild(guildId: string, name: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `DELETE FROM custom_commands WHERE scope = 'guild' AND guild_id = $1 AND lower(name) = lower($2)`,
      [guildId, name],
    );
    return (rowCount ?? 0) > 0;
  }

  // ------------------------------------------------------------------ shared

  async incrementUses(id: number): Promise<void> {
    await this.db.query('UPDATE custom_commands SET uses = uses + 1 WHERE id = $1', [id]);
  }

  /** Names are pre-loaded so slash commands can be registered from the DB. */
  async listNamesForRegistration(): Promise<{ name: string; description: string; scope: 'global' | 'guild'; guild_id: string | null }[]> {
    const { rows } = await this.db.query<{
      name: string;
      description: string;
      scope: 'global' | 'guild';
      guild_id: string | null;
    }>(
      `SELECT name, description, scope, guild_id FROM custom_commands
        WHERE enabled = TRUE AND (scope = 'guild' OR published = TRUE)
        ORDER BY scope, name`,
    );
    return rows;
  }
}
