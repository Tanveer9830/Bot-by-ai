import type { Database } from '../pool.js';
import { BusinessError } from '@bot-by-ai/shared';
import { levelFromXp } from '@bot-by-ai/shared';

export interface MemberLevelRow {
  guild_id: string;
  user_id: string;
  xp: number;
  level: number;
  messages: number;
  voice_minutes: number;
  last_xp_at: Date | null;
  updated_at: Date;
}

export interface AddXpResult {
  xp: number;
  previousXp: number;
  previousLevel: number;
  level: number;
  leveledUp: boolean;
  /** True when the per-user XP cooldown is still active (no XP granted). */
  throttled: boolean;
}

export class LevelRepository {
  constructor(private readonly db: Database) {}

  /** XP can only be granted when the row's `last_xp_at` is older than the cooldown. */
  async addXp(input: {
    guildId: string;
    userId: string;
    amount: number;
    cooldownMs: number;
    maxLevel?: number;
    countMessage?: boolean;
    voiceMinutes?: number;
  }): Promise<AddXpResult> {
    const amount = Math.max(0, Math.floor(input.amount));
    const maxLevel = input.maxLevel ?? 500;

    return this.db.transaction(async (client) => {
      const { rows: inserted } = await client.query<MemberLevelRow>(
        `INSERT INTO member_levels (guild_id, user_id, xp, level, messages, voice_minutes, last_xp_at)
         VALUES ($1,$2,$3,$4,$5,$6, now())
         ON CONFLICT (guild_id, user_id) DO NOTHING
         RETURNING *`,
        [input.guildId, input.userId, amount, levelFromXp(amount), input.countMessage ? 1 : 0, input.voiceMinutes ?? 0],
      );
      if (inserted[0]) {
        return {
          xp: inserted[0].xp,
          previousXp: 0,
          previousLevel: 0,
          level: inserted[0].level,
          leveledUp: inserted[0].level > 0,
          throttled: false,
        };
      }

      // Existing row: gate on the cooldown using a conditional UPDATE so two
      // concurrent messages cannot both earn XP inside the window.
      const { rows: updated } = await client.query<MemberLevelRow>(
        `UPDATE member_levels
            SET xp = xp + $3,
                messages = messages + $4,
                voice_minutes = voice_minutes + $5,
                last_xp_at = CASE WHEN $3 > 0 THEN now() ELSE last_xp_at END,
                updated_at = now()
          WHERE guild_id = $1 AND user_id = $2
            AND ($3 = 0 OR last_xp_at IS NULL
                 OR last_xp_at <= now() - ($6::bigint * interval '1 millisecond'))
          RETURNING *`,
        [
          input.guildId,
          input.userId,
          amount,
          input.countMessage ? 1 : 0,
          input.voiceMinutes ?? 0,
          Math.max(0, Math.floor(input.cooldownMs)),
        ],
      );

      if (!updated[0]) {
        // Throttled: still record the message/voice counters if requested.
        if (input.countMessage || input.voiceMinutes) {
          await client.query(
            `UPDATE member_levels
                SET messages = messages + $3, voice_minutes = voice_minutes + $4, updated_at = now()
              WHERE guild_id = $1 AND user_id = $2`,
            [input.guildId, input.userId, input.countMessage ? 1 : 0, input.voiceMinutes ?? 0],
          );
        }
        const { rows: current } = await client.query<MemberLevelRow>(
          'SELECT * FROM member_levels WHERE guild_id = $1 AND user_id = $2',
          [input.guildId, input.userId],
        );
        const row = current[0] as MemberLevelRow;
        return {
          xp: row.xp,
          previousXp: row.xp,
          previousLevel: row.level,
          level: row.level,
          leveledUp: false,
          throttled: true,
        };
      }

      const row = updated[0];
      const newLevel = Math.min(levelFromXp(row.xp), maxLevel);
      if (newLevel !== row.level) {
        await client.query(
          'UPDATE member_levels SET level = $3 WHERE guild_id = $1 AND user_id = $2',
          [input.guildId, input.userId, newLevel],
        );
      }
      const grew = newLevel > row.level;
      const grewFromZero = newLevel > 0 && row.level === 0;
      return {
        xp: row.xp,
        previousXp: grewFromZero ? row.xp - amount : row.xp,
        previousLevel: grewFromZero ? 0 : row.level,
        level: newLevel,
        leveledUp: grew || grewFromZero,
        throttled: false,
      };
    });
  }

  async getProfile(guildId: string, userId: string): Promise<MemberLevelRow | null> {
    const { rows } = await this.db.query<MemberLevelRow>(
      'SELECT * FROM member_levels WHERE guild_id = $1 AND user_id = $2',
      [guildId, userId],
    );
    return rows[0] ?? null;
  }

  /** XP gain is cooldown-gated, so an admin set always applies. */
  async setXp(input: { guildId: string; userId: string; xp: number; maxLevel?: number }): Promise<MemberLevelRow> {
    if (!Number.isInteger(input.xp) || input.xp < 0) {
      throw new BusinessError('INVALID_XP', 'XP must be a non-negative whole number.');
    }
    const level = Math.min(levelFromXp(input.xp), input.maxLevel ?? 500);
    const { rows } = await this.db.query<MemberLevelRow>(
      `INSERT INTO member_levels (guild_id, user_id, xp, level, updated_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (guild_id, user_id) DO UPDATE SET xp = $3, level = $4, updated_at = now()
       RETURNING *`,
      [input.guildId, input.userId, input.xp, level],
    );
    return rows[0] as MemberLevelRow;
  }

  async addXpAdmin(input: { guildId: string; userId: string; delta: number }): Promise<MemberLevelRow> {
    const profile = (await this.getProfile(input.guildId, input.userId)) ?? {
      xp: 0,
      level: 0,
    };
    return this.setXp({
      guildId: input.guildId,
      userId: input.userId,
      xp: Math.max(0, profile.xp + input.delta),
    });
  }

  async getLeaderboard(
    guildId: string,
    limit = 10,
  ): Promise<{ user_id: string; xp: number; level: number; messages: number; rank: number }[]> {
    const { rows } = await this.db.query<{
      user_id: string;
      xp: number;
      level: number;
      messages: number;
      rank: number;
    }>(
      `SELECT user_id, xp, level, messages, ROW_NUMBER() OVER (ORDER BY xp DESC)::int AS rank
         FROM member_levels WHERE guild_id = $1 ORDER BY xp DESC LIMIT $2`,
      [guildId, Math.min(Math.max(limit, 1), 100)],
    );
    return rows;
  }

  async getRank(guildId: string, userId: string): Promise<{ rank: number; xp: number; level: number } | null> {
    const { rows } = await this.db.query<{ rank: number; xp: number; level: number }>(
      `SELECT rank, xp, level FROM (
         SELECT user_id, xp, level, ROW_NUMBER() OVER (ORDER BY xp DESC)::int AS rank
           FROM member_levels WHERE guild_id = $1
       ) ranked WHERE user_id = $2`,
      [guildId, userId],
    );
    return rows[0] ?? null;
  }

  async guildLevelStats(guildId: string): Promise<{
    tracked: number;
    totalXp: number;
    avgLevel: number;
    activeToday: number;
  }> {
    const { rows } = await this.db.query<{
      tracked: string;
      total_xp: string;
      avg_level: string | null;
      active_today: string;
    }>(
      `SELECT count(*)::text AS tracked,
              COALESCE(sum(xp), 0)::text AS total_xp,
              avg(level)::text AS avg_level,
              count(*) FILTER (WHERE last_xp_at > now() - interval '1 day')::text AS active_today
         FROM member_levels WHERE guild_id = $1`,
      [guildId],
    );
    const row = rows[0];
    return {
      tracked: Number(row?.tracked ?? 0),
      totalXp: Number(row?.total_xp ?? 0),
      avgLevel: row?.avg_level ? Number(Number(row.avg_level).toFixed(2)) : 0,
      activeToday: Number(row?.active_today ?? 0),
    };
  }
}
