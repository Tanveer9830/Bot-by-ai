import { Events, type Client, type GuildMember, type Message } from 'discord.js';
import { evaluateNoTag, extractUserMentions, formatDuration } from '@bot-by-ai/shared';
import { resolveCustomCommand, runCustomCommand } from '../core/customCommands.js';
import type { BotServices } from '../core/context.js';
import type { GeneralSettings, NoTagSettings } from '../services/types.js';

/**
 * Message pipeline (ordered, each step is independently guarded):
 *   1. AutoMod            — delete/escalate on rule violations
 *   2. Anti-spam          — flood protection with automatic timeout
 *   3. /no-tag            — protected-user mention enforcement
 *   4. XP                 — leveling (cooldown-gated in the database)
 *   5. Prefix custom cmds — guild-scoped custom commands
 *   6. Branding           — optional, disabled by default and rate limited
 */
export function registerMessageEvents(client: Client, services: BotServices): void {
  client.on(Events.MessageCreate, async (message: Message) => {
    if (!message.inGuild() || message.author.bot || message.system) return;
    const guild = message.guild;
    const member = message.member ?? (await guild.members.fetch(message.author.id).catch(() => null));
    if (!member) return;

    try {
      // 1. AutoMod
      if (!services.features.music) {
        // (music flag is irrelevant here; kept for readability of the pipeline)
      }
      const automodOutcome = await services.automod.processMessage(message).catch((error) => {
        services.logger.warn('automod failed', { error: String(error), guildId: guild.id });
        return null;
      });
      if (automodOutcome && (automodOutcome.deleted || automodOutcome.timedOutMs > 0)) {
        // Message already actioned; continue evaluating the rest of the pipeline
        // so XP/no-tag bookkeeping stays consistent.
      }

      // 2. Anti-spam
      await services.security
        .handleSpamCheck({
          guild,
          member,
          messageCount: services.automod.messageCountInWindow(message.author.id, 6_000),
        })
        .catch(() => {});

      // 3. /no-tag
      await handleNoTag(message, member, services);

      // 4. XP
      await services.levels
        .handleMessage({
          guild,
          member,
          channelId: message.channelId,
          content: message.content,
        })
        .catch((error) => services.logger.debug('xp handling failed', { error: String(error) }));

      // 5. Prefix custom commands
      await handleCustomCommand(message, member, services);

      // 6. Branding (opt-in, rate limited)
      const branding = await services.branding.maybeRespond(message).catch(() => null);
      if (branding?.content) {
        await message.channel.send({ content: branding.content }).catch(() => {});
      }
    } catch (error) {
      services.status.recordError(error);
      services.logger.error('message pipeline failed', {
        guildId: guild.id,
        channelId: message.channelId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

async function handleNoTag(message: Message<true>, member: GuildMember, services: BotServices): Promise<void> {
  const settings = await services.settings.get<NoTagSettings>(message.guild.id, 'notag');
  if (!settings.enabled || settings.protectedUserIds.length === 0) return;

  const mentioned = extractUserMentions(message.content);
  if (!mentioned.some((id) => settings.protectedUserIds.includes(id))) return;

  const priorViolations = await services.repos.security
    .countRecentAutomodViolations(message.guild.id, message.author.id, 86_400_000)
    .catch(() => 0);

  const decision = evaluateNoTag(
    {
      content: message.content,
      authorId: message.author.id,
      channelId: message.channelId,
      authorRoleIds: [...member.roles.cache.keys()],
      repliedToUserId: message.mentions.repliedUser?.id,
      priorViolations,
      now: Date.now(),
      settings,
    },
    settings,
  );
  if (!decision.violation) return;

  await services.repos.security.recordNoTagViolation({
    guildId: message.guild.id,
    userId: message.author.id,
    channelId: message.channelId,
    messageId: message.id,
    protectedUserIds: decision.actionableUserIds,
    action: decision.shouldTimeout ? 'timeout' : decision.shouldDelete ? 'delete' : 'warn',
  });

  if (decision.shouldDelete) {
    const me = message.guild.members.me;
    const permissions = me && 'permissionsFor' in message.channel ? message.channel.permissionsFor(me) : null;
    if (permissions?.has('ManageMessages')) {
      await message.delete().catch(() => {});
    }
  }
  if (decision.shouldWarn && !decision.shouldDelete) {
    await message
      .reply({
        content: `⚠️ Please do not ping <@${decision.actionableUserIds[0]}> — they have mention protection enabled. Replying without a ping works (use the reply feature).`,
        allowedMentions: { repliedUser: false },
      })
      .catch(() => {});
  }
  if (decision.shouldTimeout && settings.timeoutMs > 0) {
    const me = message.guild.members.me;
    if (me?.permissions.has('ModerateMembers') && member.roles.highest.position < me.roles.highest.position) {
      await member.timeout(settings.timeoutMs, 'No-tag violation').catch(() => {});
    }
  }

  const logChannel = settings.logChannelId;
  const description = [
    `Author: <@${message.author.id}> (\`${message.author.id}\`)`,
    `Channel: <#${message.channelId}>`,
    `Protected user(s) mentioned: ${decision.actionableUserIds.map((id) => `<@${id}>`).join(', ')}`,
    `Message: ${message.content.slice(0, 500) || '(no text)'}`,
    `Action: delete=${decision.shouldDelete} warn=${decision.shouldWarn} timeout=${decision.shouldTimeout ? formatDuration(settings.timeoutMs) : 'no'}`,
    `Prior violations (24h window): ${priorViolations}`,
  ].join('\n');
  if (logChannel) {
    await services.logging.sendTo(message.guild, logChannel, {
      category: 'security',
      title: 'No-tag violation',
      description,
      actorId: message.author.id,
      targetId: decision.actionableUserIds[0] ?? null,
      color: 0xeb459e,
    });
  } else {
    await services.logging.log(message.guild, {
      category: 'security',
      title: 'No-tag violation',
      description,
      actorId: message.author.id,
      targetId: decision.actionableUserIds[0] ?? null,
      color: 0xeb459e,
      auditAction: 'notag.violation',
    });
  }
}
/**
 * Prefix custom commands.
 *
 * Guild-scoped commands win over global ones; published global commands are
 * available in every server. Cooldowns are per user+command and pruned so the
 * map cannot grow without bound.
 */
const customCommandCooldowns = new Map<string, number>();

async function handleCustomCommand(message: Message<true>, member: GuildMember, services: BotServices): Promise<void> {
  const settings = await services.settings.get<GeneralSettings>(message.guild.id, 'general');
  const prefix = settings.prefix || '!';
  if (!message.content.startsWith(prefix)) return;
  const [rawName, ...args] = message.content.slice(prefix.length).trim().split(/\s+/);
  if (!rawName) return;
  const name = rawName.toLowerCase();
  if (settings.disabledCommandNames.includes(name)) return;

  const command = await resolveCustomCommand(services, message.guild.id, name);
  if (!command) return;

  const payload = command.payload as { cooldownSeconds?: number };
  const cooldownMs = Math.max(0, (payload.cooldownSeconds ?? 3) * 1000);
  const cooldownKey = `${command.scope}:${command.id}:${message.guild.id}:${member.id}`;
  const last = customCommandCooldowns.get(cooldownKey) ?? 0;
  if (Date.now() - last < cooldownMs) return;
  customCommandCooldowns.set(cooldownKey, Date.now());
  if (customCommandCooldowns.size > 10_000) {
    for (const key of [...customCommandCooldowns.keys()].slice(0, 5_000)) customCommandCooldowns.delete(key);
  }

  try {
    await runCustomCommand({
      services,
      guild: message.guild,
      member,
      command,
      args: args.join(' '),
      channelId: message.channelId,
      ephemeralCapable: false,
      respond: async ({ content, embeds }) => {
        await message
          .reply({
            ...(content ? { content } : {}),
            ...(embeds && embeds.length > 0 ? { embeds } : {}),
            allowedMentions: { parse: [], repliedUser: false },
          })
          .catch(() => {});
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await message.reply({ content: `That command could not run: ${detail}` }).catch(() => {});
    return;
  }

  const shouldDelete = (command.payload as { deleteTrigger?: boolean }).deleteTrigger === true;
  if (shouldDelete) {
    const me = message.guild.members.me;
    const permissions = me && 'permissionsFor' in message.channel ? message.channel.permissionsFor(me) : null;
    if (permissions?.has('ManageMessages')) await message.delete().catch(() => {});
  }
}

export { handleCustomCommand };
