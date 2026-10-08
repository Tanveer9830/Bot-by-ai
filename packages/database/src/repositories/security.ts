import type { Database } from '../pool.js';

export interface SecurityEventRow {
  id: number;
  guild_id: string;
  kind: string;
  severity: number;
  actor_id: string | null;
  target_id: string | null;
  description: string;
  metadata: unknown;
  handled: boolean;
  created_at: Date;
}

export class SecurityRepository {
  constructor(private readonly db: Database) {}

  async logEvent(input: {
    guildId: string;
    kind: string;
    severity?: 1 | 2 | 3;
    actorId?: string | null;
    targetId?: string | null;
    description: string;
    metadata?: unknown;
  }): Promise<number> {
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO security_events (guild_id, kind, severity, actor_id, target_id, description, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING id`,
      [
        input.guildId,
        input.kind,
        input.severity ?? 1,
        input.actorId ?? null,
        input.targetId ?? null,
        input.description,
        input.metadata === undefined ? null : JSON.stringify(input.metadata),
      ],
    );
    return Number(rows[0]?.id);
  }

  /**
   * Counts recent events of a kind for an actor — the core of anti-nuke
   * threshold detection. Runs in a single statement so concurrent gateway
   * events cannot race past the threshold.
   */
  async countRecentEvents(input: {
    guildId: string;
    kind: string;
    actorId?: string | null;
    windowMs: number;
  }): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM security_events
        WHERE guild_id = $1 AND kind = $2
          AND ($3::text IS NULL OR actor_id = $3)
          AND created_at > now() - ($4::int * interval '1 millisecond')`,
      [input.guildId, input.kind, input.actorId ?? null, Math.round(input.windowMs)],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async listEvents(
    guildId: string,
    options: { kinds?: string[]; minSeverity?: number; limit?: number; offset?: number } = {},
  ): Promise<{ rows: SecurityEventRow[]; total: number }> {
    const limit = Math.min(Math.max(options.limit ?? 25, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);
    const params: unknown[] = [guildId];
    const filters = ['guild_id = $1'];
    if (options.kinds && options.kinds.length > 0) {
      params.push(options.kinds);
      filters.push(`kind = ANY($${params.length}::text[])`);
    }
    if (options.minSeverity) {
      params.push(options.minSeverity);
      filters.push(`severity >= $${params.length}`);
    }
    const { rows } = await this.db.query<SecurityEventRow & { total: number }>(
      `SELECT *, count(*) OVER()::int AS total FROM security_events
        WHERE ${filters.join(' AND ')}
        ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    return { rows, total: Number(rows[0]?.total ?? 0) };
  }

  async markHandled(guildId: string, eventId: number, handled = true): Promise<boolean> {
    const { rowCount } = await this.db.query(
      'UPDATE security_events SET handled = $3 WHERE id = $1 AND guild_id = $2',
      [eventId, guildId, handled],
    );
    return (rowCount ?? 0) > 0;
  }

  async countOpenAlerts(guildId: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM security_events
        WHERE guild_id = $1 AND handled = FALSE AND severity >= 2`,
      [guildId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  // ------------------------------------------------- trusted entities (whitelist)

  async addTrusted(input: {
    guildId: string;
    entityType: 'user' | 'role' | 'channel';
    entityId: string;
    addedBy: string;
    note?: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO trusted_entities (guild_id, entity_type, entity_id, added_by, note)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (guild_id, entity_type, entity_id) DO UPDATE SET note = EXCLUDED.note`,
      [input.guildId, input.entityType, input.entityId, input.addedBy, input.note ?? null],
    );
  }

  async removeTrusted(guildId: string, entityType: string, entityId: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      'DELETE FROM trusted_entities WHERE guild_id = $1 AND entity_type = $2 AND entity_id = $3',
      [guildId, entityType, entityId],
    );
    return (rowCount ?? 0) > 0;
  }

  async listTrusted(guildId: string): Promise<
    { entity_type: string; entity_id: string; note: string | null; added_by: string | null; created_at: Date }[]
  > {
    const { rows } = await this.db.query(
      `SELECT entity_type, entity_id, note, added_by, created_at FROM trusted_entities
        WHERE guild_id = $1 ORDER BY entity_type, created_at DESC`,
      [guildId],
    );
    return rows as never;
  }

  async isTrusted(guildId: string, entityType: 'user' | 'role' | 'channel', entityId: string): Promise<boolean> {
    const { rows } = await this.db.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM trusted_entities WHERE guild_id = $1 AND entity_type = $2 AND entity_id = $3
       ) AS exists`,
      [guildId, entityType, entityId],
    );
    return rows[0]?.exists ?? false;
  }

  // -------------------------------------------------- automod violations

  async recordAutomodViolation(input: {
    guildId: string;
    userId: string;
    channelId?: string | null;
    messageId?: string | null;
    kinds: string[];
    details?: unknown;
    actionTaken?: string | null;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO automod_violations (guild_id, user_id, channel_id, message_id, kinds, details, action_taken)
       VALUES ($1,$2,$3,$4,$5::text[],$6::jsonb,$7)`,
      [
        input.guildId,
        input.userId,
        input.channelId ?? null,
        input.messageId ?? null,
        input.kinds,
        input.details === undefined ? null : JSON.stringify(input.details),
        input.actionTaken ?? null,
      ],
    );
  }

  async countRecentAutomodViolations(guildId: string, userId: string, windowMs: number): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM automod_violations
        WHERE guild_id = $1 AND user_id = $2
          AND created_at > now() - ($3::int * interval '1 millisecond')`,
      [guildId, userId, Math.round(windowMs)],
    );
    return Number(rows[0]?.count ?? 0);
  }

  // ------------------------------------------------------ no-tag / no-pin

  async recordNoTagViolation(input: {
    guildId: string;
    userId: string;
    channelId?: string | null;
    messageId?: string | null;
    protectedUserIds: string[];
    action: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO notag_violations (guild_id, user_id, channel_id, message_id, protected_user_ids, action)
       VALUES ($1,$2,$3,$4,$5::text[],$6)`,
      [
        input.guildId,
        input.userId,
        input.channelId ?? null,
        input.messageId ?? null,
        input.protectedUserIds,
        input.action,
      ],
    );
  }

  async recordNoPinEvent(input: {
    guildId: string;
    channelId: string;
    messageId?: string | null;
    action: 'pin' | 'unpin';
    actorId?: string | null;
    messageAuthorId?: string | null;
    outcome: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO nopin_events (guild_id, channel_id, message_id, action, actor_id, message_author_id, outcome)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        input.guildId,
        input.channelId,
        input.messageId ?? null,
        input.action,
        input.actorId ?? null,
        input.messageAuthorId ?? null,
        input.outcome,
      ],
    );
  }
}
