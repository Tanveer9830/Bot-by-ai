import { PermissionFlagsBits, type Guild, type GuildMember, type Message } from 'discord.js';
import type { Logger } from '@bot-by-ai/shared';
import {
  evaluateAutomodMessage,
  formatDuration,
  highestSeverity,
  resolveEscalation,
  type AutomodMessageInput,
  type PunishmentAction,
  type Violation,
} from '@bot-by-ai/shared';
import type { Repositories } from '@bot-by-ai/database';
import type { GuildSettingsService } from './settings.js';
import type { LoggingService } from './logging.js';
import type { AutomodSettings } from './types.js';
import { COLORS } from '../core/constants.js';
import { baseEmbed } from '../core/embeds.js';

export interface AutomodOutcome {
  violations: Violation[];
  action: PunishmentAction;
  deleted: boolean;
  warned: boolean;
  timedOutMs: number;
}

/**
 * AutoMod pipeline: evaluate → delete → escalate → log.
 * Each step degrades gracefully (missing permission = skip that step, still log).
 */
export class AutomodService {
  constructor(
    private readonly repos: Repositories,
    private readonly settings: GuildSettingsService,
    private readonly logging: LoggingService,
    private readonly logger: Logger,
  ) {}

  async getSettings(guildId: string): Promise<AutomodSettings> {
    return this.settings.get<AutomodSettings>(guildId, 'automod');
  }

  async processMessage(message: Message<true>): Promise<AutomodOutcome | null> {
    if (!message.guild || message.author.bot || message.system) return null;
    const settings = await this.getSettings(message.guild.id);
    if (!settings.enabled) return null;

    const recent = this.recentMessages.get(message.author.id) ?? [];
    const mentionCounts = {
      total: message.mentions.users.size + message.mentions.roles.size,
      uniqueUsers: message.mentions.users.size,
      maxForSingleUser: this.maxMentionsOfUser(message),
      mentionsEveryone: message.mentions.everyone,
    };
    const input: AutomodMessageInput = {
      content: message.content,
      recentMessages: recent,
      mentionCounts,
      now: Date.now(),
      authorId: message.author.id,
      channelId: message.channelId,
      memberRoleIds: message.member ? [...message.member.roles.cache.keys()] : [],
    };

    const violations = evaluateAutomodMessage(input, {
      ...settings,
      exemptRoleIds: settings.exemptRoleIds,
      exemptChannelIds: settings.exemptChannelIds,
      exemptUserIds: settings.exemptUserIds,
    });

    this.recordRecent(message.author.id, { content: message.content, timestamp: Date.now() });
    if (violations.length === 0) return null;

    const stored = await this.repos.security.countRecentAutomodViolations(
      message.guild.id,
      message.author.id,
      86_400_000,
    );
    const escalationCount = stored + 1;
    const steps = settings.escalation.length > 0 ? settings.escalation : undefined;
    const step = resolveEscalation(escalationCount, steps);
    const severity = highestSeverity(violations);

    let deleted = false;
    let warned = false;
    let timedOutMs = 0;

    if (step.action === 'delete' || settings.warnOnViolation) {
      deleted = await this.tryDelete(message);
    }

    if (settings.warnOnViolation) {
      warned = await this.notifyAuthor(message, violations, escalationCount);
    }

    if (step.action === 'timeout' && message.member) {
      const me = message.guild.members.me;
      const duration = step.durationMs ?? 600_000;
      if (
        me?.permissions.has(PermissionFlagsBits.ModerateMembers) &&
        message.member.roles.highest.position < me.roles.highest.position
      ) {
        const applied = await message.member
          .timeout(duration, `AutoMod: ${violations.map((violation) => violation.kind).join(', ')}`)
          .then(() => true)
          .catch(() => false);
        if (applied) timedOutMs = duration;
      }
    }

    if (step.action === 'kick' && message.member) {
      const me = message.guild.members.me;
      if (
        me?.permissions.has(PermissionFlagsBits.KickMembers) &&
        message.member.roles.highest.position < me.roles.highest.position
      ) {
        await message.member
          .kick(`AutoMod escalation: ${violations.length} violation(s)`)
          .catch(() => {});
      }
    }

    if (step.action === 'ban' && message.member) {
      const me = message.guild.members.me;
      if (
        me?.permissions.has(PermissionFlagsBits.BanMembers) &&
        message.member.roles.highest.position < me.roles.highest.position
      ) {
        await message.guild.bans
          .create(message.author.id, {
            reason: `AutoMod escalation: ${violations.length} violation(s)`,
          })
          .catch(() => {});
      }
    }

    await this.repos.security.recordAutomodViolation({
      guildId: message.guild.id,
      userId: message.author.id,
      channelId: message.channelId,
      messageId: message.id,
      kinds: violations.map((violation) => violation.kind),
      details: { violations, escalationCount },
      actionTaken: step.action === 'none' ? 'alert' : step.action,
    });

    await this.logging
      .log(message.guild, {
        category: 'automod',
        title: `AutoMod: ${violations.map((violation) => violation.kind).join(', ')}`,
        description:
          violations.map((violation) => `• ${violation.detail}`).join('\n') ||
          'No detail available.',
        color: severity >= 3 ? COLORS.danger : COLORS.warning,
        actorId: message.author.id,
        fields: [
          { name: 'Channel', value: `<#${message.channelId}>`, inline: true },
          { name: 'Escalation', value: `${escalationCount} → ${step.action}`, inline: true },
        ],
        auditAction: 'automod.violation',
      })
      .catch(() => {});

    return { violations, action: step.action, deleted, warned, timedOutMs };
  }

  private async tryDelete(message: Message<true>): Promise<boolean> {
    const me = message.guild.members.me;
    if (!me?.permissions.has(PermissionFlagsBits.ManageMessages)) return false;
    const permissions =
      'permissionsFor' in message.channel ? message.channel.permissionsFor(me) : null;
    if (permissions && !permissions.has(PermissionFlagsBits.ManageMessages)) return false;
    return message
      .delete()
      .then(() => true)
      .catch(() => false);
  }

  private async notifyAuthor(
    message: Message<true>,
    violations: Violation[],
    escalationCount: number,
  ): Promise<boolean> {
    const reasons = violations.map((violation) => violation.detail).join('; ');
    return message
      .reply({
        content: `⚠️ <@${message.author.id}> your message was flagged by AutoMod: ${reasons.slice(0, 800)} (violation #${escalationCount} in 24h).`,
        allowedMentions: { users: [message.author.id] },
      })
      .then(() => true)
      .catch(() => false);
  }

  private maxMentionsOfUser(message: Message<true>): number {
    const counts = new Map<string, number>();
    for (const user of message.mentions.users.values()) {
      counts.set(user.id, (counts.get(user.id) ?? 0) + 1);
    }
    const raw = message.content.match(/<@!?(\d{17,20})>/g) ?? [];
    for (const mention of raw) {
      const id = mention.replace(/[<@!>]/g, '');
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return Math.max(0, ...counts.values());
  }

  private readonly recentMessages = new Map<string, { content: string; timestamp: number }[]>();

  private recordRecent(userId: string, entry: { content: string; timestamp: number }): void {
    const list = this.recentMessages.get(userId) ?? [];
    list.push(entry);
    const cutoff = Date.now() - 60_000;
    const trimmed = list.filter((item) => item.timestamp > cutoff).slice(-10);
    this.recentMessages.set(userId, trimmed);
    if (this.recentMessages.size > 5_000) {
      // Bounded memory: drop the oldest half when the map grows too large.
      const keys = [...this.recentMessages.keys()].slice(0, 2_500);
      for (const key of keys) this.recentMessages.delete(key);
    }
  }

  /** Message count within the anti-spam window, used by the security service. */
  messageCountInWindow(userId: string, windowMs: number): number {
    const list = this.recentMessages.get(userId) ?? [];
    const cutoff = Date.now() - windowMs;
    return list.filter((entry) => entry.timestamp > cutoff).length;
  }

  async warnSummaryEmbed(guild: Guild, member: GuildMember): Promise<ReturnType<typeof baseEmbed>> {
    const count = await this.repos.security.countRecentAutomodViolations(
      guild.id,
      member.id,
      7 * 86_400_000,
    );
    const settings = await this.getSettings(guild.id);
    return baseEmbed(COLORS.warning)
      .setTitle(`AutoMod summary for ${member.user.tag}`)
      .setDescription(`${count} violation(s) in the last 7 days.`)
      .addFields(
        { name: 'Window', value: formatDuration(settings.spamWindowMs), inline: true },
        { name: 'Message limit', value: String(settings.spamMessageLimit), inline: true },
      );
  }
}
