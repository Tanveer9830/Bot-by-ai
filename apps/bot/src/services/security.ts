import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type TextChannel,
} from 'discord.js';
import type { Logger } from '@bot-by-ai/shared';
import { accountAgeDays, formatDuration, UserFacingError } from '@bot-by-ai/shared';
import type { Repositories } from '@bot-by-ai/database';
import type { GuildSettingsService } from './settings.js';
import type { SecuritySettings } from './types.js';
import type { LoggingService } from './logging.js';

/** Anti-nuke event kinds, mapped to the counters in security settings. */
export type NukeEventKind =
  | 'ban'
  | 'kick'
  | 'channel_delete'
  | 'channel_create'
  | 'role_delete'
  | 'role_create'
  | 'webhook_create'
  | 'permission_change'
  | 'member_role_update'
  | 'bot_add'
  | 'everyone_mention'
  | 'lockdown';

export interface SecurityEventInput {
  guild: Guild;
  kind: NukeEventKind;
  actorId?: string | null;
  targetId?: string | null;
  description: string;
  severity?: 1 | 2 | 3;
  metadata?: Record<string, unknown>;
}

export interface SecurityVerdict {
  logged: boolean;
  breached: boolean;
  threshold: number;
  observed: number;
  action?: 'alert' | 'remove_roles' | 'ban' | 'lockdown' | 'kick_new' | 'ban_new';
  detail?: string;
}

/**
 * Server security subsystem.
 *
 * Honest scope: the bot reacts to gateway events and audit-log entries *after*
 * Discord has already performed the action. It cannot pre-empt a ban, role or
 * channel deletion. Mitigations are therefore: detect, alert, contain (lockdown,
 * role removal, ban of the offending actor) and report — never "undo".
 */
export class SecurityService {
  private readonly lockdownRestore = new Map<string, string[]>();

  constructor(
    private readonly repos: Repositories,
    private readonly settings: GuildSettingsService,
    private readonly logging: LoggingService,
    private readonly logger: Logger,
  ) {}

  async getSettings(guildId: string): Promise<SecuritySettings> {
    return this.settings.get<SecuritySettings>(guildId, 'security');
  }

  private thresholdFor(settings: SecuritySettings, kind: NukeEventKind): number {
    const t = settings.antiNuke.thresholds;
    switch (kind) {
      case 'ban':
        return t.bans;
      case 'kick':
        return t.kicks;
      case 'channel_delete':
        return t.channelDeletes;
      case 'channel_create':
        return t.channelCreates;
      case 'role_delete':
        return t.roleDeletes;
      case 'role_create':
        return t.roleCreates;
      case 'webhook_create':
        return t.webhookCreates;
      case 'permission_change':
        return t.permissionChanges;
      case 'member_role_update':
        return t.memberRoleUpdates;
      default:
        return Number.MAX_SAFE_INTEGER;
    }
  }

  /** True when the actor should be ignored by anti-nuke/anti-raid (staff, trusted, owner). */
  async isTrusted(guild: Guild, userId: string, memberRoleIds: string[] | undefined): Promise<boolean> {
    if (userId === guild.ownerId) return true;
    const settings = await this.getSettings(guild.id);
    if (settings.trustedUserIds.includes(userId)) return true;
    if (memberRoleIds && settings.trustedRoleIds.some((roleId) => memberRoleIds.includes(roleId))) return true;
    if (await this.repos.security.isTrusted(guild.id, 'user', userId)) return true;
    for (const roleId of memberRoleIds ?? []) {
      if (await this.repos.security.isTrusted(guild.id, 'role', roleId)) return true;
    }
    return false;
  }

  /**
   * Records an anti-nuke event and evaluates thresholds for that actor within
   * the configured window. Returns the verdict so callers can react.
   */
  async recordNukeEvent(input: SecurityEventInput & { actorRoleIds?: string[] }): Promise<SecurityVerdict> {
    const settings = await this.getSettings(input.guild.id);
    if (!settings.enabled || !settings.antiNuke.enabled) {
      return { logged: false, breached: false, threshold: 0, observed: 0 };
    }
    const actorId = input.actorId ?? null;
    if (actorId) {
      if (await this.isTrusted(input.guild, actorId, input.actorRoleIds)) {
        return { logged: false, breached: false, threshold: 0, observed: 0 };
      }
      const member = await input.guild.members.fetch(actorId).catch(() => null);
      if (member?.permissions.has(PermissionFlagsBits.Administrator) && settings.trustedUserIds.includes(actorId)) {
        return { logged: false, breached: false, threshold: 0, observed: 0 };
      }
    }

    const eventId = await this.repos.security.logEvent({
      guildId: input.guild.id,
      kind: input.kind,
      severity: input.severity ?? 2,
      actorId,
      targetId: input.targetId ?? null,
      description: input.description,
      metadata: input.metadata,
    });

    const threshold = this.thresholdFor(settings, input.kind);
    const observed = await this.repos.security.countRecentEvents({
      guildId: input.guild.id,
      kind: input.kind,
      actorId,
      windowMs: settings.antiNuke.windowMs,
    });

    const breached = threshold !== Number.MAX_SAFE_INTEGER && observed >= threshold;
    const verdict: SecurityVerdict = {
      logged: true,
      breached,
      threshold,
      observed,
      action: breached ? settings.antiNuke.response : 'alert',
    };

    await this.logging.logSecurity(input.guild, {
      title: breached ? `Threshold exceeded: ${input.kind}` : `Security event: ${input.kind}`,
      description: `${input.description}\nActor: ${actorId ? `<@${actorId}>` : 'unknown (no audit-log entry)'}\nObserved ${observed}/${threshold} in ${formatDuration(settings.antiNuke.windowMs)}`,
      severity: breached ? 3 : (input.severity ?? 2),
      actorId,
      targetId: input.targetId ?? null,
      kind: input.kind,
    });

    if (breached) {
      await this.respondToBreach(input.guild, settings, verdict, actorId, input.kind, eventId);
    }
    return verdict;
  }

  private async respondToBreach(
    guild: Guild,
    settings: SecuritySettings,
    verdict: SecurityVerdict,
    actorId: string | null,
    kind: NukeEventKind,
    eventId: number,
  ): Promise<void> {
    const me = guild.members.me;
    if (settings.antiNuke.autoLockdown) {
      await this.lockdown(guild, settings.antiNuke.lockdownMinutes, `Automatic lockdown after ${kind} threshold breach`, actorId ?? 'system').catch(
        (error) => this.logger.error('automatic lockdown failed', { guildId: guild.id, error: String(error) }),
      );
      verdict.action = 'lockdown';
    }
    if (actorId && me) {
      if (settings.antiNuke.response === 'ban') {
        const target = await guild.members.fetch(actorId).catch(() => null);
        if (target && target.id !== guild.ownerId && target.roles.highest.position < me.roles.highest.position) {
          await guild.bans
            .create(actorId, { reason: `Anti-nuke: ${kind} threshold breached (${verdict.observed} events)` })
            .catch(() => {});
          verdict.detail = 'actor banned';
        } else {
          verdict.detail = 'actor could not be banned (hierarchy)';
        }
      } else if (settings.antiNuke.response === 'remove_roles') {
        const target = await guild.members.fetch(actorId).catch(() => null);
        if (target && target.id !== guild.ownerId) {
          const removable = target.roles.cache.filter(
            (role) => role.id !== guild.id && role.position < me.roles.highest.position && role.managed === false,
          );
          await target.roles.remove(removable, 'Anti-nuke: dangerous roles removed').catch(() => {});
          verdict.detail = `removed ${removable.size} role(s)`;
        }
      }
    }
    await this.repos.security.markHandled(guild.id, eventId, false).catch(() => {});
  }

  /**
   * Anti-raid join monitoring. Tracks joins in a sliding window per guild using
   * the security_events table so the state is shared across restarts/shards.
   */
  async handleMemberJoin(input: { guild: Guild; member: GuildMember }): Promise<SecurityVerdict> {
    const settings = await this.getSettings(input.guild.id);
    if (!settings.enabled || !settings.antiRaid.enabled) {
      return { logged: false, breached: false, threshold: 0, observed: 0 };
    }
    const ageDays = accountAgeDays(input.member.id);
    const youngAccount = ageDays < settings.antiRaid.minAccountAgeDays;

    await this.repos.security.logEvent({
      guildId: input.guild.id,
      kind: 'member_join',
      severity: youngAccount ? 2 : 1,
      actorId: input.member.id,
      description: `Join: ${input.member.user.tag} (account age ${ageDays.toFixed(1)} days)`,
      metadata: { accountAgeDays: Number(ageDays.toFixed(2)) },
    });

    const observed = await this.repos.security.countRecentEvents({
      guildId: input.guild.id,
      kind: 'member_join',
      windowMs: settings.antiRaid.joinsWindowMs,
      actorId: null,
    });
    const breached = observed >= settings.antiRaid.joinsThreshold;
    const verdict: SecurityVerdict = {
      logged: true,
      breached,
      threshold: settings.antiRaid.joinsThreshold,
      observed,
      action: breached ? settings.antiRaid.response : 'alert',
    };

    if (breached) {
      await this.logging.logSecurity(input.guild, {
        title: 'Possible raid detected',
        description: `${observed} joins in ${formatDuration(settings.antiRaid.joinsWindowMs)} (threshold ${settings.antiRaid.joinsThreshold}). Response: ${settings.antiRaid.response}`,
        severity: 3,
        kind: 'raid',
      });
      await this.respondToRaid(input.guild, settings, input.member);
    } else if (youngAccount && settings.antiRaid.blockNewAccounts) {
      const me = input.guild.members.me;
      if (me && input.member.roles.highest.position < me.roles.highest.position) {
        await input.member
          .kick(`Account age ${ageDays.toFixed(1)}d is below the configured minimum of ${settings.antiRaid.minAccountAgeDays}d`)
          .catch(() => {});
        verdict.detail = 'new account kicked by policy';
      }
    }
    return verdict;
  }

  private async respondToRaid(guild: Guild, settings: SecuritySettings, newMember: GuildMember): Promise<void> {
    switch (settings.antiRaid.response) {
      case 'lockdown':
        await this.lockdown(guild, settings.antiRaid.lockdownMinutes, 'Automatic raid lockdown', 'system').catch(() => {});
        break;
      case 'kick_new': {
        const me = guild.members.me;
        if (me && newMember.roles.highest.position < me.roles.highest.position) {
          await newMember.kick('Anti-raid response: kick_new').catch(() => {});
        }
        break;
      }
      case 'ban_new': {
        const me = guild.members.me;
        if (me && newMember.roles.highest.position < me.roles.highest.position) {
          await guild.bans.create(newMember.id, { reason: 'Anti-raid response: ban_new' }).catch(() => {});
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * Locks the server down: denies SendMessages for @everyone on all writable
   * text channels except the configured allow-list. The list of modified
   * channels is stored in the security event metadata so `/security lockdown off`
   * can restore exactly those channels.
   */
  async lockdown(
    guild: Guild,
    minutes: number,
    reason: string,
    actorId: string | null,
  ): Promise<{ channels: number; until: number }> {
    const settings = await this.getSettings(guild.id);
    if (settings.lockdown.active) {
      throw new UserFacingError('A lockdown is already active in this server.');
    }
    const me = guild.members.me;
    if (!me || !me.permissions.has(PermissionFlagsBits.ManageChannels)) {
      throw new UserFacingError('I need the Manage Channels permission to lock the server down.');
    }
    const channels = guild.channels.cache.filter(
      (channel): channel is TextChannel =>
        channel.type === ChannelType.GuildText &&
        !settings.lockdown.allowedChannelIds.includes(channel.id) &&
        channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageChannels) === true,
    );
    const modified: string[] = [];
    for (const channel of channels.values()) {
      const success = await channel
        .permissionOverwrites.edit(
          guild.roles.everyone,
          { SendMessages: false },
          { reason: `Lockdown: ${reason}` },
        )
        .then(() => true)
        .catch(() => false);
      if (success) modified.push(channel.id);
    }
    const until = Date.now() + Math.max(1, minutes) * 60_000;
    await this.settings.update(
      guild.id,
      'security',
      {
        lockdown: {
          ...settings.lockdown,
          active: true,
          until,
          reason,
        },
      },
      { actorId, source: 'system' },
    );
    this.lockdownRestore.set(guild.id, modified);
    await this.repos.security.logEvent({
      guildId: guild.id,
      kind: 'lockdown',
      severity: 3,
      actorId,
      description: `Lockdown started: ${reason}`,
      metadata: { channels: modified, until, allowedOverrides: settings.lockdown.allowedChannelIds },
    });
    await this.logging.logSecurity(guild, {
      title: 'Server lockdown activated',
      description: `${reason}\nLocked ${modified.length} channel(s) until <t:${Math.floor(until / 1000)}:R>.`,
      severity: 3,
      actorId,
      kind: 'lockdown',
    });
    return { channels: modified.length, until };
  }

  async liftLockdown(guild: Guild, actorId: string | null): Promise<{ channels: number }> {
    const settings = await this.getSettings(guild.id);
    let channelIds = this.lockdownRestore.get(guild.id) ?? [];
    if (channelIds.length === 0) {
      // Recover the channel list from the last lockdown event (survives restarts).
      const event = await this.repos.security.findLatestEvent(guild.id, 'lockdown');
      const metadata = event?.metadata as { channels?: string[] } | null | undefined;
      channelIds = metadata?.channels ?? [];
      if (channelIds.length === 0) {
        // Fall back to every non-allowed text channel so the unlock still works.
        channelIds = guild.channels.cache
          .filter(
            (channel) =>
              channel.type === ChannelType.GuildText && !settings.lockdown.allowedChannelIds.includes(channel.id),
          )
          .map((channel) => channel.id);
      }
    }
    let restored = 0;
    for (const channelId of channelIds) {
      const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
      if (channel && channel.type === ChannelType.GuildText) {
        const success = await channel
          .permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null }, { reason: 'Lockdown lifted' })
          .then(() => true)
          .catch(() => false);
        if (success) restored += 1;
      }
    }
    this.lockdownRestore.delete(guild.id);
    await this.settings.update(
      guild.id,
      'security',
      { lockdown: { ...settings.lockdown, active: false, until: null, reason: null } },
      { actorId, source: 'system' },
    );
    await this.logging.logSecurity(guild, {
      title: 'Server lockdown lifted',
      description: `Unlocked ${restored} channel(s).`,
      severity: 2,
      actorId,
      kind: 'lockdown_lifted',
    });
    return { channels: restored };
  }

  /**
   * Scheduler hook: lifts lockdowns whose `until` timestamp has passed so a
   * temporary lockdown cannot outlive its window.
   */
  async expireLockdowns(client: import('discord.js').Client): Promise<number> {
    const active = await this.repos.security.listActiveLockdowns();
    let lifted = 0;
    for (const row of active) {
      if (row.until === null || row.until > Date.now()) continue;
      const guild = client.guilds.cache.get(row.guild_id) ?? (await client.guilds.fetch(row.guild_id).catch(() => null));
      if (!guild) continue;
      await this.liftLockdown(guild, null).then(() => {
        lifted += 1;
      }).catch((error) => {
        this.logger.warn('failed to lift expired lockdown', {
          guildId: row.guild_id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return lifted;
  }

  /** Anti-spam: timeout members exceeding the message rate. */
  async handleSpamCheck(input: {
    guild: Guild;
    member: GuildMember;
    messageCount: number;
  }): Promise<{ timedOut: boolean }> {
    const settings = await this.getSettings(input.guild.id);
    if (!settings.enabled || !settings.antiSpam.enabled) return { timedOut: false };
    if (await this.isTrusted(input.guild, input.member.id, [...input.member.roles.cache.keys()])) {
      return { timedOut: false };
    }
    if (input.messageCount < settings.antiSpam.messagesPerWindow) return { timedOut: false };
    const me = input.guild.members.me;
    if (!me || !me.permissions.has(PermissionFlagsBits.ModerateMembers)) return { timedOut: false };
    if (input.member.roles.highest.position >= me.roles.highest.position) return { timedOut: false };

    await this.repos.security.logEvent({
      guildId: input.guild.id,
      kind: 'anti_spam',
      severity: 2,
      actorId: input.member.id,
      description: `${input.messageCount} messages in ${formatDuration(settings.antiSpam.windowMs)}`,
    });
    if (settings.antiSpam.timeoutMs > 0) {
      await input.member
        .timeout(settings.antiSpam.timeoutMs, `AutoMod: message flooding (${input.messageCount} messages)`)
        .catch(() => {});
    }
    await this.logging.logSecurity(input.guild, {
      title: 'Message flood detected',
      description: `<@${input.member.id}> sent ${input.messageCount} messages in ${formatDuration(settings.antiSpam.windowMs)}. Timeout applied: ${settings.antiSpam.timeoutMs > 0 ? formatDuration(settings.antiSpam.timeoutMs) : 'no'}.`,
      severity: 2,
      actorId: input.member.id,
      kind: 'anti_spam',
    });
    return { timedOut: settings.antiSpam.timeoutMs > 0 };
  }

  /** Flags suspicious account joins for manual review (new/low-age accounts). */
  async suspiciousAccountReport(guildId: string, days = 7): Promise<{ joins: number; young: number }> {
    const events = await this.repos.security.listEvents(guildId, { kinds: ['member_join'], limit: 200 });
    const cutoff = Date.now() - days * 86_400_000;
    const recent = events.rows.filter((row) => row.created_at.getTime() >= cutoff);
    const young = recent.filter((row) => {
      const metadata = row.metadata as { accountAgeDays?: number } | null;
      return (metadata?.accountAgeDays ?? 999) < 7;
    });
    return { joins: recent.length, young: young.length };
  }
}
