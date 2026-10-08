import type { Database, Queryable } from '../pool.js';
import { GuildRepository } from './guilds.js';

export type ModerationAction =
  | 'ban'
  | 'unban'
  | 'softban'
  | 'kick'
  | 'timeout'
  | 'untimeout'
  | 'warn'
  | 'unwarn'
  | 'mute'
  | 'unmute'
  | 'note'
  | 'purge'
  | 'nickname'
  | 'role_add'
  | 'role_remove'
  | 'lock'
  | 'unlock'
  | 'slowmode';

export interface ModerationCase {
  id: number;
  guild_id: string;
  case_number: number;
  user_id: string;
  moderator_id: string;
  action: string;
  reason: string | null;
  duration_ms: number | null;
  expires_at: Date | null;
  status: string;
  evidence: unknown;
  source: string;
  appeal_status: string;
  created_at: Date;
  updated_at: Date;
  revoked_at: Date | null;
  revoked_by: string | null;
}

export interface CreateCaseInput {
  guildId: string;
  userId: string;
  moderatorId: string;
  action: ModerationAction;
  reason?: string | null;
  durationMs?: number | null;
  evidence?: unknown;
  source?: string;
}

export class ModerationRepository {
  private readonly guilds: GuildRepository;

  constructor(private readonly db: Database) {
    this.guilds = new GuildRepository(db);
  }

  /** Creates a case with a guild-unique, gap-free-ish case number (atomic). */
  async createCase(input: CreateCaseInput): Promise<ModerationCase> {
    return this.db.transaction(async (client) => {
      const caseNumber = await this.guilds.nextCounter(
        input.guildId,
        'moderation_case',
        client as unknown as Queryable,
      );
      const expiresAt =
        input.durationMs && input.durationMs > 0 ? new Date(Date.now() + input.durationMs) : null;
      const { rows } = await client.query<ModerationCase>(
        `INSERT INTO moderation_cases
           (guild_id, case_number, user_id, moderator_id, action, reason, duration_ms, expires_at, evidence, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
         RETURNING *`,
        [
          input.guildId,
          caseNumber,
          input.userId,
          input.moderatorId,
          input.action,
          input.reason ?? null,
          input.durationMs ?? null,
          expiresAt,
          input.evidence === undefined ? null : JSON.stringify(input.evidence),
          input.source ?? 'command',
        ],
      );
      return rows[0] as ModerationCase;
    });
  }

  async getCase(guildId: string, caseNumber: number): Promise<ModerationCase | null> {
    const { rows } = await this.db.query<ModerationCase>(
      'SELECT * FROM moderation_cases WHERE guild_id = $1 AND case_number = $2',
      [guildId, caseNumber],
    );
    return rows[0] ?? null;
  }

  async listCases(
    guildId: string,
    options: { userId?: string; action?: string; limit?: number; offset?: number } = {},
  ): Promise<{ rows: ModerationCase[]; total: number }> {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);
    const params: unknown[] = [guildId];
    const filters: string[] = ['guild_id = $1'];
    if (options.userId) {
      params.push(options.userId);
      filters.push(`user_id = $${params.length}`);
    }
    if (options.action) {
      params.push(options.action);
      filters.push(`action = $${params.length}`);
    }
    const where = filters.join(' AND ');
    const { rows } = await this.db.query<ModerationCase & { total: number }>(
      `SELECT *, count(*) OVER()::int AS total FROM moderation_cases
        WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    return { rows, total: Number(rows[0]?.total ?? 0) };
  }

  async revokeCase(guildId: string, caseNumber: number, revokedBy: string, reason?: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE moderation_cases
          SET status = 'revoked', revoked_at = now(), revoked_by = $3, updated_at = now(),
              reason = COALESCE($4, reason)
        WHERE guild_id = $1 AND case_number = $2 AND status <> 'revoked'`,
      [guildId, caseNumber, revokedBy, reason ?? null],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Marks expired cases (used by the scheduled-task worker). */
  async expireCases(limit = 200): Promise<number> {
    const { rowCount } = await this.db.query(
      `UPDATE moderation_cases SET status = 'expired', updated_at = now()
        WHERE id IN (
          SELECT id FROM moderation_cases
           WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < now()
           LIMIT $1
        )`,
      [limit],
    );
    return rowCount ?? 0;
  }

  // ------------------------------------------------------------------ warns

  async addWarning(input: {
    guildId: string;
    userId: string;
    moderatorId: string;
    reason: string;
    caseId?: number | null;
    weight?: number;
    expiresAt?: Date | null;
  }): Promise<{ id: number; active: boolean; created_at: Date }> {
    const { rows } = await this.db.query(
      `INSERT INTO warnings (guild_id, case_id, user_id, moderator_id, reason, weight, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, active, created_at`,
      [
        input.guildId,
        input.caseId ?? null,
        input.userId,
        input.moderatorId,
        input.reason,
        input.weight ?? 1,
        input.expiresAt ?? null,
      ],
    );
    return rows[0] as { id: number; active: boolean; created_at: Date };
  }

  async getActiveWarnings(guildId: string, userId: string, limit = 25): Promise<
    { id: number; reason: string; moderator_id: string; weight: number; created_at: Date }[]
  > {
    const { rows } = await this.db.query<{
      id: number;
      reason: string;
      moderator_id: string;
      weight: number;
      created_at: Date;
    }>(
      `SELECT id, reason, moderator_id, weight, created_at FROM warnings
        WHERE guild_id = $1 AND user_id = $2 AND active = TRUE
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY created_at DESC LIMIT $3`,
      [guildId, userId, limit],
    );
    return rows;
  }

  async countActiveWarnings(guildId: string, userId: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT COALESCE(sum(weight), 0)::text AS count FROM warnings
        WHERE guild_id = $1 AND user_id = $2 AND active = TRUE
          AND (expires_at IS NULL OR expires_at > now())`,
      [guildId, userId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** Clears a single warning; only the referenced warning can be removed. */
  async clearWarning(guildId: string, warningId: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      'UPDATE warnings SET active = FALSE WHERE id = $1 AND guild_id = $2 AND active = TRUE',
      [warningId, guildId],
    );
    return (rowCount ?? 0) > 0;
  }

  async clearAllWarnings(guildId: string, userId: string): Promise<number> {
    const { rowCount } = await this.db.query(
      'UPDATE warnings SET active = FALSE WHERE guild_id = $1 AND user_id = $2 AND active = TRUE',
      [guildId, userId],
    );
    return rowCount ?? 0;
  }

  // ----------------------------------------------------------------- appeals

  async createAppeal(input: { guildId: string; caseId: number; userId: string; message: string }): Promise<number> {
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO moderation_appeals (guild_id, case_id, user_id, message)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [input.guildId, input.caseId, input.userId, input.message],
    );
    await this.db.query(`UPDATE moderation_cases SET appeal_status = 'pending' WHERE id = $1`, [input.caseId]);
    return Number(rows[0]?.id);
  }

  async listAppeals(guildId: string, status = 'pending', limit = 25): Promise<
    {
      id: number;
      case_id: number | null;
      user_id: string;
      message: string;
      status: string;
      created_at: Date;
      case_number: number | null;
      action: string | null;
    }[]
  > {
    const { rows } = await this.db.query(
      `SELECT a.id, a.case_id, a.user_id, a.message, a.status, a.created_at,
              c.case_number, c.action
         FROM moderation_appeals a
         LEFT JOIN moderation_cases c ON c.id = a.case_id
        WHERE a.guild_id = $1 AND a.status = $2
        ORDER BY a.created_at ASC LIMIT $3`,
      [guildId, status, limit],
    );
    return rows as never;
  }

  async reviewAppeal(input: {
    guildId: string;
    appealId: number;
    reviewerId: string;
    decision: 'approved' | 'denied';
    note?: string;
  }): Promise<boolean> {
    return this.db.transaction(async (client) => {
      const { rows } = await client.query<{ case_id: number | null }>(
        `UPDATE moderation_appeals
            SET status = $3, reviewed_by = $4, reviewed_at = now(), review_note = $5
          WHERE id = $1 AND guild_id = $2 AND status = 'pending'
          RETURNING case_id`,
        [input.appealId, input.guildId, input.decision, input.reviewerId, input.note ?? null],
      );
      const caseId = rows[0]?.case_id;
      if (caseId === null || caseId === undefined) return false;
      await client.query(
        `UPDATE moderation_cases SET appeal_status = $2, updated_at = now() WHERE id = $1`,
        [caseId, input.decision === 'approved' ? 'approved' : 'denied'],
      );
      return true;
    });
  }
}
