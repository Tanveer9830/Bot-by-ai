import { PermissionFlagsBits, type Guild, type GuildMember } from 'discord.js';
import type { Logger } from '@bot-by-ai/shared';
import {
  computeLevelUpRoles,
  computeMessageXp,
  isLowQualityMessage,
  progressFromXp,
  renderTemplate,
  DEFAULT_XP_CURVE,
} from '@bot-by-ai/shared';
import type { Repositories } from '@bot-by-ai/database';
import type { GuildSettingsService } from './settings.js';
import type { LoggingService } from './logging.js';
import type { LevelSettings } from './types.js';

export interface XpOutcome {
  granted: boolean;
  amount: number;
  xp: number;
  level: number;
  leveledUp: boolean;
  reason?: string;
}

/**
 * XP/level service.
 *
 * Anti-farming measures (all enforced here, not in command handlers):
 *  - per-user cooldown stored in the database (survives restarts)
 *  - minimum message length / duplicate-message rejection
 *  - ignored channels & roles
 *  - global and per-role multipliers
 *  - level cap from settings
 */
export class LevelsService {
  constructor(
    private readonly repos: Repositories,
    private readonly settings: GuildSettingsService,
    private readonly logging: LoggingService,
    private readonly logger: Logger,
  ) {}

  async getSettings(guildId: string): Promise<LevelSettings> {
    return this.settings.get<LevelSettings>(guildId, 'levels');
  }

  /** Multiplier resolution: role multipliers stack multiplicatively, capped at 5x. */
  private resolveMultiplier(settings: LevelSettings, member: GuildMember | null): number {
    let multiplier = settings.multiplier;
    if (member && settings.levelMultiplierRoleIds.length > 0) {
      for (const entry of settings.levelMultiplierRoleIds) {
        if (member.roles.cache.has(entry.roleId)) multiplier *= entry.multiplier;
      }
    }
    return Math.min(Math.max(multiplier, 0), 10);
  }

  async handleMessage(input: {
    guild: Guild;
    member: GuildMember;
    channelId: string;
    content: string;
    recentMessages?: string[];
  }): Promise<XpOutcome> {
    const settings = await this.getSettings(input.guild.id);
    if (!settings.enabled) return { granted: false, amount: 0, xp: 0, level: 0, leveledUp: false, reason: 'disabled' };
    if (settings.ignoredChannelIds.includes(input.channelId)) {
      return { granted: false, amount: 0, xp: 0, level: 0, leveledUp: false, reason: 'ignored channel' };
    }
    if (settings.ignoredRoleIds.some((roleId) => input.member.roles.cache.has(roleId))) {
      return { granted: false, amount: 0, xp: 0, level: 0, leveledUp: false, reason: 'ignored role' };
    }
    if (settings.noXpRoleIds.some((roleId) => input.member.roles.cache.has(roleId))) {
      return { granted: false, amount: 0, xp: 0, level: 0, leveledUp: false, reason: 'no-xp role' };
    }
    if (isLowQualityMessage(input.content, input.recentMessages)) {
      // Still count the message for statistics, but award no XP.
      await this.repos.levels
        .addXp({
          guildId: input.guild.id,
          userId: input.member.id,
          amount: 0,
          cooldownMs: settings.cooldownMs,
          countMessage: true,
        })
        .catch(() => {});
      return { granted: false, amount: 0, xp: 0, level: 0, leveledUp: false, reason: 'low quality message' };
    }

    const amount = computeMessageXp({
      min: settings.minXp,
      max: settings.maxXp,
      multiplier: this.resolveMultiplier(settings, input.member),
    });

    const result = await this.repos.levels.addXp({
      guildId: input.guild.id,
      userId: input.member.id,
      amount,
      cooldownMs: settings.cooldownMs,
      maxLevel: settings.maxLevel,
      countMessage: true,
    });

    if (result.leveledUp) {
      await this.announceLevelUp(input.guild, input.member, result.level, settings).catch((error) => {
        this.logger.warn('level-up announcement failed', {
          guildId: input.guild.id,
          userId: input.member.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      await this.applyRoleRewards(input.guild, input.member, result.level, settings).catch(() => {});
    }

    return {
      granted: !result.throttled,
      amount: result.throttled ? 0 : amount,
      xp: result.xp,
      level: result.level,
      leveledUp: result.leveledUp,
      reason: result.throttled ? 'cooldown' : undefined,
    };
  }

  /** Voice XP is granted per whole minute in a channel with 2+ humans. */
  async handleVoiceMinute(input: {
    guild: Guild;
    member: GuildMember;
    minutes?: number;
  }): Promise<{ granted: boolean; amount: number }> {
    const settings = await this.getSettings(input.guild.id);
    if (!settings.enabled || settings.xpPerVoiceMinute <= 0) return { granted: false, amount: 0 };
    const amount = Math.floor(settings.xpPerVoiceMinute * this.resolveMultiplier(settings, input.member));
    const result = await this.repos.levels.addXp({
      guildId: input.guild.id,
      userId: input.member.id,
      amount,
      cooldownMs: 0,
      maxLevel: settings.maxLevel,
      voiceMinutes: input.minutes ?? 1,
    });
    if (result.leveledUp) {
      await this.announceLevelUp(input.guild, input.member, result.level, settings).catch(() => {});
      await this.applyRoleRewards(input.guild, input.member, result.level, settings).catch(() => {});
    }
    return { granted: true, amount };
  }

  private async announceLevelUp(
    guild: Guild,
    member: GuildMember,
    level: number,
    settings: LevelSettings,
  ): Promise<void> {
    if (settings.message && settings.announceChannelId) {
      const channel = await guild.channels.fetch(settings.announceChannelId).catch(() => null);
      if (channel?.isTextBased() && channel.type !== 2 && channel.type !== 13) {
        const content = renderTemplate(settings.message, {
          user: {
            id: member.id,
            username: member.user.username,
            tag: member.user.tag,
            mention: `<@${member.id}>`,
          },
          server: { name: guild.name, id: guild.id, memberCount: guild.memberCount },
          extras: { level },
        }).output;
        await channel.send({ content }).catch(() => {});
      }
    }
    if (settings.announceDm) {
      await member
        .send(`You reached level **${level}** in **${guild.name}**!`)
        .catch(() => {});
    }
    await this.logging
      .log(guild, {
        category: 'members',
        title: 'Level up',
        description: `<@${member.id}> reached level **${level}**.`,
        actorId: member.id,
        auditAction: 'levels.level_up',
      })
      .catch(() => {});
  }

  /** Applies the highest eligible role reward and removes lower/other rewards. */
  async applyRoleRewards(
    guild: Guild,
    member: GuildMember,
    level: number,
    settings: LevelSettings,
  ): Promise<void> {
    if (settings.roleRewards.length === 0) return;
    const me = guild.members.me;
    if (!me || !me.permissions.has(PermissionFlagsBits.ManageRoles)) return;
    const { toAdd, toRemove } = computeLevelUpRoles(level, settings.roleRewards);
    const addRole = toAdd[0];
    if (addRole) {
      const role = guild.roles.cache.get(addRole.roleId) ?? (await guild.roles.fetch(addRole.roleId).catch(() => null));
      if (role && role.position < me.roles.highest.position && !member.roles.cache.has(role.id)) {
        await member.roles.add(role, `Level reward (level ${addRole.level})`).catch(() => {});
      }
    }
    for (const reward of toRemove) {
      if (reward.level <= level) continue;
      if (member.roles.cache.has(reward.roleId)) {
        await member.roles.remove(reward.roleId, 'Level reward cleanup').catch(() => {});
      }
    }
  }

  async profile(guildId: string, userId: string): Promise<{
    xp: number;
    level: number;
    rank: number | null;
    xpIntoLevel: number;
    xpForLevel: number;
    ratio: number;
    messages: number;
    voiceMinutes: number;
  }> {
    const [profile, rank] = await Promise.all([
      this.repos.levels.getProfile(guildId, userId),
      this.repos.levels.getRank(guildId, userId),
    ]);
    const xp = profile?.xp ?? 0;
    const progress = progressFromXp(xp, DEFAULT_XP_CURVE);
    return {
      xp,
      level: profile?.level ?? 0,
      rank: rank?.rank ?? null,
      xpIntoLevel: progress.xpIntoLevel,
      xpForLevel: progress.xpForLevel,
      ratio: progress.ratio,
      messages: Number(profile?.messages ?? 0),
      voiceMinutes: Number(profile?.voice_minutes ?? 0),
    };
  }
}
