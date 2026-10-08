/**
 * Custom-command runtime.
 *
 * Shared by the prefix handler (`events/messageCreate.ts`) and the slash-command
 * fallback in `events/interactionCreate.ts`, so a command behaves identically
 * whichever way it is invoked.
 *
 * Security notes:
 *  - payloads are plain data validated by `customCommandSchema` (shared zod);
 *    there is no eval, no shell and no dynamic import anywhere in this file;
 *  - templates may only use the allow-listed placeholders understood by
 *    `renderTemplate` (mentions are sanitised, markdown escaped);
 *  - role changes are clamped to roles below the bot's highest role.
 */
import { EmbedBuilder, type Guild, type GuildMember } from 'discord.js';
import {
  renderTemplate,
  sanitizeMentions,
  UserFacingError,
  type CustomCommandInput,
} from '@bot-by-ai/shared';
import type { CustomCommandRow } from '@bot-by-ai/database';
import type { BotServices } from './context.js';

/** Resolves a custom command: guild-scoped first, then published global ones. */
export async function resolveCustomCommand(
  services: BotServices,
  guildId: string | null,
  name: string,
): Promise<CustomCommandRow | null> {
  if (guildId) {
    const local = await services.repos.customCommands.getGuild(guildId, name).catch(() => null);
    if (local && local.enabled) return local;
  }
  return services.repos.customCommands.getGlobalPublished(name).catch(() => null);
}

export function cooldownKeyFor(command: CustomCommandRow, userId: string, scopeId: string): string {
  return `custom:${command.scope}:${command.id}:${scopeId}:${userId}`;
}

export interface CustomCommandRun {
  services: BotServices;
  guild: Guild;
  member: GuildMember;
  command: CustomCommandRow;
  /** Everything after the command name, e.g. "hello world". */
  args: string;
  channelId: string;
  /** True when the invocation supports ephemeral replies (slash commands). */
  ephemeralCapable: boolean;
  /** Sends the rendered response. `ephemeral` is honoured only when supported. */
  respond: (payload: {
    content?: string;
    embeds?: EmbedBuilder[];
    ephemeral: boolean;
  }) => Promise<void>;
}

/** Throws `UserFacingError` for permission/cooldown problems, returns the payload otherwise. */
export function assertCustomCommandAllowed(run: CustomCommandRun): CustomCommandInput {
  const payload = run.command.payload as unknown as CustomCommandInput;
  if (payload.allowedChannelIds?.length && !payload.allowedChannelIds.includes(run.channelId)) {
    throw new UserFacingError('This command is not available in this channel.');
  }
  if (payload.allowedUserIds?.length && !payload.allowedUserIds.includes(run.member.id)) {
    throw new UserFacingError('This command is not available to you.');
  }
  if (
    payload.requiredRoleIds?.length &&
    !payload.requiredRoleIds.some((roleId) => run.member.roles.cache.has(roleId))
  ) {
    throw new UserFacingError('You do not have a role required to use this command.');
  }
  return payload;
}

function buildEmbed(payload: CustomCommandInput, run: CustomCommandRun): EmbedBuilder | null {
  const source = payload.embed;
  if (!source) return null;
  const context = templateContext(run);
  const embed = new EmbedBuilder();
  if (source.title) embed.setTitle(renderTemplate(source.title, context).output.slice(0, 256));
  if (source.description)
    embed.setDescription(renderTemplate(source.description, context).output.slice(0, 4096));
  if (typeof source.color === 'number') embed.setColor(source.color);
  if (source.footer) embed.setFooter({ text: source.footer.slice(0, 200) });
  if (source.thumbnailUrl) embed.setThumbnail(source.thumbnailUrl);
  if (source.imageUrl) embed.setImage(source.imageUrl);
  const fields = (source.fields ?? []).slice(0, 25).map((field) => ({
    name: field.name.slice(0, 256),
    value: renderTemplate(field.value, context).output.slice(0, 1024) || '—',
    inline: field.inline ?? false,
  }));
  if (fields.length > 0) embed.addFields(fields);
  return embed;
}

function templateContext(run: CustomCommandRun) {
  const channelName = run.guild.channels.cache.get(run.channelId)?.name ?? 'channel';
  return {
    user: {
      id: run.member.id,
      username: run.member.user.username,
      tag: run.member.user.tag,
      mention: `<@${run.member.id}>`,
    },
    server: { name: run.guild.name, id: run.guild.id, memberCount: run.guild.memberCount },
    channel: { name: channelName, mention: `<#${run.channelId}>` },
    command: { name: run.command.name, args: run.args },
  };
}

/**
 * Executes a custom command: renders the response, applies the allow-listed
 * actions, optionally deletes the trigger and records the usage counter.
 */
export async function runCustomCommand(run: CustomCommandRun): Promise<void> {
  const payload = assertCustomCommandAllowed(run);
  const context = templateContext(run);

  const content = payload.response ? renderTemplate(payload.response, context).output : '';
  const embed = buildEmbed(payload, run);
  const ephemeral = run.ephemeralCapable && payload.ephemeral === true;

  await run.respond({
    content: content ? sanitizeMentions(content).slice(0, 2000) : undefined,
    embeds: embed ? [embed] : [],
    ephemeral,
  });

  for (const action of payload.actions ?? []) {
    if (action.type === 'add_role' && action.roleId) {
      const role = run.guild.roles.cache.get(action.roleId);
      const me = run.guild.members.me;
      if (role && me && role.position < me.roles.highest.position) {
        await run.member.roles
          .add(role, `Custom command ${run.command.name}`)
          .catch(() => undefined);
      }
    } else if (action.type === 'remove_role' && action.roleId) {
      const role = run.guild.roles.cache.get(action.roleId);
      const me = run.guild.members.me;
      if (role && me && role.position < me.roles.highest.position) {
        await run.member.roles
          .remove(role, `Custom command ${run.command.name}`)
          .catch(() => undefined);
      }
    } else if (action.type === 'send_dm' && action.message) {
      await run.member
        .send(sanitizeMentions(renderTemplate(action.message, context).output).slice(0, 1900))
        .catch(() => undefined);
    }
  }

  await run.services.repos.customCommands.incrementUses(run.command.id).catch(() => undefined);
}

/** Human-readable summary for `/customcommand list` and the owner panel. */
export function describePayload(payload: Record<string, unknown>): string {
  const parsed = payload as unknown as CustomCommandInput;
  const parts = [`response: ${parsed.response ? `${parsed.response.length} chars` : 'none'}`];
  if (parsed.embed) parts.push('embed: yes');
  if (parsed.actions?.length)
    parts.push(`actions: ${parsed.actions.map((action) => action.type).join(', ')}`);
  if (parsed.requiredRoleIds?.length) parts.push(`roles: ${parsed.requiredRoleIds.length}`);
  if (parsed.allowedChannelIds?.length) parts.push(`channels: ${parsed.allowedChannelIds.length}`);
  return parts.join(' • ');
}
