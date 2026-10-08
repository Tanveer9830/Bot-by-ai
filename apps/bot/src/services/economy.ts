import type { Logger } from '@bot-by-ai/shared';
import {
  assertSufficientFunds,
  computeDailyReward,
  computeWorkReward,
  computeTransfer,
  formatDuration,
  idempotencyKey,
  secureRandomInt,
  UserFacingError,
} from '@bot-by-ai/shared';
import type { Database, Repositories } from '@bot-by-ai/database';
import type { GuildSettingsService } from './settings.js';
import type { EconomySettings } from './types.js';

export interface RewardResult {
  amount: number;
  balance: number;
  streak: number;
  multiplier?: number;
}

/**
 * Economy service.
 *
 * All money movement happens in `EconomyRepository` transactions; this layer
 * only decides *how much* and enforces cooldowns/idempotency so that repeated
 * or concurrent command invocations cannot duplicate rewards.
 */
export class EconomyService {
  constructor(
    private readonly db: Database,
    private readonly repos: Repositories,
    private readonly settings: GuildSettingsService,
    private readonly logger: Logger,
  ) {}

  async getSettings(guildId: string): Promise<EconomySettings> {
    return this.settings.get<EconomySettings>(guildId, 'economy');
  }

  async account(
    guildId: string,
    userId: string,
  ): Promise<{ wallet: number; bank: number; total: number }> {
    const settings = await this.getSettings(guildId);
    const account = await this.repos.economy.ensureAccount(
      guildId,
      userId,
      settings.starterBalance,
    );
    return { wallet: account.wallet, bank: account.bank, total: account.wallet + account.bank };
  }

  async daily(guildId: string, userId: string): Promise<RewardResult> {
    const settings = await this.getSettings(guildId);
    if (!settings.enabled) throw new UserFacingError('The economy is disabled in this server.');
    const claim = await this.repos.economy.claimCooldown({
      guildId,
      userId,
      action: 'daily',
      cooldownMs: settings.dailyCooldownMs,
    });
    if (!claim.granted) {
      throw new UserFacingError(
        `You already claimed your daily reward. Try again in ${formatDuration(claim.retryAfterMs)}.`,
      );
    }
    const { amount, multiplier } = computeDailyReward({
      base: settings.dailyAmount,
      streak: claim.streak,
      streakBonusPercent: 5,
      maxMultiplier: 5,
    });
    // The idempotency key is derived from the streak window so a retry of the
    // same claim can never double-credit.
    const result = await this.repos.economy.adjustBalance({
      guildId,
      userId,
      amount,
      type: 'daily',
      idempotencyKey: idempotencyKey([
        'daily',
        guildId,
        userId,
        claim.streak,
        settings.dailyCooldownMs,
      ]),
      starterBalance: settings.starterBalance,
      metadata: { streak: claim.streak, multiplier },
    });
    return { amount, balance: result.balance, streak: claim.streak, multiplier };
  }

  async weekly(guildId: string, userId: string): Promise<RewardResult> {
    const settings = await this.getSettings(guildId);
    if (!settings.enabled) throw new UserFacingError('The economy is disabled in this server.');
    const claim = await this.repos.economy.claimCooldown({
      guildId,
      userId,
      action: 'weekly',
      cooldownMs: settings.weeklyCooldownMs,
    });
    if (!claim.granted) {
      throw new UserFacingError(
        `You already claimed your weekly reward. Try again in ${formatDuration(claim.retryAfterMs)}.`,
      );
    }
    const result = await this.repos.economy.adjustBalance({
      guildId,
      userId,
      amount: settings.weeklyAmount,
      type: 'weekly',
      idempotencyKey: idempotencyKey(['weekly', guildId, userId, claim.streak]),
      starterBalance: settings.starterBalance,
    });
    return { amount: settings.weeklyAmount, balance: result.balance, streak: claim.streak };
  }

  async work(guildId: string, userId: string, level = 0): Promise<RewardResult> {
    const settings = await this.getSettings(guildId);
    if (!settings.enabled) throw new UserFacingError('The economy is disabled in this server.');
    const claim = await this.repos.economy.claimCooldown({
      guildId,
      userId,
      action: 'work',
      cooldownMs: settings.workCooldownMs,
    });
    if (!claim.granted) {
      throw new UserFacingError(
        `You are tired. Try working again in ${formatDuration(claim.retryAfterMs)}.`,
      );
    }
    const amount = computeWorkReward({
      min: settings.workMin,
      max: settings.workMax,
      level,
      levelScalingPercent: settings.levelScalingPercent,
      roll: secureRandomInt(0, 999_999) / 1_000_000,
    });
    const result = await this.repos.economy.adjustBalance({
      guildId,
      userId,
      amount,
      type: 'work',
      idempotencyKey: idempotencyKey([
        'work',
        guildId,
        userId,
        claim.streak,
        Math.floor(Date.now() / 3_600_000),
      ]),
      starterBalance: settings.starterBalance,
    });
    return { amount, balance: result.balance, streak: claim.streak };
  }

  async transfer(input: {
    guildId: string;
    fromUserId: string;
    toUserId: string;
    amount: number;
    idempotencyKey?: string;
  }): Promise<{ amount: number; fee: number; senderWallet: number; recipientWallet: number }> {
    const settings = await this.getSettings(input.guildId);
    if (!settings.enabled) throw new UserFacingError('The economy is disabled in this server.');
    if (input.amount < settings.transferMin) {
      throw new UserFacingError(`The minimum transfer is ${settings.transferMin}.`);
    }
    if (input.amount > settings.transferMax) {
      throw new UserFacingError(`The maximum transfer is ${settings.transferMax}.`);
    }
    const { fee } = computeTransfer({
      amount: input.amount,
      feePercent: settings.transferFeePercent,
    });
    const account = await this.account(input.guildId, input.fromUserId);
    assertSufficientFunds(account.wallet, input.amount + fee, 'wallet');
    return this.repos.economy.transfer({
      guildId: input.guildId,
      fromUserId: input.fromUserId,
      toUserId: input.toUserId,
      amount: input.amount,
      feePercent: settings.transferFeePercent,
      idempotencyKey:
        input.idempotencyKey ??
        idempotencyKey(['transfer', input.guildId, input.fromUserId, input.toUserId, Date.now()]),
      starterBalance: settings.starterBalance,
    });
  }

  async buy(
    guildId: string,
    userId: string,
    itemName: string,
    quantity = 1,
  ): Promise<{
    itemName: string;
    roleId: string | null;
    quantity: number;
    balance: number;
    price: number;
  }> {
    const settings = await this.getSettings(guildId);
    if (!settings.shopEnabled) throw new UserFacingError('The shop is disabled in this server.');
    const items = await this.repos.economy.listShopItems(guildId);
    const item = items.find((entry) => entry.name.toLowerCase() === itemName.toLowerCase());
    if (!item) throw new UserFacingError(`No shop item named \`${itemName}\`.`);
    const result = await this.repos.economy.purchase({
      guildId,
      userId,
      itemId: item.id,
      quantity,
      starterBalance: settings.starterBalance,
    });
    this.logger.info('economy purchase', {
      guildId,
      userId,
      item: result.itemName,
      price: result.price,
      quantity: result.quantity,
    });
    return result;
  }

  async adminAdjust(input: {
    guildId: string;
    userId: string;
    amount: number;
    actorId: string;
    reason?: string | null;
  }): Promise<{ balance: number; replayed: boolean }> {
    const settings = await this.getSettings(input.guildId);
    const result = await this.repos.economy.adjustBalance({
      guildId: input.guildId,
      userId: input.userId,
      amount: input.amount,
      type: 'admin_adjust',
      actorId: input.actorId,
      starterBalance: settings.starterBalance,
      metadata: { reason: input.reason ?? null, actorId: input.actorId },
    });
    await this.repos.audit.log({
      guildId: input.guildId,
      actorId: input.actorId,
      actorType: 'dashboard',
      action: 'economy.admin_adjust',
      targetType: 'user',
      targetId: input.userId,
      metadata: { amount: input.amount, reason: input.reason ?? null },
    });
    this.logger.info('economy admin adjustment', {
      guildId: input.guildId,
      userId: input.userId,
      amount: input.amount,
      actorId: input.actorId,
    });
    return { balance: result.balance, replayed: result.replayed };
  }

  /** Progress on the built-in achievement set for a user. */
  async achievements(
    guildId: string,
    userId: string,
  ): Promise<
    {
      key: string;
      name: string;
      description: string | null;
      requirement: unknown;
      reward: number;
      progress: number;
      completed: boolean;
    }[]
  > {
    const result = await this.db.query<{
      key: string;
      name: string;
      description: string | null;
      requirement: { type?: string; value?: number } | null;
      reward: number;
      progress: number | null;
      completed_at: Date | null;
    }>(
      `SELECT a.key, a.name, a.description, a.requirement, a.reward, ua.progress, ua.completed_at
         FROM achievements a
         LEFT JOIN user_achievements ua
           ON ua.achievement_id = a.id AND ua.user_id = $2 AND ua.guild_id = $1
        WHERE (a.guild_id = $1 OR a.guild_id IS NULL) AND a.enabled = TRUE
        ORDER BY a.reward ASC`,
      [guildId, userId],
    );
    return result.rows.map(
      (row: {
        key: string;
        name: string;
        description: string | null;
        requirement: { type?: string; value?: number } | null;
        reward: number;
        progress: number | null;
        completed_at: Date | null;
      }) => ({
        key: row.key,
        name: row.name,
        description: row.description,
        requirement: row.requirement,
        reward: Number(row.reward),
        progress: Number(row.progress ?? 0),
        completed: row.completed_at !== null,
      }),
    );
  }
}
