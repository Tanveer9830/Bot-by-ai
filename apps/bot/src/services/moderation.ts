import {
  type TextChannel,
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type User,
} from 'discord.js';
import type { Logger } from '@bot-by-ai/shared';
import { formatDuration, UserFacingError } from '@bot-by-ai/shared';
import type { ModerationAction, Repositories } from '@bot-by-ai/database';
import type { GuildSettingsService } from './settings.js';
import type { LoggingService } from './logging.js';
import type { ModerationSettings } from './types.js';
import { assertCanModerate, requireBotPermissions, requireUserPermissions } from '../core/resolvers.js';

export interface ModerationResult {
  caseNumber: number;
  action: ModerationAction;
  userId: string;
  dmDelivered: boolean;
  detail?: string;
}

export interface ModerationRequest {
  guild: Guild;
  actor: GuildMember;
  targetMember: GuildMember | null;
  targetUser: User;
  reason?: string | null;
  durationMs?: number | null;
  source?: string;
  /** Skip the hierarchy check only for system/automated actions with a reason. */
  skipHierarchy?: boolean;
  deleteMessageSeconds?: number;
  botOwnerOverride?: boolean;
}

/**
 * All destructive moderation flows go through here so that permission checks,
 * case records, audit logs and appeals stay consistent between slash commands,
 * automod escalation and dashboard-triggered actions.
 */
export class ModerationService {
  constructor(
    private readonly repos: Repositories,
    private readonly settings: GuildSettingsService,
    private readonly logging: LoggingService,
    private readonly logger: Logger,
  ) {}

  async getSettings(guildId: string): Promise<ModerationSettings> {
    return this.settings.get<ModerationSettings>(guildId, 'moderation');
  }

  private async prepare(request: ModerationRequest, action: ModerationAction): Promise<ModerationSettings> {
    const settings = await this.getSettings(request.guild.id);
    if (!request.skipHierarchy) {
      assertCanModerate({
        guild: request.guild,
        actor: request.actor,
        target: request.targetMember,
        targetUser: request.targetUser,
        botMember: request.guild.members.me,
        isBotOwner: request.botOwnerOverride,
        action,
      });
    }
    if (settings.requireReason && !request.reason && ['ban', 'kick'].includes(action)) {
      throw new UserFacingError('A reason is required for this action in this server.');
    }
    return settings;
  }

  private async createCase(
    request: ModerationRequest,
    action: ModerationAction,
    durationMs?: number | null,
  ): Promise<number> {
    const record = await this.repos.moderation.createCase({
      guildId: request.guild.id,
      userId: request.targetUser.id,
      moderatorId: request.actor.id,
      action,
      reason: request.reason ?? null,
      durationMs: durationMs ?? null,
      source: request.source ?? 'command',
    });
    await this.logging.logModeration(request.guild, {
      action,
      caseNumber: record.case_number,
      userId: request.targetUser.id,
      moderatorId: request.actor.id,
      reason: request.reason ?? null,
      duration: durationMs ? formatDuration(durationMs) : null,
    });
    return record.case_number;
  }

  private async notifyTarget(
    request: ModerationRequest,
    action: ModerationAction,
    settings: ModerationSettings,
    caseNumber: number,
    durationMs?: number | null,
  ): Promise<boolean> {
    if (!settings.dmOnAction) return false;
    const lines = [
      `You were **${action}** in **${request.guild.name}** (case #${caseNumber}).`,
      `Reason: ${request.reason ?? 'No reason provided.'}`,
    ];
    if (durationMs) lines.push(`Duration: ${formatDuration(durationMs)}`);
    if (settings.appealInstructions) lines.push(`Appeals: ${settings.appealInstructions}`);
    try {
      await request.targetUser.send({ content: lines.join('\n').slice(0, 1900) });
      return true;
    } catch {
      return false;
    }
  }

  async ban(request: ModerationRequest & { deleteMessageSeconds?: number }): Promise<ModerationResult> {
    const settings = await this.prepare(request, 'ban');
    requireBotPermissions(request.guild, [PermissionFlagsBits.BanMembers], 'banning members');
    const caseNumber = await this.createCase(request, 'ban');
    await request.guild.bans.create(request.targetUser.id, {
      reason: `${request.actor.user.tag}: ${request.reason ?? 'no reason'} (case #${caseNumber})`,
      deleteMessageSeconds: request.deleteMessageSeconds ?? 0,
    });
    const dmDelivered = await this.notifyTarget(request, 'ban', settings, caseNumber);
    this.logger.info('member banned', {
      guildId: request.guild.id,
      userId: request.targetUser.id,
      moderatorId: request.actor.id,
      caseNumber,
    });
    return { caseNumber, action: 'ban', userId: request.targetUser.id, dmDelivered };
  }

  async unban(request: Omit<ModerationRequest, 'targetMember'>): Promise<ModerationResult> {
    await this.prepare({ ...request, targetMember: null }, 'unban');
    requireBotPermissions(request.guild, [PermissionFlagsBits.BanMembers], 'unbanning members');
    const ban = await request.guild.bans.fetch(request.targetUser.id).catch(() => null);
    if (!ban) throw new UserFacingError('That user is not banned in this server.');
    const caseNumber = await this.createCase({ ...request, targetMember: null }, 'unban');
    await request.guild.bans.remove(request.targetUser.id, `${request.actor.user.tag}: ${request.reason ?? 'no reason'}`);
    return { caseNumber, action: 'unban', userId: request.targetUser.id, dmDelivered: false };
  }

  async kick(request: ModerationRequest): Promise<ModerationResult> {
    const settings = await this.prepare(request, 'kick');
    if (!request.targetMember) throw new UserFacingError('That member is not in this server.');
    requireBotPermissions(request.guild, [PermissionFlagsBits.KickMembers], 'kicking members');
    const caseNumber = await this.createCase(request, 'kick');
    await request.targetMember.kick(`${request.actor.user.tag}: ${request.reason ?? 'no reason'} (case #${caseNumber})`);
    const dmDelivered = await this.notifyTarget(request, 'kick', settings, caseNumber);
    return { caseNumber, action: 'kick', userId: request.targetUser.id, dmDelivered };
  }

  async timeout(request: ModerationRequest & { durationMs: number }): Promise<ModerationResult> {
    const settings = await this.prepare(request, 'timeout');
    if (!request.targetMember) throw new UserFacingError('That member is not in this server.');
    requireBotPermissions(request.guild, [PermissionFlagsBits.ModerateMembers], 'timing out members');
    if (request.durationMs > 28 * 24 * 60 * 60 * 1000) {
      throw new UserFacingError('Discord limits timeouts to 28 days.');
    }
    const caseNumber = await this.createCase(request, 'timeout', request.durationMs);
    await request.targetMember.timeout(
      request.durationMs,
      `${request.actor.user.tag}: ${request.reason ?? 'no reason'} (case #${caseNumber})`,
    );
    const dmDelivered = await this.notifyTarget(request, 'timeout', settings, caseNumber, request.durationMs);
    return { caseNumber, action: 'timeout', userId: request.targetUser.id, dmDelivered };
  }

  async removeTimeout(request: ModerationRequest): Promise<ModerationResult> {
    await this.prepare(request, 'untimeout');
    if (!request.targetMember) throw new UserFacingError('That member is not in this server.');
    requireBotPermissions(request.guild, [PermissionFlagsBits.ModerateMembers], 'removing timeouts');
    if (!request.targetMember.isCommunicationDisabled()) {
      throw new UserFacingError('That member is not currently timed out.');
    }
    const caseNumber = await this.createCase(request, 'untimeout');
    await request.targetMember.timeout(null, `${request.actor.user.tag} removed the timeout (case #${caseNumber})`);
    return { caseNumber, action: 'untimeout', userId: request.targetUser.id, dmDelivered: false };
  }

  async warn(
    request: ModerationRequest,
  ): Promise<ModerationResult & { warningCount: number; escalation?: string }> {
    const settings = await this.prepare(request, 'warn');
    const caseNumber = await this.createCase(request, 'warn');
    if (!request.reason) throw new UserFacingError('A reason is required for warnings.');
    const moderationCase = await this.repos.moderation.getCase(request.guild.id, caseNumber);
    await this.repos.moderation.addWarning({
      guildId: request.guild.id,
      userId: request.targetUser.id,
      moderatorId: request.actor.id,
      reason: request.reason,
      caseId: moderationCase?.id ?? null,
      weight: 1,
    });
    const warningCount = await this.repos.moderation.countActiveWarnings(request.guild.id, request.targetUser.id);
    await this.notifyTarget(request, 'warn', settings, caseNumber);
    const escalation = await this.applyWarningEscalation(request, warningCount, settings);
    return { caseNumber, action: 'warn', userId: request.targetUser.id, dmDelivered: true, warningCount, escalation };
  }

  /**
   * Applies the configured warning thresholds. Thresholds of 0 disable the step,
   * and the bot never escalates beyond what the hierarchy allows.
   */
  private async applyWarningEscalation(
    request: ModerationRequest,
    warningCount: number,
    settings: ModerationSettings,
  ): Promise<string | undefined> {
    const thresholds = settings.warnThresholds;
    const member = request.targetMember;
    if (!member) return undefined;
    try {
      if (thresholds.banAt > 0 && warningCount >= thresholds.banAt) {
        await this.ban({ ...request, reason: `Automatic escalation: ${warningCount} active warnings`, skipHierarchy: false });
        return `banned (${warningCount} warnings reached the ban threshold of ${thresholds.banAt})`;
      }
      if (thresholds.kickAt > 0 && warningCount >= thresholds.kickAt) {
        await this.kick({ ...request, reason: `Automatic escalation: ${warningCount} active warnings` });
        return `kicked (${warningCount} warnings reached the kick threshold of ${thresholds.kickAt})`;
      }
      if (thresholds.timeoutAt > 0 && warningCount >= thresholds.timeoutAt) {
        await this.timeout({
          ...request,
          durationMs: thresholds.timeoutMs,
          reason: `Automatic escalation: ${warningCount} active warnings`,
        });
        return `timed out for ${formatDuration(thresholds.timeoutMs)} (${warningCount} warnings)`;
      }
    } catch (error) {
      this.logger.warn('warning escalation could not be applied', {
        guildId: request.guild.id,
        userId: request.targetUser.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'escalation attempted but could not be applied (hierarchy/permissions)';
    }
    return undefined;
  }

  async addRole(request: ModerationRequest & { roleId: string }): Promise<ModerationResult> {
    const settings = await this.getSettings(request.guild.id);
    requireUserPermissions(request.actor, [PermissionFlagsBits.ManageRoles], 'managing roles');
    if (!request.targetMember) throw new UserFacingError('That member is not in this server.');
    const role = await request.guild.roles.fetch(request.roleId).catch(() => null);
    if (!role) throw new UserFacingError('That role does not exist.');
    const me = requireBotPermissions(request.guild, [PermissionFlagsBits.ManageRoles], 'managing roles');
    if (me && role.position >= me.roles.highest.position) {
      throw new UserFacingError('That role is higher than my highest role, so Discord will reject the change.');
    }
    assertCanModerate({
      guild: request.guild,
      actor: request.actor,
      target: request.targetMember,
      targetUser: request.targetUser,
      botMember: me,
      isBotOwner: request.botOwnerOverride,
      action: 'role_add',
    });
    const caseNumber = await this.createCase(request, 'role_add');
    await request.targetMember.roles.add(role, `${request.actor.user.tag}: ${request.reason ?? 'role added'}`);
    void settings;
    return { caseNumber, action: 'role_add', userId: request.targetUser.id, dmDelivered: false, detail: role.name };
  }

  async removeRole(request: ModerationRequest & { roleId: string }): Promise<ModerationResult> {
    requireUserPermissions(request.actor, [PermissionFlagsBits.ManageRoles], 'managing roles');
    if (!request.targetMember) throw new UserFacingError('That member is not in this server.');
    const role = await request.guild.roles.fetch(request.roleId).catch(() => null);
    if (!role) throw new UserFacingError('That role does not exist.');
    const me = requireBotPermissions(request.guild, [PermissionFlagsBits.ManageRoles], 'managing roles');
    if (me && role.position >= me.roles.highest.position) {
      throw new UserFacingError('That role is higher than my highest role, so Discord will reject the change.');
    }
    assertCanModerate({
      guild: request.guild,
      actor: request.actor,
      target: request.targetMember,
      targetUser: request.targetUser,
      botMember: me,
      isBotOwner: request.botOwnerOverride,
      action: 'role_remove',
    });
    const caseNumber = await this.createCase(request, 'role_remove');
    await request.targetMember.roles.remove(role, `${request.actor.user.tag}: ${request.reason ?? 'role removed'}`);
    return { caseNumber, action: 'role_remove', userId: request.targetUser.id, dmDelivered: false, detail: role.name };
  }

  async setNickname(request: ModerationRequest & { nickname: string | null }): Promise<ModerationResult> {
    requireUserPermissions(request.actor, [PermissionFlagsBits.ManageNicknames], 'managing nicknames');
    if (!request.targetMember) throw new UserFacingError('That member is not in this server.');
    const me = requireBotPermissions(request.guild, [PermissionFlagsBits.ManageNicknames], 'managing nicknames');
    assertCanModerate({
      guild: request.guild,
      actor: request.actor,
      target: request.targetMember,
      targetUser: request.targetUser,
      botMember: me,
      isBotOwner: request.botOwnerOverride,
      action: 'nickname',
    });
    const caseNumber = await this.createCase(request, 'nickname');
    await request.targetMember.setNickname(request.nickname, `${request.actor.user.tag}: nickname change`);
    return { caseNumber, action: 'nickname', userId: request.targetUser.id, dmDelivered: false };
  }

  async setSlowmode(
    guild: Guild,
    channelId: string,
    seconds: number,
    actor: GuildMember,
  ): Promise<{ channelName: string; seconds: number }> {
    requireUserPermissions(actor, [PermissionFlagsBits.ManageChannels], 'managing channels');
    requireBotPermissions(guild, [PermissionFlagsBits.ManageChannels], 'setting slowmode');
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildForum)) {
      throw new UserFacingError('Slowmode can only be set on text/forum channels.');
    }
    if (seconds < 0 || seconds > 21_600) {
      throw new UserFacingError('Slowmode must be between 0 and 21600 seconds (Discord limit).');
    }
    await channel.setRateLimitPerUser(seconds, `${actor.user.tag}: slowmode change`);
    return { channelName: channel.name, seconds };
  }

  async lockChannel(
    guild: Guild,
    channelId: string,
    actor: GuildMember,
    reason: string,
  ): Promise<{ channelName: string }> {
    requireUserPermissions(actor, [PermissionFlagsBits.ManageChannels], 'locking channels');
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) throw new UserFriendlyChannelError();
    await (channel as TextChannel).permissionOverwrites.edit(
      guild.roles.everyone,
      { SendMessages: false },
      { reason: `${actor.user.tag}: locked — ${reason}` },
    );
    return { channelName: channel.name };
  }

  async unlockChannel(
    guild: Guild,
    channelId: string,
    actor: GuildMember,
    reason: string,
  ): Promise<{ channelName: string }> {
    requireUserPermissions(actor, [PermissionFlagsBits.ManageChannels], 'unlocking channels');
    requireBotPermissions(guild, [PermissionFlagsBits.ManageChannels], 'unlocking channels');
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) throw new UserFriendlyChannelError();
    await (channel as TextChannel).permissionOverwrites.edit(
      guild.roles.everyone,
      { SendMessages: null },
      { reason: `${actor.user.tag}: unlocked — ${reason}` },
    );
    return { channelName: channel.name };
  }

  /** Sets the moderation log channel and returns the updated settings. */
  async setLogChannel(
    guildId: string,
    channelId: string,
    actorId: string,
  ): Promise<{ channelId: string }> {
    await this.settings.update(
      guildId,
      'moderation',
      { logChannelId: channelId },
      { actorId, source: 'command' },
    );
    await this.settings.update(
      guildId,
      'logging',
      { enabled: true, channels: { moderation: channelId } },
      { actorId, source: 'command' },
    );
    return { channelId };
  }

  /** Clears expired cases; invoked by the scheduler. */
  async expireCases(): Promise<number> {
    return this.repos.moderation.expireCases();
  }
}

class UserFriendlyChannelError extends UserFacingError {
  constructor() {
    super('I could not find that channel.');
  }
}
