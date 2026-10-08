import {
  GuildMember,
  PermissionsBitField,
  type ChatInputCommandInteraction,
  type Guild,
  type InteractionReplyOptions,
  type Message,
  type PermissionResolvable,
  type User,
} from 'discord.js';
import { checkModerationHierarchy, PermissionError, UserFacingError } from '@bot-by-ai/shared';
import type { BotServices } from './context.js';
import { errorEmbed } from './embeds.js';

export interface ResolvedTarget {
  /** Present when the target is currently in the guild. */
  member: GuildMember | null;
  user: User;
  id: string;
}

/**
 * Resolves the `target` option of a slash command into a member/user pair.
 * Works for members who left the guild (ban targets) as well.
 */
export async function resolveTarget(
  interaction: ChatInputCommandInteraction,
  optionName = 'target',
): Promise<ResolvedTarget> {
  const member = interaction.options.getMember(optionName) as GuildMember | null;
  const user =
    interaction.options.getUser(optionName) ??
    (await interaction.client.users
      .fetch(interaction.options.getUser(optionName)?.id ?? '')
      .catch(() => null));
  if (member) return { member, user: member.user, id: member.id };
  if (user) return { member: null, user, id: user.id };
  throw new UserFacingError(
    'I could not resolve that user. Provide an ID or mention if they left the server.',
  );
}

function highestRolePosition(member: GuildMember | null, guild: Guild): number {
  if (!member) return 0;
  if (member.id === guild.ownerId) return Number.MAX_SAFE_INTEGER;
  return member.roles.highest.position;
}

/**
 * Applies the shared hierarchy rules (actor cannot target superiors, the bot
 * cannot act above its own top role, server owner is protected). This is the
 * single place the bot decides whether a destructive action is allowed.
 */
export function assertCanModerate(options: {
  guild: Guild;
  actor: GuildMember;
  target: GuildMember | null;
  targetUser?: User;
  botMember: GuildMember | null;
  isBotOwner?: boolean;
  action: string;
}): void {
  const { guild, actor, target, botMember } = options;
  const targetId = target?.id ?? options.targetUser?.id ?? 'unknown';
  const decision = checkModerationHierarchy({
    actor: {
      id: actor.id,
      highestRolePosition: highestRolePosition(actor, guild),
      isGuildOwner: actor.id === guild.ownerId,
      isBotOwner: options.isBotOwner,
    },
    target: {
      id: targetId,
      highestRolePosition: target ? highestRolePosition(target, guild) : 0,
      isGuildOwner: targetId === guild.ownerId,
      isBot: target?.user.bot ?? options.targetUser?.bot ?? false,
    },
    bot: botMember
      ? {
          id: botMember.id,
          highestRolePosition: highestRolePosition(botMember, guild),
          isGuildOwner: false,
        }
      : undefined,
    guildOwnerId: guild.ownerId,
  });
  if (!decision.allowed) {
    throw new PermissionError(
      decision.reason ?? `You cannot use ${options.action} on that member.`,
      {
        action: options.action,
        targetId,
        code: decision.code,
      },
    );
  }
}

/** Requires the invoking member to hold specific Discord permissions. */
export function requireUserPermissions(
  member: GuildMember | null,
  required: PermissionResolvable[],
  context: string,
): void {
  if (!member) throw new PermissionError('This command can only be used inside a server.');
  const missing = required.filter((permission) => !member.permissions.has(permission));
  if (missing.length > 0) {
    const names = missing.map((permission) =>
      new PermissionsBitField(permission).toArray().join('/'),
    );
    throw new PermissionError(`You need the ${names.join(', ')} permission to use ${context}.`, {
      missing: names,
    });
  }
}

/** Verifies the bot itself can act (permissions + hierarchy) before trying. */
export function requireBotPermissions(
  guild: Guild,
  required: PermissionResolvable[],
  context: string,
): GuildMember | null {
  const me = guild.members.me;
  if (!me) return null;
  const missing = required.filter((permission) => !me.permissions.has(permission));
  if (missing.length > 0) {
    const names = missing.map((permission) =>
      new PermissionsBitField(permission).toArray().join('/'),
    );
    throw new PermissionError(
      `I am missing the ${names.join(', ')} permission needed for ${context}. Grant it in Server Settings → Roles.`,
      { missing: names },
    );
  }
  return me;
}

/**
 * Central command error handler. Expected errors (`AppError.expected`) are shown
 * to the user; unexpected ones are logged and reported generically so internal
 * details and secrets never leak into chat.
 */
export async function replyWithError(
  interaction: ChatInputCommandInteraction,
  error: unknown,
  services: BotServices,
): Promise<void> {
  const isExpected = (error as { expected?: boolean }).expected === true;
  const message =
    isExpected && error instanceof Error
      ? error.message.replace(/^[A-Z_]+: /, '')
      : 'Something went wrong while running that command. The error has been logged.';
  const payload: InteractionReplyOptions = { embeds: [errorEmbed(message)], ephemeral: true };
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload).catch(() => {});
  } else {
    await interaction.reply(payload).catch(() => {});
  }
  if (!isExpected) {
    services.logger.error('command failed', {
      command: interaction.commandName,
      guildId: interaction.guildId,
      userId: interaction.user.id,
      error:
        error instanceof Error ? error.stack?.split('\n').slice(0, 5).join(' | ') : String(error),
    });
    if (interaction.guild) {
      await services.logging
        .logBotError(interaction.guild, {
          command: interaction.commandName,
          message: error instanceof Error ? error.message : String(error),
          userId: interaction.user.id,
        })
        .catch(() => {});
    }
  }
}

export function interactionReplyLine(message: Message): string {
  return `${message.author.tag}: ${message.content.slice(0, 100)}`;
}

/** Marks an embed as belonging to a specific guild/user for auditability. */
export function actorLine(userId: string): string {
  return `Actor: <@${userId}> (\`${userId}\`)`;
}
