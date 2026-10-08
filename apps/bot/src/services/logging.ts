import {
  type TextChannel,
  ChannelType,
  type Guild,
  type GuildBasedChannel,
  type TextBasedChannel,
} from 'discord.js';
import type { Logger } from '@bot-by-ai/shared';
import type { Repositories } from '@bot-by-ai/database';
import type { GuildSettingsService } from './settings.js';
import type { LoggingSettings } from './types.js';
import { baseEmbed } from '../core/embeds.js';
import { COLORS } from '../core/constants.js';

export type LogCategory = keyof Omit<LoggingSettings['channels'], 'audit'> | 'audit';

export interface LogPayload {
  category: LogCategory;
  title: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  /** Optional actor/target for the audit trail row. */
  actorId?: string | null;
  targetId?: string | null;
  /** Persist to `audit_logs` in addition to the channel message. */
  auditAction?: string;
}

/**
 * Central logging fan-out.
 *
 * Discord only exposes events while the bot is running — nothing here claims to
 * recover history the bot never saw. Every send is best-effort: a missing
 * permission or deleted channel is reported to the process logger, never thrown
 * into the caller's flow.
 */
export class LoggingService {
  constructor(
    private readonly settings: GuildSettingsService,
    private readonly repos: Repositories,
    private readonly logger: Logger,
  ) {}

  async getSettings(guildId: string): Promise<LoggingSettings> {
    return this.settings.get<LoggingSettings>(guildId, 'logging');
  }

  private async resolveChannel(
    guild: Guild,
    channelId?: string | null,
  ): Promise<TextBasedChannel | null> {
    if (!channelId) return null;
    const cached = guild.channels.cache.get(channelId);
    const channel: GuildBasedChannel | undefined | null =
      cached ?? (await guild.channels.fetch(channelId).catch(() => null));
    if (!channel) return null;
    if (!channel.isTextBased()) return null;
    if (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice)
      return null;
    const me = guild.members.me;
    if (me && !channel.permissionsFor(me)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
      this.logger.warn('log channel is missing bot permissions', { guildId: guild.id, channelId });
      return null;
    }
    return channel as TextBasedChannel;
  }

  /** Sends a log entry to the configured channel and/or the audit trail. */
  async log(guild: Guild, payload: LogPayload): Promise<void> {
    const settings = await this.getSettings(guild.id).catch(() => null);
    if (payload.auditAction || payload.actorId) {
      await this.repos.audit
        .log({
          guildId: guild.id,
          actorId: payload.actorId ?? null,
          actorType: 'bot',
          action: payload.auditAction ?? `log.${payload.category}`,
          targetId: payload.targetId ?? null,
          metadata: { title: payload.title, description: payload.description?.slice(0, 1000) },
        })
        .catch(() => {});
    }
    if (!settings?.enabled) return;
    const specific = settings.channels?.[payload.category as keyof LoggingSettings['channels']];
    const channelId = specific ?? settings.channels?.audit ?? null;
    if (!channelId) return;
    await this.sendTo(guild, channelId, payload);
  }

  async sendTo(guild: Guild, channelId: string, payload: LogPayload): Promise<boolean> {
    const channel = await this.resolveChannel(guild, channelId);
    if (!channel) return false;
    const embed = baseEmbed(payload.color ?? COLORS.neutral)
      .setTitle(payload.title.slice(0, 250))
      .setDescription(payload.description?.slice(0, 4000) ?? null);
    if (payload.fields && payload.fields.length > 0) {
      embed.addFields(
        payload.fields.slice(0, 25).map((field) => ({
          name: field.name.slice(0, 256),
          value: field.value.slice(0, 1024) || '—',
          inline: field.inline ?? true,
        })),
      );
    }
    try {
      await (channel as TextChannel).send({ embeds: [embed] });
      return true;
    } catch (error) {
      this.logger.warn('failed to send log message', {
        guildId: guild.id,
        channelId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async logBotError(
    guild: Guild | null,
    details: { command: string; message: string; userId?: string },
  ): Promise<void> {
    if (!guild) {
      this.logger.error('command error outside a guild', {
        command: details.command,
        message: details.message,
      });
      return;
    }
    await this.log(guild, {
      category: 'errors',
      title: 'Command error',
      description: `Command: \`${details.command}\`\nError: \`${details.message.slice(0, 500)}\``,
      color: COLORS.danger,
      actorId: details.userId ?? null,
      targetId: null,
    });
  }

  async logModeration(
    guild: Guild,
    details: {
      action: string;
      caseNumber: number;
      userId: string;
      moderatorId: string;
      reason?: string | null;
      duration?: string | null;
    },
  ): Promise<void> {
    await this.log(guild, {
      category: 'moderation',
      title: `Case #${details.caseNumber} • ${details.action}`,
      description: details.reason ?? 'No reason provided.',
      color: COLORS.danger,
      fields: [
        { name: 'Target', value: `<@${details.userId}>`, inline: true },
        { name: 'Moderator', value: `<@${details.moderatorId}>`, inline: true },
        ...(details.duration ? [{ name: 'Duration', value: details.duration, inline: true }] : []),
      ],
      actorId: details.moderatorId,
      targetId: details.userId,
      auditAction: `moderation.${details.action}`,
    });
  }

  async logSecurity(
    guild: Guild,
    details: {
      title: string;
      description: string;
      severity?: 1 | 2 | 3;
      actorId?: string | null;
      targetId?: string | null;
      kind?: string;
    },
  ): Promise<void> {
    await this.log(guild, {
      category: 'security',
      title: `🛡️ ${details.title}`,
      description: details.description,
      color:
        details.severity === 3
          ? COLORS.danger
          : details.severity === 2
            ? COLORS.warning
            : COLORS.security,
      actorId: details.actorId ?? null,
      targetId: details.targetId ?? null,
      auditAction: `security.${details.kind ?? 'event'}`,
    });
  }
}
