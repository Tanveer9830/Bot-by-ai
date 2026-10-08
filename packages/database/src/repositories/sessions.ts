import { createHash, randomUUID } from 'node:crypto';
import type { Database } from '../pool.js';

export interface SessionRow {
  id: string;
  user_id: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  /** Dashboard-only profile cache (see migration 0002). */
  username?: string | null;
  global_name?: string | null;
  avatar?: string | null;
  user_guild_ids?: unknown;
}

/** Only the hash of the token is persisted — a database leak cannot mint sessions. */
export function hashSessionToken(token: string, pepper: string): string {
  return createHash('sha256').update(`${pepper}:${token}`).digest('hex');
}

export class SessionRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    userAgent?: string | null;
    ipHash?: string | null;
    username?: string | null;
    globalName?: string | null;
    avatar?: string | null;
    userGuildIds?: readonly string[];
  }): Promise<string> {
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO dashboard_sessions
         (id, user_id, token_hash, expires_at, user_agent, ip_hash, username, global_name, avatar, user_guild_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [
        id,
        input.userId,
        input.tokenHash,
        input.expiresAt,
        input.userAgent ?? null,
        input.ipHash ?? null,
        input.username ?? null,
        input.globalName ?? null,
        input.avatar ?? null,
        JSON.stringify(input.userGuildIds ?? []),
      ],
    );
    return id;
  }

  /** Backwards-compatible name used by the bot code paths. */
  async findValid(tokenHash: string): Promise<SessionRow | null> {
    return this.findActiveByTokenHash(tokenHash);
  }

  async findActiveByTokenHash(tokenHash: string): Promise<SessionRow | null> {
    const { rows } = await this.db.query<SessionRow>(
      `SELECT * FROM dashboard_sessions
        WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [tokenHash],
    );
    return rows[0] ?? null;
  }

  async revokeByTokenHash(tokenHash: string): Promise<boolean> {
    return this.revoke(tokenHash);
  }

  async countActive(): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM dashboard_sessions
        WHERE revoked_at IS NULL AND expires_at > now()`,
    );
    return Number(rows[0]?.count ?? 0);
  }

  async touch(id: string): Promise<void> {
    await this.db.query('UPDATE dashboard_sessions SET last_seen_at = now() WHERE id = $1', [id]);
  }

  async revoke(tokenHash: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE dashboard_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash],
    );
    return (rowCount ?? 0) > 0;
  }

  async revokeAllForUser(userId: string, exceptTokenHash?: string): Promise<number> {
    const { rowCount } = await this.db.query(
      `UPDATE dashboard_sessions SET revoked_at = now()
        WHERE user_id = $1 AND revoked_at IS NULL AND ($2::text IS NULL OR token_hash <> $2)`,
      [userId, exceptTokenHash ?? null],
    );
    return rowCount ?? 0;
  }

  async listForUser(userId: string): Promise<SessionRow[]> {
    const { rows } = await this.db.query<SessionRow>(
      `SELECT id, user_id, created_at, last_seen_at, expires_at, revoked_at FROM dashboard_sessions
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
        ORDER BY last_seen_at DESC`,
      [userId],
    );
    return rows;
  }

  async cleanup(): Promise<number> {
    const { rowCount } = await this.db.query(
      `DELETE FROM dashboard_sessions WHERE expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days'`,
    );
    return rowCount ?? 0;
  }
}
