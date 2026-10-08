import {
  ChannelType,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  GuildMember,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type MessageContextMenuCommandInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type UserContextMenuCommandInteraction,
} from 'discord.js';
import { errorForLog, PermissionError, UserFacingError } from '@bot-by-ai/shared';
import type { CommandRegistry } from '../core/registry.js';
import type { BotServices } from '../core/context.js';
import { replyWithError } from '../core/resolvers.js';
import { errorEmbed, successEmbed } from '../core/embeds.js';
import { INTERACTION_PREFIXES } from '../core/constants.js';
import { resolveCustomCommand, runCustomCommand } from '../core/customCommands.js';
import type { TicketPanelDefinition } from '../services/tickets.js';

/** Routes every interaction type to the right subsystem. */
export function registerInteractionEvents(
  client: Client,
  registry: CommandRegistry,
  services: BotServices,
): void {
  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        await handleChatInput(interaction, registry, services);
        return;
      }
      if (interaction.isAutocomplete()) {
        const command = registry.get(interaction.commandName);
        if (command?.autocomplete) {
          await command.autocomplete({ interaction, services });
        } else {
          await interaction.respond([]).catch(() => {});
        }
        return;
      }
      if (interaction.isButton()) {
        await handleButton(interaction, services);
        return;
      }
      if (interaction.isStringSelectMenu()) {
        await handleSelect(interaction, services);
        return;
      }
      if (interaction.isModalSubmit()) {
        await handleModal(interaction, services);
        return;
      }
      if (interaction.isUserContextMenuCommand() || interaction.isMessageContextMenuCommand()) {
        await handleContextMenu(interaction, services);
        return;
      }
    } catch (error) {
      services.logger.error('interaction handler failed', {
        type: interaction.type,
        error: errorForLog(error),
      });
    }
  });
}

async function handleChatInput(
  interaction: ChatInputCommandInteraction,
  registry: CommandRegistry,
  services: BotServices,
): Promise<void> {
  const command = registry.get(interaction.commandName);
  if (!command) {
    const handled = await handleCustomCommandInteraction(interaction, services);
    if (!handled) {
      await interaction
        .reply({
          embeds: [
            errorEmbed(
              'That command is not available right now. Commands may have been updated — try again in a moment.',
            ),
          ],
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
    }
    return;
  }

  const startedAt = Date.now();
  let success = true;
  let errorCode: string | undefined;

  try {
    if (command.guildOnly && !interaction.inGuild()) {
      throw new PermissionError('This command can only be used inside a server.');
    }
    if (command.ownerOnly && !services.owners.isOwner(interaction.user.id)) {
      throw new PermissionError(
        'Only the bot owners configured in BOT_OWNER_IDS can use this command. Server administrator permissions do not grant access.',
      );
    }
    const cooldownKey = `${command.data.toJSON().name}:${interaction.user.id}:${interaction.guildId ?? 'dm'}`;
    const cooldown = services.cooldowns.consume(cooldownKey);
    if (!cooldown.ok) {
      throw new UserFacingError(
        `Slow down — try \`/${command.data.toJSON().name}\` again in ${(cooldown.retryAfterMs / 1000).toFixed(1)}s.`,
      );
    }

    await command.execute({ interaction, services, logger: services.logger, startedAt });
  } catch (error) {
    success = false;
    errorCode = (error as { code?: string }).code ?? 'UNKNOWN';
    await replyWithError(interaction, error, services);
  } finally {
    await services.repos.commandUsage
      .record({
        guildId: interaction.guildId,
        userId: interaction.user.id,
        commandName: command.data.toJSON().name,
        success,
        errorCode: errorCode ?? null,
        durationMs: Date.now() - startedAt,
      })
      .catch(() => {});
  }
}

/**
 * Executes a slash invocation of a custom command (guild-scoped or published
 * global). The command must already be registered with Discord — see
 * `scripts/deploy-commands.ts`, which merges database-backed custom commands
 * into the registration payload.
 */
async function handleCustomCommandInteraction(
  interaction: ChatInputCommandInteraction,
  services: BotServices,
): Promise<boolean> {
  if (!interaction.inGuild() || !interaction.guild) return false;
  const member = interaction.member;
  if (!member || !(member instanceof GuildMember)) return false;

  const name = interaction.commandName.toLowerCase();
  const custom = await resolveCustomCommand(services, interaction.guild.id, name);
  if (!custom) return false;

  const cooldownKey = `custom:${custom.scope}:${custom.id}:${interaction.guild.id}:${interaction.user.id}`;
  const payload = custom.payload as { cooldownSeconds?: number; ephemeral?: boolean };
  const wait = services.cooldowns.remaining(cooldownKey);
  if (wait > 0) {
    await interaction
      .reply({
        content: `This command is on cooldown for another ${(wait / 1000).toFixed(1)}s.`,
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return true;
  }

  try {
    await interaction.deferReply({
      flags: payload.ephemeral === true ? MessageFlags.Ephemeral : undefined,
    });
    services.cooldowns.consume(cooldownKey);
    await runCustomCommand({
      services,
      guild: interaction.guild,
      member,
      command: custom,
      args: interaction.options.data
        .filter((option) => option.name !== undefined && option.type !== 1 && option.type !== 2)
        .map((option) => String(option.value ?? ''))
        .join(' '),
      channelId: interaction.channelId,
      ephemeralCapable: true,
      respond: async ({ content, embeds, ephemeral }) => {
        const flags = ephemeral ? MessageFlags.Ephemeral : undefined;
        await interaction
          .editReply({
            ...(content ? { content } : {}),
            ...(embeds && embeds.length > 0 ? { embeds } : {}),
            ...(flags ? { flags } : {}),
          } as Parameters<typeof interaction.editReply>[0])
          .catch(() => {});
      },
    });
    await services.repos.commandUsage
      .record({
        guildId: interaction.guildId,
        userId: interaction.user.id,
        commandName: `custom:${custom.name}`,
        success: true,
        errorCode: null,
        durationMs: null,
      })
      .catch(() => {});
  } catch (error) {
    await services.repos.commandUsage
      .record({
        guildId: interaction.guildId,
        userId: interaction.user.id,
        commandName: `custom:${custom.name}`,
        success: false,
        errorCode: (error as { code?: string }).code ?? 'CUSTOM_FAILED',
        durationMs: null,
      })
      .catch(() => {});
    await replyWithError(interaction, error, services);
  }
  return true;
}

async function handleContextMenu(
  interaction: UserContextMenuCommandInteraction | MessageContextMenuCommandInteraction,
  services: BotServices,
): Promise<void> {
  // Context menus are owner-only diagnostics unless a specific handler is added.
  if (!services.owners.isOwner(interaction.user.id)) {
    await interaction
      .reply({
        content: 'That context menu action is restricted to bot owners.',
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }
  await interaction
    .reply({
      content: `Command: \`${interaction.commandName}\`\nTarget: \`${'targetId' in interaction ? interaction.targetId : 'n/a'}\``,
      flags: MessageFlags.Ephemeral,
    })
    .catch(() => {});
  await services.logging.logBotError(interaction.guild, {
    command: interaction.commandName,
    message: 'context menu invoked',
  });
}

async function handleButton(interaction: ButtonInteraction, services: BotServices): Promise<void> {
  const [prefix] = interaction.customId.split(':');
  switch (prefix) {
    case INTERACTION_PREFIXES.ticket:
      await handleTicketButton(interaction, services);
      return;
    case INTERACTION_PREFIXES.giveaway:
      await handleGiveawayButton(interaction, services);
      return;
    case INTERACTION_PREFIXES.suggestion:
      await handleSuggestionButton(interaction, services);
      return;
    case INTERACTION_PREFIXES.reactionRole:
      await handleReactionRole(interaction, services, interaction.customId.split(':')[2] ?? '');
      return;
    case INTERACTION_PREFIXES.help:
      await interaction
        .reply({
          content: 'That help menu has expired. Run `/help` again for a fresh menu.',
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
      return;
    case INTERACTION_PREFIXES.pagination:
    case INTERACTION_PREFIXES.confirm:
      // These are handled by their own collectors; a click here means it expired.
      await interaction
        .reply({
          content: 'This menu has expired — run the command again.',
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
      return;
    default:
      if (interaction.customId.startsWith('verify:')) {
        await handleVerification(interaction, services, interaction.customId.split(':')[1] ?? '');
        return;
      }
      await interaction
        .reply({ content: 'That button is no longer active.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
  }
}

async function handleTicketButton(
  interaction: ButtonInteraction,
  services: BotServices,
): Promise<void> {
  const [, action, ...rest] = interaction.customId.split(':');
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({
      content: 'Tickets only work inside a server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) {
    await interaction.reply({
      content: 'Could not resolve your membership.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    if (action === 'open') {
      const [panelId, categoryKey] = rest;
      const settings = await services.tickets.getSettings(guild.id);
      const panel = (settings.panels as TicketPanelDefinition[]).find(
        (entry) => entry.id === panelId,
      );
      if (!panel) throw new UserFacingError('That ticket panel is no longer configured.');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { ticket, channel } = await services.tickets.open({
        guild,
        user: member,
        panel,
        categoryKey: categoryKey ?? panel.categories[0]?.key ?? 'general',
        reason: null,
      });
      await interaction.editReply({
        embeds: [
          successEmbed(
            `Your ticket has been created: <#${channel.id}> (ticket #${ticket.ticket_number}).`,
          ),
        ],
      });
      return;
    }

    const ticketNumber = Number(rest[0]);
    if (!Number.isFinite(ticketNumber)) {
      throw new UserFacingError('This ticket button is malformed.');
    }
    const settings = await services.tickets.getSettings(guild.id);
    const isStaff =
      member.permissions.has(PermissionFlagsBits.ManageChannels) ||
      settings.supportRoleIds.some((roleId) => member.roles.cache.has(roleId));

    if (action === 'claim') {
      if (!isStaff) throw new PermissionError('Only the support team can claim tickets.');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await services.tickets.claim(guild, ticketNumber, member);
      await interaction.editReply({
        embeds: [successEmbed(`You claimed ticket #${ticketNumber}.`)],
      });
      const ticket = await services.repos.tickets.getByNumber(guild.id, ticketNumber);
      if (ticket) {
        const channel = await guild.channels.fetch(ticket.channel_id).catch(() => null);
        if (channel?.isTextBased()) {
          await channel
            .send({ content: `🙋 <@${member.id}> claimed this ticket.` })
            .catch(() => {});
        }
      }
      return;
    }

    if (action === 'close') {
      const ticket = await services.repos.tickets.getByNumber(guild.id, ticketNumber);
      if (!ticket) throw new UserFacingError('Ticket not found.');
      const ownsIt = ticket.user_id === member.id;
      if (!isStaff && !ownsIt)
        throw new PermissionError('Only the ticket owner or support team can close this ticket.');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await services.tickets.close({
        guild,
        ticketNumber,
        closedBy: member,
        reason: `Closed via ticket button by ${member.user.tag}`,
        deleteChannel: false,
      });
      await interaction.editReply({
        embeds: [
          successEmbed(
            `Ticket #${ticketNumber} closed. Transcript messages: ${result.transcript ? 'saved' : 'not recorded'}.`,
          ),
        ],
      });
      const channel = await guild.channels.fetch(ticket.channel_id).catch(() => null);
      if (channel?.isTextBased()) {
        await channel
          .send({
            embeds: [
              successEmbed(
                `This ticket was closed by <@${member.id}>. Staff can reopen it with \`/ticket reopen\`.`,
              ),
            ],
          })
          .catch(() => {});
      }
      return;
    }

    if (action === 'transcript') {
      if (!isStaff) throw new PermissionError('Only the support team can export transcripts.');
      const ticket = await services.repos.tickets.getByNumber(guild.id, ticketNumber);
      if (!ticket) throw new UserFacingError('Ticket not found.');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { text, lines } = await services.tickets.buildTranscript(ticket, member);
      await interaction.editReply({
        content: `Transcript for ticket #${ticketNumber} (${lines.length} messages):`,
        files: [
          {
            attachment: Buffer.from(text || 'No messages recorded.', 'utf8'),
            name: `ticket-${ticketNumber}.txt`,
          },
        ],
      });
      return;
    }

    throw new UserFacingError(`Unknown ticket action \`${action}\`.`);
  } catch (error) {
    await replyWithError(interaction as unknown as ChatInputCommandInteraction, error, services);
  }
}

async function handleGiveawayButton(
  interaction: ButtonInteraction,
  services: BotServices,
): Promise<void> {
  const [, action, idRaw] = interaction.customId.split(':');
  const guild = interaction.guild;
  if (!guild || action !== 'enter') {
    await interaction.reply({
      content: 'That giveaway button is not valid.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) {
    await interaction.reply({
      content: 'Could not resolve your membership.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  try {
    const result = await services.community.enterGiveaway({
      guild,
      giveawayId: Number(idRaw),
      member,
    });
    await interaction.reply({
      content: result.ok
        ? `🎉 You are entered! You have **${result.entries}** entr${result.entries === 1 ? 'y' : 'ies'}.`
        : `You could not be entered: ${result.reason ?? 'already entered'}`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    await replyWithError(interaction as unknown as ChatInputCommandInteraction, error, services);
  }
}

async function handleSuggestionButton(
  interaction: ButtonInteraction,
  services: BotServices,
): Promise<void> {
  const [, direction, idRaw] = interaction.customId.split(':');
  const suggestionId = Number(idRaw);
  if (!Number.isFinite(suggestionId)) {
    await interaction.reply({
      content: 'That suggestion button is malformed.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const vote = direction === 'up' ? 1 : -1;
  try {
    let result;
    if (interaction.message.reactions.cache.size >= 0 && interaction.customId.includes('toggle')) {
      result = await services.repos.community.deleteSuggestionVote(
        suggestionId,
        interaction.user.id,
      );
    } else {
      result = await services.community.voteSuggestion({
        suggestionId,
        userId: interaction.user.id,
        vote: vote as 1 | -1,
      });
    }
    await interaction.reply({
      content: `Vote recorded: ${result.upvotes} 👍 / ${result.downvotes} 👎`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    await replyWithError(interaction as unknown as ChatInputCommandInteraction, error, services);
  }
}

async function handleReactionRole(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  services: BotServices,
  roleId: string,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) return;
  const role = await guild.roles.fetch(roleId).catch(() => null);
  if (!role) {
    await interaction.reply({
      content: 'That role no longer exists.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const me = guild.members.me;
  if (me && role.position >= me.roles.highest.position) {
    await interaction.reply({
      content: 'I cannot manage that role because it is higher than my highest role.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) return;
  const has = member.roles.cache.has(role.id);
  try {
    if (has) {
      await member.roles.remove(role, 'Reaction role removed');
    } else {
      await member.roles.add(role, 'Reaction role granted');
      if (interaction.isStringSelectMenu()) {
        const panel = await services.repos.community.findReactionRolePanelByMessage(
          interaction.message.id,
        );
        if (panel?.exclusive) {
          const options = panel.options as { roleId: string }[];
          for (const option of options) {
            if (option.roleId !== role.id && member.roles.cache.has(option.roleId)) {
              await member.roles
                .remove(option.roleId, 'Exclusive reaction role swap')
                .catch(() => {});
            }
          }
        }
      }
    }
    await interaction.reply({
      content: has ? `Removed <@&${role.id}>.` : `Added <@&${role.id}>.`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    await replyWithError(interaction as unknown as ChatInputCommandInteraction, error, services);
  }
}

async function handleVerification(
  interaction: ButtonInteraction,
  services: BotServices,
  panelId: string,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) return;
  const settings = await services.settings.get<{ autoRoleIds: string[] }>(guild.id, 'welcome');
  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) return;
  const granted = await services.welcome.grantVerificationRole(guild, member, settings.autoRoleIds);
  await services.logging
    .log(guild, {
      category: 'members',
      title: 'Verification completed',
      description: `<@${member.id}> verified (panel ${panelId}). Roles granted: ${granted}`,
      actorId: member.id,
      auditAction: 'verification.complete',
    })
    .catch(() => {});
  await interaction.reply({
    content:
      granted > 0
        ? `✅ Verified! You have been given ${granted} role(s).`
        : 'You are verified, but I could not assign the role — please contact an administrator.',
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSelect(
  interaction: StringSelectMenuInteraction,
  services: BotServices,
): Promise<void> {
  const [prefix, , roleId] = interaction.customId.split(':');
  if (prefix === INTERACTION_PREFIXES.reactionRole) {
    await handleReactionRole(interaction, services, roleId ?? interaction.values[0] ?? '');
    return;
  }
  await interaction
    .reply({ content: 'That menu is no longer active.', flags: MessageFlags.Ephemeral })
    .catch(() => {});
}

async function handleModal(
  interaction: ModalSubmitInteraction,
  services: BotServices,
): Promise<void> {
  const [prefix, action] = interaction.customId.split(':');
  if (prefix === INTERACTION_PREFIXES.ticket && action === 'open') {
    const guild = interaction.guild;
    if (!guild) return;
    const reason = interaction.fields.getTextInputValue('reason').slice(0, 1000);
    const member = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member) return;
    const settings = await services.tickets.getSettings(guild.id);
    const panel = (settings.panels as TicketPanelDefinition[])[0];
    if (!panel) {
      await interaction.reply({
        content: 'No ticket panel is configured.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const { ticket, channel } = await services.tickets.open({
        guild,
        user: member,
        panel,
        categoryKey: panel.categories[0]?.key ?? 'general',
        reason,
      });
      await interaction.editReply({
        embeds: [successEmbed(`Ticket #${ticket.ticket_number} created: <#${channel.id}>`)],
      });
    } catch (error) {
      await replyWithError(interaction as unknown as ChatInputCommandInteraction, error, services);
    }
    return;
  }
  await interaction
    .reply({ content: 'That form is no longer active.', flags: MessageFlags.Ephemeral })
    .catch(() => {});
}

export function isThreadOrTextChannel(type: ChannelType): boolean {
  return [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.GuildForum,
  ].includes(type);
}
