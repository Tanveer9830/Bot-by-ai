import type { Database, Queryable } from '../pool.js';
import { GuildRepository } from './guilds.js';

export interface TicketRow {
  id: number;
  guild_id: string;
  ticket_number: number;
  channel_id: string;
  user_id: string;
  category_key: string;
  subject: string | null;
  status: 'open' | 'claimed' | 'closed';
  priority: string;
  claimed_by: string | null;
  closed_by: string | null;
  close_reason: string | null;
  transcript: unknown;
  rating: number | null;
  rating_comment: string | null;
  last_activity_at: Date;
  created_at: Date;
  closed_at: Date | null;
}

export class TicketRepository {
  private readonly guilds: GuildRepository;

  constructor(private readonly db: Database) {
    this.guilds = new GuildRepository(db);
  }

  async create(input: {
    guildId: string;
    userId: string;
    channelId: string;
    categoryKey: string;
    subject?: string | null;
  }): Promise<TicketRow> {
    return this.db.transaction(async (client) => {
      const number = await this.guilds.nextCounter(
        input.guildId,
        'ticket',
        client as unknown as Queryable,
      );
      const { rows } = await client.query<TicketRow>(
        `INSERT INTO tickets (guild_id, ticket_number, channel_id, user_id, category_key, subject)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [
          input.guildId,
          number,
          input.channelId,
          input.userId,
          input.categoryKey,
          input.subject ?? null,
        ],
      );
      return rows[0] as TicketRow;
    });
  }

  async openCountForUser(guildId: string, userId: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tickets
        WHERE guild_id = $1 AND user_id = $2 AND status <> 'closed'`,
      [guildId, userId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async getByChannel(channelId: string): Promise<TicketRow | null> {
    const { rows } = await this.db.query<TicketRow>(
      `SELECT * FROM tickets WHERE channel_id = $1 AND status <> 'closed' ORDER BY created_at DESC LIMIT 1`,
      [channelId],
    );
    return rows[0] ?? null;
  }

  async getByNumber(guildId: string, ticketNumber: number): Promise<TicketRow | null> {
    const { rows } = await this.db.query<TicketRow>(
      'SELECT * FROM tickets WHERE guild_id = $1 AND ticket_number = $2',
      [guildId, ticketNumber],
    );
    return rows[0] ?? null;
  }

  async claim(guildId: string, ticketNumber: number, staffId: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE tickets SET status = 'claimed', claimed_by = $3, last_activity_at = now()
        WHERE guild_id = $1 AND ticket_number = $2 AND status = 'open'`,
      [guildId, ticketNumber, staffId],
    );
    return (rowCount ?? 0) > 0;
  }

  async close(input: {
    guildId: string;
    ticketNumber: number;
    closedBy: string;
    reason?: string | null;
    transcript?: unknown;
  }): Promise<TicketRow | null> {
    const { rows } = await this.db.query<TicketRow>(
      `UPDATE tickets
          SET status = 'closed', closed_by = $3, close_reason = $4, closed_at = now(),
              transcript = COALESCE($5::jsonb, transcript)
        WHERE guild_id = $1 AND ticket_number = $2 AND status <> 'closed'
        RETURNING *`,
      [
        input.guildId,
        input.ticketNumber,
        input.closedBy,
        input.reason ?? null,
        input.transcript === undefined ? null : JSON.stringify(input.transcript),
      ],
    );
    return rows[0] ?? null;
  }

  async reopen(guildId: string, ticketNumber: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE tickets SET status = 'open', closed_at = NULL, closed_by = NULL, last_activity_at = now()
        WHERE guild_id = $1 AND ticket_number = $2 AND status = 'closed'`,
      [guildId, ticketNumber],
    );
    return (rowCount ?? 0) > 0;
  }

  async rate(input: {
    guildId: string;
    ticketNumber: number;
    userId: string;
    rating: number;
    comment?: string | null;
  }): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE tickets SET rating = $4, rating_comment = $5
        WHERE guild_id = $1 AND ticket_number = $2 AND user_id = $3 AND status = 'closed'`,
      [input.guildId, input.ticketNumber, input.userId, input.rating, input.comment ?? null],
    );
    return (rowCount ?? 0) > 0;
  }

  async list(
    guildId: string,
    options: { status?: string; userId?: string; limit?: number; offset?: number } = {},
  ): Promise<{ rows: TicketRow[]; total: number }> {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const offset = Math.max(options.offset ?? 0, 0);
    const params: unknown[] = [guildId];
    const filters = ['guild_id = $1'];
    if (options.status) {
      params.push(options.status);
      filters.push(`status = $${params.length}`);
    }
    if (options.userId) {
      params.push(options.userId);
      filters.push(`user_id = $${params.length}`);
    }
    const { rows } = await this.db.query<TicketRow & { total: number }>(
      `SELECT *, count(*) OVER()::int AS total FROM tickets WHERE ${filters.join(' AND ')}
        ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    return { rows, total: Number(rows[0]?.total ?? 0) };
  }

  /** Tickets with no activity for longer than the configured window. */
  async staleOpenTickets(hours: number, limit = 25): Promise<TicketRow[]> {
    const { rows } = await this.db.query<TicketRow>(
      `SELECT * FROM tickets
        WHERE status <> 'closed' AND last_activity_at < now() - ($1::int * interval '1 hour')
        ORDER BY last_activity_at ASC LIMIT $2`,
      [hours, limit],
    );
    return rows;
  }

  async touch(channelId: string): Promise<void> {
    await this.db.query(
      `UPDATE tickets SET last_activity_at = now() WHERE channel_id = $1 AND status <> 'closed'`,
      [channelId],
    );
  }

  /** Appends a transcript line. Only called when transcripts are enabled. */
  async appendTranscriptLine(input: {
    ticketId: number;
    authorId: string;
    authorTag?: string | null;
    content?: string | null;
    attachments?: unknown;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO ticket_messages (ticket_id, author_id, author_tag, content, attachments)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [
        input.ticketId,
        input.authorId,
        input.authorTag ?? null,
        input.content ? input.content.slice(0, 4000) : null,
        input.attachments === undefined ? null : JSON.stringify(input.attachments),
      ],
    );
  }

  async getTranscript(
    ticketId: number,
    limit = 2000,
  ): Promise<
    { author_id: string; author_tag: string | null; content: string | null; created_at: Date }[]
  > {
    const { rows } = await this.db.query(
      `SELECT author_id, author_tag, content, created_at FROM ticket_messages
        WHERE ticket_id = $1 ORDER BY created_at ASC LIMIT $2`,
      [ticketId, Math.min(Math.max(limit, 1), 5000)],
    );
    return rows as never;
  }

  async stats(
    guildId: string,
  ): Promise<{ open: number; claimed: number; closed: number; avgRating: number | null }> {
    const { rows } = await this.db.query<{
      open: string;
      claimed: string;
      closed: string;
      avg_rating: string | null;
    }>(
      `SELECT
         count(*) FILTER (WHERE status = 'open')::text AS open,
         count(*) FILTER (WHERE status = 'claimed')::text AS claimed,
         count(*) FILTER (WHERE status = 'closed')::text AS closed,
         avg(rating)::text AS avg_rating
       FROM tickets WHERE guild_id = $1`,
      [guildId],
    );
    const row = rows[0];
    return {
      open: Number(row?.open ?? 0),
      claimed: Number(row?.claimed ?? 0),
      closed: Number(row?.closed ?? 0),
      avgRating: row?.avg_rating ? Number(row.avg_rating) : null,
    };
  }
}
