import type { Database } from '../pool.js';
import { BusinessError } from '@bot-by-ai/shared';

export interface GiveawayRow {
  id: number;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  host_id: string;
  prize: string;
  winners_count: number;
  required_role_id: string | null;
  bonus_role_ids: string[];
  winner_ids: string[];
  ends_at: Date;
  ended: boolean;
  cancelled: boolean;
  created_at: Date;
  ended_at: Date | null;
}

export class CommunityRepository {
  constructor(private readonly db: Database) {}

  // ---------------------------------------------------------------- giveaways

  async createGiveaway(input: {
    guildId: string;
    channelId: string;
    hostId: string;
    prize: string;
    winnersCount: number;
    endsAt: Date;
    requiredRoleId?: string | null;
    bonusRoleIds?: string[];
  }): Promise<GiveawayRow> {
    const { rows } = await this.db.query<GiveawayRow>(
      `INSERT INTO giveaways (guild_id, channel_id, host_id, prize, winners_count, ends_at, required_role_id, bonus_role_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[]) RETURNING *`,
      [
        input.guildId,
        input.channelId,
        input.hostId,
        input.prize,
        input.winnersCount,
        input.endsAt,
        input.requiredRoleId ?? null,
        input.bonusRoleIds ?? [],
      ],
    );
    return rows[0] as GiveawayRow;
  }

  async setGiveawayMessage(id: number, messageId: string): Promise<void> {
    await this.db.query('UPDATE giveaways SET message_id = $2 WHERE id = $1', [id, messageId]);
  }

  async enterGiveaway(input: {
    giveawayId: number;
    userId: string;
    weight?: number;
    entries?: number;
  }): Promise<{ ok: boolean; reason?: string; entries: number }> {
    const { rowCount } = await this.db.query(
      `INSERT INTO giveaway_entries (giveaway_id, user_id, weight, entries)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (giveaway_id, user_id) DO NOTHING`,
      [input.giveawayId, input.userId, input.weight ?? 1, input.entries ?? 1],
    );
    const { rows } = await this.db.query<{ entries: number }>(
      'SELECT entries FROM giveaway_entries WHERE giveaway_id = $1 AND user_id = $2',
      [input.giveawayId, input.userId],
    );
    if ((rowCount ?? 0) === 0) {
      return { ok: false, reason: 'already_entered', entries: Number(rows[0]?.entries ?? 1) };
    }
    return { ok: true, entries: Number(rows[0]?.entries ?? 1) };
  }

  async leaveGiveaway(giveawayId: number, userId: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      'DELETE FROM giveaway_entries WHERE giveaway_id = $1 AND user_id = $2',
      [giveawayId, userId],
    );
    return (rowCount ?? 0) > 0;
  }

  async listEntries(giveawayId: number): Promise<{ user_id: string; entries: number; weight: number }[]> {
    const { rows } = await this.db.query<{ user_id: string; entries: number; weight: number }>(
      'SELECT user_id, entries, weight FROM giveaway_entries WHERE giveaway_id = $1',
      [giveawayId],
    );
    return rows;
  }

  async getGiveaway(id: number): Promise<GiveawayRow | null> {
    const { rows } = await this.db.query<GiveawayRow>('SELECT * FROM giveaways WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  async findGiveawayByMessage(messageId: string): Promise<GiveawayRow | null> {
    const { rows } = await this.db.query<GiveawayRow>('SELECT * FROM giveaways WHERE message_id = $1', [
      messageId,
    ]);
    return rows[0] ?? null;
  }

  /** Ends a giveaway exactly once, even if two workers race. */
  async endGiveaway(id: number, winnerIds: string[]): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE giveaways SET ended = TRUE, ended_at = now(), winner_ids = $2::text[]
        WHERE id = $1 AND ended = FALSE`,
      [id, winnerIds],
    );
    return (rowCount ?? 0) > 0;
  }

  async cancelGiveaway(id: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE giveaways SET cancelled = TRUE, ended = TRUE, ended_at = now()
        WHERE id = $1 AND ended = FALSE`,
      [id],
    );
    return (rowCount ?? 0) > 0;
  }

  async dueGiveaways(limit = 10): Promise<GiveawayRow[]> {
    const { rows } = await this.db.query<GiveawayRow>(
      `SELECT * FROM giveaways WHERE ended = FALSE AND cancelled = FALSE AND ends_at <= now()
        ORDER BY ends_at ASC LIMIT $1`,
      [limit],
    );
    return rows;
  }

  async listGiveaways(guildId: string, includeEnded = false, limit = 25): Promise<GiveawayRow[]> {
    const { rows } = await this.db.query<GiveawayRow>(
      `SELECT * FROM giveaways WHERE guild_id = $1 ${includeEnded ? '' : 'AND ended = FALSE AND cancelled = FALSE'}
        ORDER BY created_at DESC LIMIT $2`,
      [guildId, Math.min(Math.max(limit, 1), 100)],
    );
    return rows;
  }

  // --------------------------------------------------------------- suggestions

  async createSuggestion(input: {
    guildId: string;
    channelId: string;
    userId: string;
    content: string;
  }): Promise<number> {
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO suggestions (guild_id, channel_id, user_id, content) VALUES ($1,$2,$3,$4) RETURNING id`,
      [input.guildId, input.channelId, input.userId, input.content],
    );
    return Number(rows[0]?.id);
  }

  async setSuggestionMessage(id: number, messageId: string, threadId?: string | null): Promise<void> {
    await this.db.query('UPDATE suggestions SET message_id = $2, thread_id = COALESCE($3, thread_id) WHERE id = $1', [
      id,
      messageId,
      threadId ?? null,
    ]);
  }

  /** Records/replaces a vote and returns the fresh tallies. */
  async voteSuggestion(input: {
    suggestionId: number;
    userId: string;
    vote: 1 | -1;
  }): Promise<{ upvotes: number; downvotes: number }> {
    return this.db.transaction(async (client) => {
      await client.query(
        `INSERT INTO suggestion_votes (suggestion_id, user_id, vote) VALUES ($1,$2,$3)
         ON CONFLICT (suggestion_id, user_id) DO UPDATE SET vote = EXCLUDED.vote, created_at = now()`,
        [input.suggestionId, input.userId, input.vote],
      );
      const { rows } = await client.query<{ upvotes: string; downvotes: string }>(
        `SELECT count(*) FILTER (WHERE vote = 1)::text AS upvotes,
                count(*) FILTER (WHERE vote = -1)::text AS downvotes
           FROM suggestion_votes WHERE suggestion_id = $1`,
        [input.suggestionId],
      );
      const upvotes = Number(rows[0]?.upvotes ?? 0);
      const downvotes = Number(rows[0]?.downvotes ?? 0);
      await client.query('UPDATE suggestions SET upvotes = $2, downvotes = $3, updated_at = now() WHERE id = $1', [
        input.suggestionId,
        upvotes,
        downvotes,
      ]);
      return { upvotes, downvotes };
    });
  }

  async deleteSuggestionVote(suggestionId: number, userId: string): Promise<{ upvotes: number; downvotes: number }> {
    return this.db.transaction(async (client) => {
      await client.query('DELETE FROM suggestion_votes WHERE suggestion_id = $1 AND user_id = $2', [
        suggestionId,
        userId,
      ]);
      const { rows } = await client.query<{ upvotes: string; downvotes: string }>(
        `SELECT count(*) FILTER (WHERE vote = 1)::text AS upvotes,
                count(*) FILTER (WHERE vote = -1)::text AS downvotes
           FROM suggestion_votes WHERE suggestion_id = $1`,
        [suggestionId],
      );
      const upvotes = Number(rows[0]?.upvotes ?? 0);
      const downvotes = Number(rows[0]?.downvotes ?? 0);
      await client.query('UPDATE suggestions SET upvotes = $2, downvotes = $3, updated_at = now() WHERE id = $1', [
        suggestionId,
        upvotes,
        downvotes,
      ]);
      return { upvotes, downvotes };
    });
  }

  async getSuggestionByMessage(messageId: string): Promise<{ id: number; guild_id: string; status: string } | null> {
    const { rows } = await this.db.query<{ id: number; guild_id: string; status: string }>(
      'SELECT id, guild_id, status FROM suggestions WHERE message_id = $1',
      [messageId],
    );
    return rows[0] ?? null;
  }

  async updateSuggestionStatus(input: {
    guildId: string;
    suggestionId: number;
    status: string;
    staffResponse?: string | null;
  }): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE suggestions SET status = $3, staff_response = COALESCE($4, staff_response), updated_at = now()
        WHERE id = $1 AND guild_id = $2`,
      [input.suggestionId, input.guildId, input.status, input.staffResponse ?? null],
    );
    return (rowCount ?? 0) > 0;
  }

  async listSuggestions(
    guildId: string,
    options: { status?: string; limit?: number } = {},
  ): Promise<
    {
      id: number;
      user_id: string;
      content: string;
      status: string;
      upvotes: number;
      downvotes: number;
      created_at: Date;
    }[]
  > {
    const { rows } = await this.db.query(
      `SELECT id, user_id, content, status, upvotes, downvotes, created_at FROM suggestions
        WHERE guild_id = $1 ${options.status ? 'AND status = $3' : ''}
        ORDER BY created_at DESC LIMIT $2`,
      options.status ? [guildId, Math.min(options.limit ?? 20, 100), options.status] : [guildId, Math.min(options.limit ?? 20, 100)],
    );
    return rows as never;
  }

  // ----------------------------------------------------------- reaction roles

  async upsertReactionRolePanel(input: {
    guildId: string;
    panelKey: string;
    channelId: string;
    mode: 'reaction' | 'button' | 'select';
    options: unknown;
    exclusive: boolean;
    messageId?: string | null;
  }): Promise<number> {
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO reaction_role_panels (guild_id, panel_key, channel_id, message_id, mode, options, exclusive)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
       ON CONFLICT (guild_id, panel_key) DO UPDATE SET
         channel_id = EXCLUDED.channel_id,
         message_id = COALESCE(EXCLUDED.message_id, reaction_role_panels.message_id),
         mode = EXCLUDED.mode,
         options = EXCLUDED.options,
         exclusive = EXCLUDED.exclusive,
         enabled = TRUE
       RETURNING id`,
      [
        input.guildId,
        input.panelKey,
        input.channelId,
        input.messageId ?? null,
        input.mode,
        JSON.stringify(input.options),
        input.exclusive,
      ],
    );
    return Number(rows[0]?.id);
  }

  async findReactionRolePanelByMessage(
    messageId: string,
  ): Promise<{ id: number; guild_id: string; exclusive: boolean; options: unknown } | null> {
    const { rows } = await this.db.query<{
      id: number;
      guild_id: string;
      exclusive: boolean;
      options: unknown;
    }>('SELECT id, guild_id, exclusive, options FROM reaction_role_panels WHERE message_id = $1', [messageId]);
    return rows[0] ?? null;
  }

  async listReactionRolePanels(guildId: string): Promise<
    { id: number; panel_key: string; channel_id: string; message_id: string | null; mode: string; enabled: boolean }[]
  > {
    const { rows } = await this.db.query(
      `SELECT id, panel_key, channel_id, message_id, mode, enabled FROM reaction_role_panels
        WHERE guild_id = $1 ORDER BY created_at DESC`,
      [guildId],
    );
    return rows as never;
  }

  async deleteReactionRolePanel(guildId: string, panelKey: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      'DELETE FROM reaction_role_panels WHERE guild_id = $1 AND panel_key = $2',
      [guildId, panelKey],
    );
    return (rowCount ?? 0) > 0;
  }

  // ---------------------------------------------------------------- starboard

  async upsertStarboardEntry(input: {
    guildId: string;
    sourceMessageId: string;
    sourceChannelId: string;
    starboardChannelId: string;
    starboardMessageId?: string | null;
    starCount: number;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO starboard_entries
         (guild_id, source_message_id, source_channel_id, starboard_channel_id, starboard_message_id, star_count)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (guild_id, source_message_id) DO UPDATE SET
         star_count = EXCLUDED.star_count,
         starboard_message_id = COALESCE(EXCLUDED.starboard_message_id, starboard_entries.starboard_message_id)`,
      [
        input.guildId,
        input.sourceMessageId,
        input.sourceChannelId,
        input.starboardChannelId,
        input.starboardMessageId ?? null,
        input.starCount,
      ],
    );
  }

  async getStarboardEntry(
    guildId: string,
    sourceMessageId: string,
  ): Promise<{ starboard_message_id: string | null; star_count: number } | null> {
    const { rows } = await this.db.query<{ starboard_message_id: string | null; star_count: number }>(
      'SELECT starboard_message_id, star_count FROM starboard_entries WHERE guild_id = $1 AND source_message_id = $2',
      [guildId, sourceMessageId],
    );
    return rows[0] ?? null;
  }

  async deleteStarboardEntry(guildId: string, sourceMessageId: string): Promise<void> {
    await this.db.query('DELETE FROM starboard_entries WHERE guild_id = $1 AND source_message_id = $2', [
      guildId,
      sourceMessageId,
    ]);
  }

  // --------------------------------------------------------------- birthdays

  async setBirthday(input: {
    guildId: string;
    userId: string;
    month: number;
    day: number;
    year?: number | null;
  }): Promise<void> {
    const maxDay = new Date(Date.UTC(2024, input.month, 0)).getUTCDate();
    if (input.day < 1 || input.day > maxDay) {
      throw new BusinessError('INVALID_DATE', `Day ${input.day} is not valid for month ${input.month}.`);
    }
    await this.db.query(
      `INSERT INTO birthdays (guild_id, user_id, month, day, year) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET month = EXCLUDED.month, day = EXCLUDED.day, year = EXCLUDED.year`,
      [input.guildId, input.userId, input.month, input.day, input.year ?? null],
    );
  }

  async removeBirthday(guildId: string, userId: string): Promise<boolean> {
    const { rowCount } = await this.db.query('DELETE FROM birthdays WHERE guild_id = $1 AND user_id = $2', [
      guildId,
      userId,
    ]);
    return (rowCount ?? 0) > 0;
  }

  async birthdaysToday(
    month: number,
    day: number,
  ): Promise<{ guild_id: string; user_id: string; year: number | null }[]> {
    const { rows } = await this.db.query<{ guild_id: string; user_id: string; year: number | null }>(
      `SELECT guild_id, user_id, year FROM birthdays
        WHERE month = $1 AND day = $2
          AND (last_announced_year IS NULL OR last_announced_year <> $3)`,
      [month, day, new Date().getUTCFullYear()],
    );
    return rows;
  }

  async markBirthdayAnnounced(guildId: string, userId: string, year: number): Promise<void> {
    await this.db.query(
      'UPDATE birthdays SET last_announced_year = $3 WHERE guild_id = $1 AND user_id = $2',
      [guildId, userId, year],
    );
  }

  async upcomingBirthdays(
    guildId: string,
    limit = 10,
  ): Promise<{ user_id: string; month: number; day: number }[]> {
    const { rows } = await this.db.query<{ user_id: string; month: number; day: number }>(
      `SELECT user_id, month, day FROM birthdays WHERE guild_id = $1 ORDER BY month, day LIMIT $2`,
      [guildId, Math.min(Math.max(limit, 1), 50)],
    );
    return rows;
  }

  // ---------------------------------------------------------------- reminders

  async createReminder(input: {
    guildId: string | null;
    userId: string;
    channelId: string;
    content: string;
    remindAt: Date;
  }): Promise<number> {
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO reminders (guild_id, user_id, channel_id, content, remind_at) VALUES ($1,$2,$3,$4,$5)
       RETURNING id`,
      [input.guildId, input.userId, input.channelId, input.content, input.remindAt],
    );
    return Number(rows[0]?.id);
  }

  async dueReminders(limit = 25): Promise<
    { id: number; guild_id: string | null; user_id: string; channel_id: string; content: string }[]
  > {
    const { rows } = await this.db.query(
      `SELECT id, guild_id, user_id, channel_id, content FROM reminders
        WHERE status = 'pending' AND remind_at <= now() ORDER BY remind_at ASC LIMIT $1`,
      [limit],
    );
    return rows as never;
  }

  async markReminderDelivered(id: number): Promise<void> {
    await this.db.query(`UPDATE reminders SET status = 'delivered', delivered_at = now() WHERE id = $1`, [id]);
  }

  async listUserReminders(
    guildId: string,
    userId: string,
    limit = 20,
  ): Promise<{ id: number; content: string; remind_at: Date; status: string }[]> {
    const { rows } = await this.db.query(
      `SELECT id, content, remind_at, status FROM reminders
        WHERE guild_id = $1 AND user_id = $2 AND status = 'pending' ORDER BY remind_at ASC LIMIT $3`,
      [guildId, userId, Math.min(Math.max(limit, 1), 50)],
    );
    return rows as never;
  }

  async cancelReminder(guildId: string, userId: string, id: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE reminders SET status = 'cancelled' WHERE id = $1 AND guild_id = $2 AND user_id = $3 AND status = 'pending'`,
      [id, guildId, userId],
    );
    return (rowCount ?? 0) > 0;
  }
}
