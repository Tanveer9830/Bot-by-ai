import type { Database } from '../pool.js';

export interface UserRow {
  id: string;
  username: string;
  global_name: string | null;
  discriminator: string | null;
  avatar: string | null;
  is_bot: boolean;
  locale: string | null;
  created_at: Date;
  updated_at: Date;
}

export class UserRepository {
  constructor(private readonly db: Database) {}

  async upsertUser(input: {
    id: string;
    username?: string;
    globalName?: string | null;
    discriminator?: string | null;
    avatar?: string | null;
    isBot?: boolean;
    locale?: string | null;
  }): Promise<UserRow> {
    const { rows } = await this.db.query<UserRow>(
      `INSERT INTO users (id, username, global_name, discriminator, avatar, is_bot, locale)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         username = COALESCE(EXCLUDED.username, users.username),
         global_name = COALESCE(EXCLUDED.global_name, users.global_name),
         discriminator = COALESCE(EXCLUDED.discriminator, users.discriminator),
         avatar = COALESCE(EXCLUDED.avatar, users.avatar),
         locale = COALESCE(EXCLUDED.locale, users.locale),
         updated_at = now()
       RETURNING *`,
      [
        input.id,
        input.username ?? 'unknown',
        input.globalName ?? null,
        input.discriminator ?? null,
        input.avatar ?? null,
        input.isBot ?? false,
        input.locale ?? null,
      ],
    );
    return rows[0] as UserRow;
  }

  async getUser(userId: string): Promise<UserRow | null> {
    const { rows } = await this.db.query<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
    return rows[0] ?? null;
  }

  async countUsers(): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>('SELECT count(*)::text AS count FROM users');
    return Number(rows[0]?.count ?? 0);
  }
}
