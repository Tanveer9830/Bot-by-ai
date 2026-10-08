import type { Database, Queryable } from '../pool.js';
import { BusinessError } from '@bot-by-ai/shared';

export interface EconomyAccountRow {
  guild_id: string;
  user_id: string;
  wallet: number;
  bank: number;
  total_earned: number;
  total_spent: number;
  created_at: Date;
  updated_at: Date;
}

export interface TransferResult {
  amount: number;
  fee: number;
  senderWallet: number;
  recipientWallet: number;
  /** True when the idempotency key had already been used (no money moved). */
  replayed: boolean;
}

export type LedgerType =
  | 'daily'
  | 'weekly'
  | 'work'
  | 'transfer_out'
  | 'transfer_in'
  | 'purchase'
  | 'refund'
  | 'admin_adjust'
  | 'quest'
  | 'achievement'
  | 'gamble'
  | 'deposit'
  | 'withdraw';

export class EconomyRepository {
  constructor(private readonly db: Database) {}

  private async upsertAccount(
    client: Queryable,
    guildId: string,
    userId: string,
    starterBalance = 0,
  ): Promise<EconomyAccountRow> {
    const { rows } = await client.query<EconomyAccountRow>(
      `INSERT INTO economy_accounts (guild_id, user_id, wallet, total_earned)
       VALUES ($1,$2,$3,$3)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET updated_at = economy_accounts.updated_at
       RETURNING *`,
      [guildId, userId, Math.max(0, Math.floor(starterBalance))],
    );
    return rows[0] as EconomyAccountRow;
  }

  async ensureAccount(guildId: string, userId: string, starterBalance = 0): Promise<EconomyAccountRow> {
    return this.upsertAccount(this.db, guildId, userId, starterBalance);
  }

  async getAccount(guildId: string, userId: string): Promise<EconomyAccountRow | null> {
    const { rows } = await this.db.query<EconomyAccountRow>(
      'SELECT * FROM economy_accounts WHERE guild_id = $1 AND user_id = $2',
      [guildId, userId],
    );
    return rows[0] ?? null;
  }

  async getLeaderboard(
    guildId: string,
    limit = 10,
  ): Promise<{ user_id: string; wallet: number; bank: number; total: number; rank: number }[]> {
    const { rows } = await this.db.query<{
      user_id: string;
      wallet: number;
      bank: number;
      total: number;
      rank: number;
    }>(
      `SELECT user_id, wallet, bank, (wallet + bank) AS total,
              ROW_NUMBER() OVER (ORDER BY (wallet + bank) DESC)::int AS rank
         FROM economy_accounts WHERE guild_id = $1
        ORDER BY total DESC LIMIT $2`,
      [guildId, Math.min(Math.max(limit, 1), 100)],
    );
    return rows;
  }

  async getRank(guildId: string, userId: string): Promise<{ rank: number; total: number } | null> {
    const { rows } = await this.db.query<{ rank: number; total: number }>(
      `SELECT rank, total FROM (
         SELECT user_id, (wallet + bank) AS total,
                ROW_NUMBER() OVER (ORDER BY (wallet + bank) DESC)::int AS rank
           FROM economy_accounts WHERE guild_id = $1
       ) ranked WHERE user_id = $2`,
      [guildId, userId],
    );
    return rows[0] ?? null;
  }

  /**
   * Atomically claims a cooldown-gated action (daily, weekly, work, rob...).
   * Concurrent callers can only ever succeed once per window.
   */
  async claimCooldown(input: {
    guildId: string;
    userId: string;
    action: string;
    cooldownMs: number;
  }): Promise<{ granted: boolean; streak: number; retryAfterMs: number }> {
    const windowMs = Math.max(0, Math.floor(input.cooldownMs));
    const { rows } = await this.db.query<{ streak: number; last_used_at: Date }>(
      `INSERT INTO economy_cooldowns (guild_id, user_id, action, last_used_at, streak, uses)
       VALUES ($1,$2,$3, now(), 1, 1)
       ON CONFLICT (guild_id, user_id, action) DO UPDATE SET
         streak = CASE
           WHEN economy_cooldowns.last_used_at > now() - ($4::bigint * interval '1 millisecond')
             THEN economy_cooldowns.streak + 1
           ELSE 1
         END,
         last_used_at = now(),
         uses = economy_cooldowns.uses + 1
       WHERE economy_cooldowns.last_used_at <= now() - ($4::bigint * interval '1 millisecond')
       RETURNING streak, last_used_at`,
      [input.guildId, input.userId, input.action, windowMs],
    );
    if (rows[0]) {
      return { granted: true, streak: Number(rows[0].streak), retryAfterMs: 0 };
    }
    const { rows: existing } = await this.db.query<{ last_used_at: Date }>(
      `SELECT last_used_at FROM economy_cooldowns WHERE guild_id = $1 AND user_id = $2 AND action = $3`,
      [input.guildId, input.userId, input.action],
    );
    const last = existing[0]?.last_used_at?.getTime() ?? Date.now();
    return { granted: false, streak: 0, retryAfterMs: Math.max(0, last + windowMs - Date.now()) };
  }

  async getCooldown(
    guildId: string,
    userId: string,
    action: string,
  ): Promise<{ lastUsedAt: Date; streak: number; uses: number } | null> {
    const { rows } = await this.db.query<{ last_used_at: Date; streak: number; uses: number }>(
      `SELECT last_used_at, streak, uses FROM economy_cooldowns
        WHERE guild_id = $1 AND user_id = $2 AND action = $3`,
      [guildId, userId, action],
    );
    const row = rows[0];
    return row ? { lastUsedAt: row.last_used_at, streak: row.streak, uses: Number(row.uses) } : null;
  }

  /**
   * Credits or debits a wallet inside a transaction with row locking.
   * `idempotencyKey` makes reward grants safe to retry.
   */
  async adjustBalance(input: {
    guildId: string;
    userId: string;
    amount: number; // positive = credit, negative = debit
    type: LedgerType;
    actorId?: string | null;
    idempotencyKey?: string | null;
    metadata?: unknown;
    starterBalance?: number;
    allowNegative?: boolean;
  }): Promise<{ balance: number; replayed: boolean; transactionId: number }> {
    if (!Number.isInteger(input.amount) || input.amount === 0) {
      throw new BusinessError('INVALID_AMOUNT', 'Amount must be a non-zero whole number.');
    }
    return this.db.transaction(async (client) => {
      if (input.idempotencyKey) {
        const { rows: existing } = await client.query<{ id: number; balance_after: number | null }>(
          `SELECT id, balance_after FROM economy_transactions WHERE idempotency_key = $1`,
          [input.idempotencyKey],
        );
        if (existing[0]) {
          return {
            balance: Number(existing[0].balance_after ?? 0),
            replayed: true,
            transactionId: Number(existing[0].id),
          };
        }
      }

      await this.upsertAccount(client, input.guildId, input.userId, input.starterBalance ?? 0);
      const { rows: locked } = await client.query<EconomyAccountRow>(
        `SELECT * FROM economy_accounts WHERE guild_id = $1 AND user_id = $2 FOR UPDATE`,
        [input.guildId, input.userId],
      );
      const account = locked[0] as EconomyAccountRow;
      const next = account.wallet + input.amount;
      if (next < 0 && !input.allowNegative) {
        throw new BusinessError('INSUFFICIENT_FUNDS', `Insufficient balance: you have ${account.wallet}.`, {
          balance: account.wallet,
          requested: Math.abs(input.amount),
        });
      }
      const { rows: updated } = await client.query<EconomyAccountRow>(
        `UPDATE economy_accounts
            SET wallet = $3,
                total_earned = total_earned + GREATEST($4::bigint, 0),
                total_spent = total_spent + GREATEST(-$4::bigint, 0),
                updated_at = now()
          WHERE guild_id = $1 AND user_id = $2
          RETURNING *`,
        [input.guildId, input.userId, next, input.amount],
      );
      const { rows: txRows } = await client.query<{ id: number }>(
        `INSERT INTO economy_transactions
           (guild_id, user_id, actor_id, type, amount, fee, balance_after, idempotency_key, metadata)
         VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8::jsonb) RETURNING id`,
        [
          input.guildId,
          input.userId,
          input.actorId ?? null,
          input.type,
          input.amount,
          next,
          input.idempotencyKey ?? null,
          input.metadata === undefined ? null : JSON.stringify(input.metadata),
        ],
      );
      return {
        balance: (updated[0] as EconomyAccountRow).wallet,
        replayed: false,
        transactionId: Number(txRows[0]?.id),
      };
    });
  }

  /**
   * Player-to-player transfer. Locks both accounts in a deterministic order to
   * prevent deadlocks, burns the fee, and never creates currency.
   */
  async transfer(input: {
    guildId: string;
    fromUserId: string;
    toUserId: string;
    amount: number;
    feePercent?: number;
    maxFee?: number;
    idempotencyKey?: string | null;
    starterBalance?: number;
  }): Promise<TransferResult> {
    if (input.fromUserId === input.toUserId) {
      throw new BusinessError('SELF_TRANSFER', 'You cannot transfer to yourself.');
    }
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new BusinessError('INVALID_AMOUNT', 'Transfer amount must be a positive whole number.');
    }
    const fee = Math.max(
      0,
      Math.min(
        Math.floor((input.amount * Math.max(0, input.feePercent ?? 0)) / 100),
        input.maxFee ?? Number.MAX_SAFE_INTEGER,
      ),
    );

    return this.db.transaction(async (client) => {
      if (input.idempotencyKey) {
        const { rows } = await client.query<{
          amount: number;
          fee: number;
          balance_after: number | null;
          metadata: { recipientWallet?: number } | null;
        }>(
          `SELECT amount, fee, balance_after, metadata FROM economy_transactions
            WHERE idempotency_key = $1`,
          [input.idempotencyKey],
        );
        const replay = rows[0];
        if (replay) {
          return {
            amount: Number(replay.amount),
            fee: Number(replay.fee),
            senderWallet: Number(replay.balance_after ?? 0),
            recipientWallet: Number(replay.metadata?.recipientWallet ?? 0),
            replayed: true,
          };
        }
      }

      await this.upsertAccount(client, input.guildId, input.fromUserId, input.starterBalance ?? 0);
      await this.upsertAccount(client, input.guildId, input.toUserId, input.starterBalance ?? 0);

      const ordered = [input.fromUserId, input.toUserId].sort();
      const { rows: locked } = await client.query<EconomyAccountRow>(
        `SELECT * FROM economy_accounts
          WHERE guild_id = $1 AND user_id = ANY($2::text[])
          ORDER BY user_id FOR UPDATE`,
        [input.guildId, ordered],
      );
      const sender = locked.find((row) => row.user_id === input.fromUserId) as EconomyAccountRow;
      const recipient = locked.find((row) => row.user_id === input.toUserId) as EconomyAccountRow;
      const total = input.amount + fee;

      if (sender.wallet < total) {
        throw new BusinessError(
          'INSUFFICIENT_FUNDS',
          `Insufficient balance: you need ${total} (${input.amount} + ${fee} fee) but have ${sender.wallet}.`,
          { balance: sender.wallet, needed: total },
        );
      }

      const { rows: senderRows } = await client.query<EconomyAccountRow>(
        `UPDATE economy_accounts SET wallet = wallet - $3, total_spent = total_spent + $3, updated_at = now()
          WHERE guild_id = $1 AND user_id = $2 RETURNING *`,
        [input.guildId, input.fromUserId, total],
      );
      const { rows: recipientRows } = await client.query<EconomyAccountRow>(
        `UPDATE economy_accounts SET wallet = wallet + $3, total_earned = total_earned + $3, updated_at = now()
          WHERE guild_id = $1 AND user_id = $2 RETURNING *`,
        [input.guildId, input.toUserId, input.amount],
      );
      const senderAfter = (senderRows[0] as EconomyAccountRow).wallet;
      const recipientAfter = (recipientRows[0] as EconomyAccountRow).wallet;

      await client.query(
        `INSERT INTO economy_transactions
           (guild_id, user_id, counterparty_id, type, amount, fee, balance_after, idempotency_key, metadata)
         VALUES ($1,$2,$3,'transfer_out',$4,$5,$6,$7,$8::jsonb)`,
        [
          input.guildId,
          input.fromUserId,
          input.toUserId,
          input.amount,
          fee,
          senderAfter,
          input.idempotencyKey ?? null,
          JSON.stringify({ recipientWallet: recipientAfter }),
        ],
      );
      await client.query(
        `INSERT INTO economy_transactions
           (guild_id, user_id, counterparty_id, type, amount, fee, balance_after, metadata)
         VALUES ($1,$2,$3,'transfer_in',$4,0,$5,$6::jsonb)`,
        [
          input.guildId,
          input.toUserId,
          input.fromUserId,
          input.amount,
          recipientAfter,
          JSON.stringify({ fee }),
        ],
      );

      return { amount: input.amount, fee, senderWallet: senderAfter, recipientWallet: recipientAfter, replayed: false };
    });
  }

  async getTransactions(
    guildId: string,
    userId: string,
    limit = 10,
  ): Promise<
    { id: number; type: string; amount: number; fee: number; counterparty_id: string | null; created_at: Date }[]
  > {
    const { rows } = await this.db.query(
      `SELECT id, type, amount, fee, counterparty_id, created_at FROM economy_transactions
        WHERE guild_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT $3`,
      [guildId, userId, Math.min(Math.max(limit, 1), 100)],
    );
    return rows as never;
  }

  async getTransaction(id: number): Promise<{
    guild_id: string;
    user_id: string;
    type: string;
    amount: number;
    created_at: Date;
  } | null> {
    const { rows } = await this.db.query<{
      guild_id: string;
      user_id: string;
      type: string;
      amount: number;
      created_at: Date;
    }>('SELECT guild_id, user_id, type, amount, created_at FROM economy_transactions WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  async economyStats(guildId: string): Promise<{
    accounts: number;
    totalSupply: number;
    totalEarned: number;
    totalSpent: number;
  }> {
    const { rows } = await this.db.query<{
      accounts: string;
      supply: string;
      earned: string;
      spent: string;
    }>(
      `SELECT count(*)::text AS accounts,
              COALESCE(sum(wallet + bank), 0)::text AS supply,
              COALESCE(sum(total_earned), 0)::text AS earned,
              COALESCE(sum(total_spent), 0)::text AS spent
         FROM economy_accounts WHERE guild_id = $1`,
      [guildId],
    );
    const row = rows[0];
    return {
      accounts: Number(row?.accounts ?? 0),
      totalSupply: Number(row?.supply ?? 0),
      totalEarned: Number(row?.earned ?? 0),
      totalSpent: Number(row?.spent ?? 0),
    };
  }

  // ------------------------------------------------------------------- shop

  async createShopItem(input: {
    guildId: string;
    name: string;
    description?: string | null;
    price: number;
    roleId?: string | null;
    stock?: number | null;
    createdBy: string;
  }): Promise<number> {
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO shop_items (guild_id, name, description, price, role_id, stock, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (guild_id, lower(name)) DO UPDATE SET
         description = EXCLUDED.description, price = EXCLUDED.price,
         role_id = EXCLUDED.role_id, stock = EXCLUDED.stock, enabled = TRUE
       RETURNING id`,
      [
        input.guildId,
        input.name,
        input.description ?? null,
        input.price,
        input.roleId ?? null,
        input.stock ?? null,
        input.createdBy,
      ],
    );
    return Number(rows[0]?.id);
  }

  async deleteShopItem(guildId: string, name: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      'DELETE FROM shop_items WHERE guild_id = $1 AND lower(name) = lower($2)',
      [guildId, name],
    );
    return (rowCount ?? 0) > 0;
  }

  async listShopItems(guildId: string, includeDisabled = false): Promise<
    {
      id: number;
      name: string;
      description: string | null;
      price: number;
      role_id: string | null;
      stock: number | null;
      enabled: boolean;
      sales: number;
    }[]
  > {
    const { rows } = await this.db.query(
      `SELECT s.id, s.name, s.description, s.price, s.role_id, s.stock, s.enabled,
              (SELECT COALESCE(sum(-t.amount), 0)::int FROM economy_transactions t
                 WHERE t.guild_id = s.guild_id AND t.type = 'purchase'
                   AND t.metadata->>'itemId' = s.id::text) AS sales
         FROM shop_items s
        WHERE s.guild_id = $1 ${includeDisabled ? '' : 'AND s.enabled = TRUE'}
        ORDER BY s.price ASC`,
      [guildId],
    );
    return rows as never;
  }

  /** Atomic purchase: stock check, balance debit and inventory write in one tx. */
  async purchase(input: {
    guildId: string;
    userId: string;
    itemId: number;
    quantity?: number;
    starterBalance?: number;
  }): Promise<{ itemName: string; roleId: string | null; quantity: number; balance: number; price: number }> {
    const quantity = Math.max(1, Math.floor(input.quantity ?? 1));
    return this.db.transaction(async (client) => {
      const { rows: items } = await client.query<{
        id: number;
        name: string;
        price: number;
        role_id: string | null;
        stock: number | null;
        enabled: boolean;
      }>(
        `SELECT id, name, price, role_id, stock, enabled FROM shop_items
          WHERE id = $1 AND guild_id = $2 FOR UPDATE`,
        [input.itemId, input.guildId],
      );
      const item = items[0];
      if (!item || !item.enabled) {
        throw new BusinessError('ITEM_NOT_FOUND', 'That shop item is not available.');
      }
      if (item.stock !== null && item.stock < quantity) {
        throw new BusinessError('OUT_OF_STOCK', `Only ${item.stock} left in stock.`);
      }
      await this.upsertAccount(client, input.guildId, input.userId, input.starterBalance ?? 0);
      const { rows: accounts } = await client.query<EconomyAccountRow>(
        'SELECT * FROM economy_accounts WHERE guild_id = $1 AND user_id = $2 FOR UPDATE',
        [input.guildId, input.userId],
      );
      const account = accounts[0] as EconomyAccountRow;
      const cost = Number(item.price) * quantity;
      if (account.wallet < cost) {
        throw new BusinessError(
          'INSUFFICIENT_FUNDS',
          `You need ${cost} but only have ${account.wallet}.`,
          { balance: account.wallet, cost },
        );
      }
      const { rows: updated } = await client.query<EconomyAccountRow>(
        `UPDATE economy_accounts SET wallet = wallet - $3, total_spent = total_spent + $3, updated_at = now()
          WHERE guild_id = $1 AND user_id = $2 RETURNING *`,
        [input.guildId, input.userId, cost],
      );
      if (item.stock !== null) {
        await client.query(
          'UPDATE shop_items SET stock = stock - $2 WHERE id = $1',
          [item.id, quantity],
        );
      }
      await client.query(
        `INSERT INTO inventory (guild_id, user_id, item_id, quantity)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (guild_id, user_id, item_id) DO UPDATE SET quantity = inventory.quantity + EXCLUDED.quantity`,
        [input.guildId, input.userId, item.id, quantity],
      );
      await client.query(
        `INSERT INTO economy_transactions
           (guild_id, user_id, type, amount, fee, balance_after, metadata)
         VALUES ($1,$2,'purchase',$3,0,$4,$5::jsonb)`,
        [
          input.guildId,
          input.userId,
          -cost,
          (updated[0] as EconomyAccountRow).wallet,
          JSON.stringify({ itemId: item.id, itemName: item.name, quantity }),
        ],
      );
      return {
        itemName: item.name,
        roleId: item.role_id,
        quantity,
        balance: (updated[0] as EconomyAccountRow).wallet,
        price: Number(item.price),
      };
    });
  }

  async getInventory(
    guildId: string,
    userId: string,
  ): Promise<{ item_id: number; name: string; quantity: number; role_id: string | null; acquired_at: Date }[]> {
    const { rows } = await this.db.query(
      `SELECT i.item_id, s.name, i.quantity, s.role_id, i.acquired_at
         FROM inventory i JOIN shop_items s ON s.id = i.item_id
        WHERE i.guild_id = $1 AND i.user_id = $2 AND i.quantity > 0
        ORDER BY i.acquired_at DESC`,
      [guildId, userId],
    );
    return rows as never;
  }
}
