import {
  AuditLogEvent,
  ChannelType,
  Events,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildAuditLogsEntry,
  type GuildMember,
  type Message,
  type PartialGuildMember,
  type PartialMessage,
  type VoiceState,
} from 'discord.js';
import { diffPins, evaluateNoPin, type NoPinSettings } from '@bot-by-ai/shared';
import type { BotServices } from '../core/context.js';
import type { NukeEventKind } from '../services/security.js';
import type { StarboardSettings } from '../services/types.js';

/** Guild lifecycle, moderation, voice, pin and reaction handling. */
export function registerGuildEvents(client: Client, services: BotServices): void {
  // ------------------------------------------------------------ membership
  client.on(Events.GuildCreate, async (guild) => {
    await services.settings
      .ensureGuild({
        id: guild.id,
        name: guild.name,
        icon: guild.icon,
        ownerId: guild.ownerId,
        memberCount: guild.memberCount,
      })
      .catch((error) => services.logger.warn('failed to register guild', { guildId: guild.id, error: String(error) }));
    services.logger.info('joined guild', { guildId: guild.id, members: guild.memberCount });
    await services.status.heartbeat(0).catch(() => {});
  });

  client.on(Events.GuildDelete, async (guild) => {
    await services.repos.guilds.markLeft(guild.id).catch(() => {});
    services.logger.info('left guild', { guildId: guild.id });
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    await services.repos.users
      .upsertUser({
        id: member.id,
        username: member.user.username,
        globalName: member.user.globalName,
        discriminator: member.user.discriminator,
        avatar: member.user.avatar,
        isBot: member.user.bot,
      })
      .catch(() => {});
    await services.security.handleMemberJoin({ guild: member.guild, member }).catch((error) =>
      services.logger.warn('anti-raid check failed', { guildId: member.guild.id, error: String(error) }),
    );
    await services.welcome.handleJoin(member.guild, member).catch((error) =>
      services.logger.warn('welcome flow failed', { guildId: member.guild.id, error: String(error) }),
    );
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    await services.welcome.handleLeave(member.guild, member as GuildMember).catch(() => {});
    // Distinguish kicks from voluntary leaves using the audit log.
    const entry = await fetchAuditEntry(member.guild, AuditLogEvent.MemberKick, member.id).catch(() => null);
    if (entry) {
      await services.security
        .recordNukeEvent({
          guild: member.guild,
          kind: 'kick',
          actorId: entry.executorId,
          targetId: member.id,
          description: `${entry.executor?.tag ?? entry.executorId} kicked ${member.user.tag}`,
        })
        .catch(() => {});
    }
  });

  client.on(Events.GuildMemberUpdate, async (before: GuildMember | PartialGuildMember, after: GuildMember) => {
    const added = [...after.roles.cache.keys()].filter((roleId) => !before.roles.cache.has(roleId));
    const removed = [...before.roles.cache.keys()].filter((roleId) => !after.roles.cache.has(roleId));
    if (added.length === 0 && removed.length === 0 && before.nickname === after.nickname) return;
    await services.logging
      .log(after.guild, {
        category: 'members',
        title: 'Member updated',
        description: [
          `Member: <@${after.id}>`,
          added.length ? `Roles added: ${added.map((id) => `<@&${id}>`).join(', ')}` : null,
          removed.length ? `Roles removed: ${removed.map((id) => `<@&${id}>`).join(', ')}` : null,
          before.nickname !== after.nickname ? `Nickname: ${before.nickname ?? '(none)'} → ${after.nickname ?? '(none)'}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
        actorId: after.id,
        auditAction: 'members.update',
      })
      .catch(() => {});

    if (added.length > 0) {
      const entry = await fetchAuditEntry(after.guild, AuditLogEvent.MemberRoleUpdate, after.id).catch(() => null);
      await services.security
        .recordNukeEvent({
          guild: after.guild,
          kind: 'member_role_update',
          actorId: entry?.executorId ?? null,
          targetId: after.id,
          description: `Roles updated for ${after.user.tag} (${added.length} added, ${removed.length} removed)`,
          severity: 1,
          metadata: { added, removed },
        })
        .catch(() => {});
    }
  });

  client.on(Events.GuildBanAdd, async (ban) => {
    await services.repos.users
      .upsertUser({ id: ban.user.id, username: ban.user.username, isBot: ban.user.bot })
      .catch(() => {});
    const entry = await fetchAuditEntry(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id).catch(() => null);
    const actorId = entry?.executorId ?? null;
    // Actions performed by the bot's own moderation commands are already logged.
    if (actorId === client.user?.id) return;
    await services.security
      .recordNukeEvent({
        guild: ban.guild,
        kind: 'ban',
        actorId,
        targetId: ban.user.id,
        description: `${entry?.executor?.tag ?? actorId ?? 'unknown'} banned ${ban.user.tag}`,
        severity: 2,
      })
      .catch(() => {});
  });

  client.on(Events.GuildBanRemove, async (ban) => {
    await services.logging
      .log(ban.guild, {
        category: 'moderation',
        title: 'Member unbanned',
        description: `<@${ban.user.id}> was unbanned.`,
        targetId: ban.user.id,
        auditAction: 'moderation.unban',
      })
      .catch(() => {});
  });

  // ------------------------------------------------------------ audit log
  client.on(Events.GuildAuditLogEntryCreate, async (entry: GuildAuditLogsEntry, guild: Guild) => {
    try {
      const mapping: Partial<Record<AuditLogEvent, NukeEventKind>> = {
        [AuditLogEvent.ChannelDelete]: 'channel_delete',
        [AuditLogEvent.ChannelCreate]: 'channel_create',
        [AuditLogEvent.RoleDelete]: 'role_delete',
        [AuditLogEvent.RoleCreate]: 'role_create',
        [AuditLogEvent.WebhookCreate]: 'webhook_create',
        [AuditLogEvent.ChannelOverwriteUpdate]: 'permission_change',
        [AuditLogEvent.ChannelOverwriteCreate]: 'permission_change',
        [AuditLogEvent.RoleUpdate]: 'permission_change',
        [AuditLogEvent.BotAdd]: 'bot_add',
        [AuditLogEvent.MessageDelete]: null as never,
      };
      const kind = mapping[entry.action];
      if (!kind) return;
      if (entry.executorId === client.user?.id) return;
      const targetId = typeof entry.targetId === 'string' ? entry.targetId : null;

      // Only permission-relevant role updates are interesting (not colour changes).
      if (entry.action === AuditLogEvent.RoleUpdate) {
        const changes = entry.changes ?? [];
        const permissionChange = changes.find(
          (change) => change.key === 'permissions' || change.key === 'name' || change.key === '$add',
        );
        if (!permissionChange) return;
      }

      const description = `${entry.executor?.tag ?? entry.executorId ?? 'unknown'} performed ${AuditLogEvent[entry.action]}${
        targetId ? ` on ${targetId}` : ''
      }`;

      await services.security.recordNukeEvent({
        guild,
        kind,
        actorId: entry.executorId,
        targetId,
        description,
        severity: ['channel_delete', 'role_delete', 'permission_change'].includes(kind) ? 3 : 2,
        metadata: { auditLogAction: entry.action, changes: entry.changes?.slice(0, 5) },
      });

      if (kind === 'channel_delete' || kind === 'role_delete' || kind === 'permission_change') {
        await services.logging.log(guild, {
          category: 'channels',
          title: `Audit: ${AuditLogEvent[entry.action]}`,
          description,
          actorId: entry.executorId,
          targetId,
          color: 0xeb459e,
          auditAction: `audit.${AuditLogEvent[entry.action]}`,
        });
      }
    } catch (error) {
      services.logger.warn('audit log handling failed', { guildId: guild.id, error: String(error) });
    }
  });

  // ------------------------------------------------------------ pin monitor
  client.on(Events.ChannelPinsUpdate, async (channel) => {
    try {
      if (channel.isDMBased()) return;
      const guild = channel.guild;
      if (!channel.isTextBased()) return;
      const settings = await services.settings.get<NoPinSettings>(guild.id, 'nopin');
      if (!settings.enabled) return;
      const pins = await channel.messages.fetchPinned().catch(() => null);
      if (!pins) return;
      const current = [...pins.keys()];
      const previous = pinCache.get(channel.id) ?? [];
      const { pinned, unpinned } = diffPins(previous, current);
      pinCache.set(channel.id, current);
      if (pinned.length === 0 && unpinned.length === 0) return;

      for (const [action, messageIds] of [['pin', pinned], ['unpin', unpinned]] as const) {
        for (const messageId of messageIds) {
          const message = pins.get(messageId) ?? (await channel.messages.fetch(messageId).catch(() => null));
          const entry = await fetchAuditEntry(
            guild,
            action === 'pin' ? AuditLogEvent.MessagePin : AuditLogEvent.MessageUnpin,
            messageId,
          ).catch(() => null);
          const decision = evaluateNoPin(
            {
              action,
              channelId: channel.id,
              messageId,
              messageAuthorId: message?.author?.id ?? undefined,
              actorId: entry?.executorId ?? undefined,
              actorRoleIds: entry?.executor ? [...(await guild.members.fetch(entry.executorId as string).catch(() => null))?.roles.cache.keys() ?? []] : undefined,
              actorIsBot: entry?.executor?.bot ?? false,
              actorIsModerator: false,
              now: Date.now(),
            },
            settings,
          );
          if (!decision.violation) continue;

          await services.repos.security.recordNoPinEvent({
            guildId: guild.id,
            channelId: channel.id,
            messageId,
            action,
            actorId: decision.actorId ?? null,
            messageAuthorId: message?.author?.id ?? null,
            outcome: decision.shouldRevert ? 'reverted' : decision.shouldAlert ? 'alerted' : 'logged',
          });

          if (decision.shouldRevert && action === 'pin') {
            const me = guild.members.me;
            if (me?.permissions.has(PermissionFlagsBits.ManageMessages) && message) {
              await message.unpin().catch(() => {});
            }
          }
          await services.logging.log(guild, {
            category: 'security',
            title: `Pin protection: ${action}`,
            description: `${decision.reason}\nChannel: <#${channel.id}>${message ? `\nAuthor: <@${message.author.id}>` : ''}`,
            color: 0xeb459e,
            actorId: decision.actorId ?? null,
            targetId: message?.author?.id ?? null,
            auditAction: 'nopin.event',
          });
        }
      }
    } catch (error) {
      services.logger.warn('pin monitoring failed', { error: String(error) });
    }
  });

  // ------------------------------------------------------------ messages
  client.on(Events.MessageDelete, async (message: Message | PartialMessage) => {
    if (!message.inGuild() || message.author?.bot) return;
    await services.logging
      .log(message.guild, {
        category: 'messages',
        title: 'Message deleted',
        description: [
          `Author: ${message.author ? `<@${message.author.id}>` : 'unknown'}`,
          `Channel: <#${message.channelId}>`,
          `Content: ${(message.content ?? '(not cached)').slice(0, 900)}`,
        ].join('\n'),
        actorId: message.author?.id ?? null,
        auditAction: 'messages.delete',
      })
      .catch(() => {});
  });

  client.on(Events.MessageUpdate, async (_before: Message | PartialMessage, after: Message | PartialMessage) => {
    if (!after.inGuild() || after.author?.bot) return;
    const before = _before as Message;
    if ((before.content ?? '') === (after.content ?? '')) return;
    await services.logging
      .log(after.guild, {
        category: 'messages',
        title: 'Message edited',
        description: [
          `Author: <@${after.author?.id ?? 'unknown'}>`,
          `Channel: <#${after.channelId}>`,
          `Before: ${(before.content ?? '(not cached)').slice(0, 800)}`,
          `After: ${(after.content ?? '(not cached)').slice(0, 800)}`,
          `Jump: ${after.url}`,
        ].join('\n'),
        actorId: after.author?.id ?? null,
        auditAction: 'messages.update',
      })
      .catch(() => {});
  });

  // ------------------------------------------------------------ voice + XP
  client.on(Events.VoiceStateUpdate, async (oldState: VoiceState, newState: VoiceState) => {
    const guild = newState.guild;
    const member = newState.member;
    if (!member || member.user.bot) return;

    const joined = !oldState.channelId && newState.channelId;
    const left = oldState.channelId && !newState.channelId;
    if (joined || left) {
      await services.logging
        .log(guild, {
          category: 'voice',
          title: joined ? 'Voice channel joined' : 'Voice channel left',
          description: [
            `Member: <@${member.id}>`,
            `Channel: <#${joined ? newState.channelId : oldState.channelId}>`,
          ].join('\n'),
          actorId: member.id,
          auditAction: joined ? 'voice.join' : 'voice.leave',
        })
        .catch(() => {});
    }

    // Voice XP tick: award for members with 2+ humans in a channel.
    if (newState.channelId && newState.channel) {
      const humans = newState.channel.members.filter((voiceMember) => !voiceMember.user.bot).size;
      if (humans >= 2) {
        voiceTick.set(member.id, (voiceTick.get(member.id) ?? 0) + 1);
        if ((voiceTick.get(member.id) ?? 0) >= 3) {
          voiceTick.set(member.id, 0);
          await services.levels
            .handleVoiceMinute({ guild, member, minutes: 3 })
            .catch(() => {});
        }
      }
    }
  });

  // ------------------------------------------------------------ reactions
  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    try {
      if (user.bot) return;
      if (reaction.partial) await reaction.fetch().catch(() => null);
      const message = reaction.message;
      if (!message.inGuild()) return;
      const guild = message.guild;
      const settings = await services.settings.get<StarboardSettings>(guild.id, 'starboard');
      if (settings.enabled && reaction.emoji.name === settings.emoji) {
        const count = reaction.count ?? 0;
        await services.community.handleStarboard({
          guild,
          message: message as Message<true>,
          starCount: count,
        });
      }

      // Reaction roles (legacy reaction mode panels).
      const panel = await services.repos.community.findReactionRolePanelByMessage(message.id).catch(() => null);
      if (panel && panel.guild_id === guild.id) {
        const options = panel.options as { emoji?: string | null; roleId: string }[];
        const matched = options.find(
          (option) => option.emoji && (option.emoji === reaction.emoji.name || option.emoji === `<:${reaction.emoji.name}:${reaction.emoji.id}>`),
        );
        if (matched) {
          const member = await guild.members.fetch(user.id).catch(() => null);
          const role = await guild.roles.fetch(matched.roleId).catch(() => null);
          const me = guild.members.me;
          if (member && role && me && role.position < me.roles.highest.position) {
            await member.roles.add(role, 'Reaction role').catch(() => {});
          }
        }
      }
    } catch (error) {
      services.logger.warn('reaction handler failed', { error: String(error) });
    }
  });

  client.on(Events.MessageReactionRemove, async (reaction, user) => {
    try {
      if (user.bot) return;
      if (reaction.partial) await reaction.fetch().catch(() => null);
      const message = reaction.message;
      if (!message.inGuild()) return;
      const guild = message.guild;
      const settings = await services.settings.get<StarboardSettings>(guild.id, 'starboard');
      if (settings.enabled && reaction.emoji.name === settings.emoji) {
        await services.community.handleStarboard({
          guild,
          message: message as Message<true>,
          starCount: Math.max(0, (reaction.count ?? 1) - 1),
        });
      }
      const panel = await services.repos.community.findReactionRolePanelByMessage(message.id).catch(() => null);
      if (panel && panel.guild_id === guild.id) {
        const options = panel.options as { emoji?: string | null; roleId: string }[];
        const matched = options.find(
          (option) => option.emoji && (option.emoji === reaction.emoji.name || option.emoji === `<:${reaction.emoji.name}:${reaction.emoji.id}>`),
        );
        if (matched) {
          const member = await guild.members.fetch(user.id).catch(() => null);
          const role = await guild.roles.fetch(matched.roleId).catch(() => null);
          const me = guild.members.me;
          if (member && role && me && role.position < me.roles.highest.position) {
            await member.roles.remove(role, 'Reaction role removed').catch(() => {});
          }
        }
      }
    } catch (error) {
      services.logger.warn('reaction removal handler failed', { error: String(error) });
    }
  });

  // ------------------------------------------------------------ webhooks
  client.on(Events.WebhooksUpdate, async (channel) => {
    if (!channel.guild) return;
    await services.logging
      .log(channel.guild, {
        category: 'security',
        title: 'Webhooks updated',
        description: `Webhooks were created, edited or deleted in <#${channel.id}>. Check Server Settings → Integrations to confirm this was expected.`,
        auditAction: 'webhooks.update',
        color: 0xeb459e,
      })
      .catch(() => {});
  });
}

const pinCache = new Map<string, string[]>();
const voiceTick = new Map<string, number>();

async function fetchAuditEntry(
  guild: Guild,
  type: AuditLogEvent,
  targetId: string | undefined,
): Promise<GuildAuditLogsEntry | null> {
  const logs = await guild.fetchAuditLogs({ type, limit: 5 }).catch(() => null);
  if (!logs) return null;
  const now = Date.now();
  const entry = logs.entries.find((candidate) => {
    if (targetId && candidate.targetId !== targetId) return false;
    // Audit log entries older than ~15s are unlikely to belong to this event.
    return now - (candidate.createdTimestamp ?? 0) < 15_000;
  });
  return entry ?? null;
}

export function isWritableChannel(type: ChannelType): boolean {
  return [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread].includes(type);
}
