import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  type Guild,
  type GuildMember,
  type TextChannel,
} from 'discord.js';
import type { Logger } from '@bot-by-ai/shared';
import { formatDuration, UserFacingError } from '@bot-by-ai/shared';
import type { TicketRow, Repositories } from '@bot-by-ai/database';
import type { GuildSettingsService } from './settings.js';
import type { LoggingService } from './logging.js';
import type { TicketSettings } from './types.js';
import { baseEmbed, successEmbed } from '../core/embeds.js';
import { COLORS, INTERACTION_PREFIXES } from '../core/constants.js';

export interface TicketPanelDefinition {
  id: string;
  channelId: string;
  title: string;
  description: string;
  categories: { key: string; label: string; emoji?: string | null; description?: string | null }[];
}

export class TicketService {
  constructor(
    private readonly repos: Repositories,
    private readonly settings: GuildSettingsService,
    private readonly logging: LoggingService,
    private readonly logger: Logger,
  ) {}

  async getSettings(guildId: string): Promise<TicketSettings> {
    return this.settings.get<TicketSettings>(guildId, 'tickets');
  }

  /** Renders and posts a support panel with one button per category. */
  async publishPanel(guild: Guild, panel: TicketPanelDefinition): Promise<string> {
    const channel = await guild.channels.fetch(panel.channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) {
      throw new UserFacingError('I cannot post the ticket panel in that channel.');
    }
    const embed = baseEmbed(COLORS.primary)
      .setTitle(panel.title)
      .setDescription(panel.description);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      panel.categories.slice(0, 5).map((category) =>
        new ButtonBuilder()
          .setCustomId(`${INTERACTION_PREFIXES.ticket}:open:${panel.id}:${category.key}`)
          .setLabel(category.label.slice(0, 80))
          .setStyle(ButtonStyle.Primary)
          .setEmoji(category.emoji && /\p{Emoji}/u.test(category.emoji) ? category.emoji : '🎫'),
      ),
    );
    const message = await (channel as TextChannel).send({ embeds: [embed], components: [row] });
    return message.id;
  }

  /** Creates the private staff/user channel for a ticket. */
  async open(input: {
    guild: Guild;
    user: GuildMember;
    panel: TicketPanelDefinition;
    categoryKey: string;
    reason?: string | null;
  }): Promise<{ ticket: TicketRow; channel: TextChannel }> {
    const settings = await this.getSettings(input.guild.id);
    if (!settings.enabled) throw new UserFacingError('The ticket system is disabled in this server.');
    const openCount = await this.repos.tickets.openCountForUser(input.guild.id, input.user.id);
    if (openCount >= settings.maxOpenPerUser) {
      throw new UserFacingError(
        `You already have ${openCount} open ticket(s). The limit is ${settings.maxOpenPerUser}.`,
      );
    }
    const category = input.panel.categories.find((entry) => entry.key === input.categoryKey);
    if (!category) throw new UserFacingError('Unknown ticket category.');

    const overwrites = [
      { id: input.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: input.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
        ],
      },
      ...(input.guild.members.me
        ? [
            {
              id: input.guild.members.me.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ManageChannels,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.ManageMessages,
                PermissionFlagsBits.AttachFiles,
              ],
            },
          ]
        : []),
      ...settings.supportRoleIds.map((roleId) => ({
        id: roleId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      })),
    ];

    const channel = (await input.guild.channels.create({
      name: `ticket-${input.user.user.username}`.toLowerCase().slice(0, 90),
      type: ChannelType.GuildText,
      parent: settings.categoryId ?? undefined,
      topic: `Ticket opened by ${input.user.user.tag} (${input.user.id}) • category: ${category.label}`,
      permissionOverwrites: overwrites,
      reason: `Ticket opened by ${input.user.user.tag}`,
    })) as TextChannel;

    const ticket = await this.repos.tickets.create({
      guildId: input.guild.id,
      userId: input.user.id,
      channelId: channel.id,
      categoryKey: category.key,
      subject: input.reason ?? null,
    });

    const header = baseEmbed(COLORS.primary)
      .setTitle(`Ticket #${ticket.ticket_number} • ${category.label}`)
      .setDescription(
        (settings.welcomeMessage ?? 'Thanks for opening a ticket.').replace('{user}', `<@${input.user.id}>`),
      )
      .addFields(
        { name: 'Opened by', value: `<@${input.user.id}>`, inline: true },
        { name: 'Category', value: category.label, inline: true },
      );
    if (input.reason) header.addFields({ name: 'Reason', value: input.reason.slice(0, 1000) });

    const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${INTERACTION_PREFIXES.ticket}:claim:${ticket.ticket_number}`)
        .setLabel('Claim')
        .setEmoji('🙋')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`${INTERACTION_PREFIXES.ticket}:close:${ticket.ticket_number}`)
        .setLabel('Close')
        .setEmoji('🔒')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`${INTERACTION_PREFIXES.ticket}:transcript:${ticket.ticket_number}`)
        .setLabel('Transcript')
        .setEmoji('📄')
        .setStyle(ButtonStyle.Secondary),
    );

    await channel.send({
      content: `<@${input.user.id}> ${settings.supportRoleIds.map((id) => `<@&${id}>`).join(' ')}`.trim(),
      embeds: [header],
      components: [controls],
    });
    await this.logging.log(input.guild, {
      category: 'tickets',
      title: `Ticket #${ticket.ticket_number} opened`,
      description: `<@${input.user.id}> opened a ${category.label} ticket in <#${channel.id}>.`,
      actorId: input.user.id,
      auditAction: 'tickets.open',
    });
    return { ticket, channel };
  }

  async claim(guild: Guild, ticketNumber: number, staff: GuildMember): Promise<TicketRow> {
    const settings = await this.getSettings(guild.id);
    if (!settings.supportRoleIds.some((roleId) => staff.roles.cache.has(roleId)) && !staff.permissions.has(PermissionFlagsBits.ManageChannels)) {
      throw new UserFacingError('Only members of the support team can claim tickets.');
    }
    const claimed = await this.repos.tickets.claim(guild.id, ticketNumber, staff.id);
    if (!claimed) throw new UserFacingError('That ticket is not open (it may already be claimed or closed).');
    const ticket = await this.repos.tickets.getByNumber(guild.id, ticketNumber);
    await this.logging.log(guild, {
      category: 'tickets',
      title: `Ticket #${ticketNumber} claimed`,
      description: `<@${staff.id}> claimed the ticket.`,
      actorId: staff.id,
      auditAction: 'tickets.claim',
    });
    return ticket as TicketRow;
  }

  async close(input: {
    guild: Guild;
    ticketNumber: number;
    closedBy: GuildMember;
    reason?: string | null;
    deleteChannel?: boolean;
  }): Promise<{ ticket: TicketRow; transcript: string }> {
    const ticket = await this.repos.tickets.getByNumber(input.guild.id, input.ticketNumber);
    if (!ticket) throw new UserFacingError(`Ticket #${input.ticketNumber} does not exist.`);
    if (ticket.status === 'closed') throw new UserFacingError('That ticket is already closed.');
    const settings = await this.getSettings(input.guild.id);
    const transcript = settings.transcriptsEnabled
      ? await this.buildTranscript(ticket, input.closedBy)
      : { text: '', lines: [] as { author_id: string; author_tag: string | null; content: string | null; created_at: Date }[] };
    const closed = await this.repos.tickets.close({
      guildId: input.guild.id,
      ticketNumber: input.ticketNumber,
      closedBy: input.closedBy.id,
      reason: input.reason ?? null,
      transcript: settings.transcriptsEnabled ? { generatedAt: new Date().toISOString(), messageCount: transcript.lines.length } : undefined,
    });
    if (settings.transcriptsChannelId && transcript.text) {
      const logChannel = await input.guild.channels.fetch(settings.transcriptsChannelId).catch(() => null);
      if (logChannel?.isTextBased()) {
        const file = new AttachmentBuilder(Buffer.from(transcript.text, 'utf8'), {
          name: `ticket-${input.ticketNumber}.txt`,
        });
        await logChannel
          .send({
            embeds: [
              baseEmbed(COLORS.neutral)
                .setTitle(`Ticket #${input.ticketNumber} closed`)
                .setDescription(
                  `Closed by <@${input.closedBy.id}>\nReason: ${input.reason ?? 'not provided'}\nMessages archived: ${transcript.lines.length}`,
                ),
            ],
            files: [file],
          })
          .catch(() => {});
      }
    }
    if (settings.ratingEnabled && ticket.user_id !== input.closedBy.id) {
      const owner = await input.guild.members.fetch(ticket.user_id).catch(() => null);
      await owner
        ?.send(
          `Your ticket #${input.ticketNumber} in **${input.guild.name}** was closed by ${input.closedBy.user.tag}.` +
            (settings.ratingEnabled ? '\nYou can rate the support you received with `/ticket rate`.' : ''),
        )
        .catch(() => {});
    }
    await this.logging.log(input.guild, {
      category: 'tickets',
      title: `Ticket #${input.ticketNumber} closed`,
      description: `Closed by <@${input.closedBy.id}>. Reason: ${input.reason ?? 'not provided'}`,
      actorId: input.closedBy.id,
      auditAction: 'tickets.close',
    });
    if (input.deleteChannel) {
      const channel = await input.guild.channels.fetch(ticket.channel_id).catch(() => null);
      if (channel && 'delete' in channel) {
        await channel.delete(`Ticket #${input.ticketNumber} closed`).catch(() => {});
      }
    }
    return { ticket: (closed ?? ticket) as TicketRow, transcript: transcript.text };
  }

  async reopen(guild: Guild, ticketNumber: number, actor: GuildMember): Promise<void> {
    const reopened = await this.repos.tickets.reopen(guild.id, ticketNumber);
    if (!reopened) throw new UserFacingError('That ticket is not closed.');
    await this.logging.log(guild, {
      category: 'tickets',
      title: `Ticket #${ticketNumber} reopened`,
      description: `Reopened by <@${actor.id}>.`,
      actorId: actor.id,
      auditAction: 'tickets.reopen',
    });
  }

  async addUser(guild: Guild, ticketNumber: number, userId: string, actor: GuildMember): Promise<void> {
    const ticket = await this.repos.tickets.getByNumber(guild.id, ticketNumber);
    if (!ticket) throw new UserFacingError('Ticket not found.');
    const channel = await guild.channels.fetch(ticket.channel_id).catch(() => null);
    if (!channel || !('permissionOverwrites' in channel)) throw new UserFacingError('Ticket channel not found.');
    await channel.permissionOverwrites.edit(
      userId,
      {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
        AttachFiles: true,
      },
      { reason: `${actor.user.tag} added a participant` },
    );
  }

  async removeUser(guild: Guild, ticketNumber: number, userId: string, actor: GuildMember): Promise<void> {
    const ticket = await this.repos.tickets.getByNumber(guild.id, ticketNumber);
    if (!ticket) throw new UserFacingError('Ticket not found.');
    if (userId === ticket.user_id) {
      throw new UserFacingError('You cannot remove the ticket owner — close the ticket instead.');
    }
    const channel = await guild.channels.fetch(ticket.channel_id).catch(() => null);
    if (!channel || !('permissionOverwrites' in channel)) throw new UserFacingError('Ticket channel not found.');
    await channel.permissionOverwrites.edit(userId, { ViewChannel: false }, { reason: `${actor.user.tag} removed a participant` });
  }

  async buildTranscript(
    ticket: TicketRow,
    requester: GuildMember,
  ): Promise<{ text: string; lines: { author_id: string; author_tag: string | null; content: string | null; created_at: Date }[] }> {
    const lines = await this.repos.tickets.getTranscript(ticket.id);
    const header = [
      `Transcript for ticket #${ticket.ticket_number} (${ticket.guild_id})`,
      `Opened by: ${ticket.user_id} at ${ticket.created_at.toISOString()}`,
      `Category: ${ticket.category_key}`,
      `Requested by: ${requester.user.tag} (${requester.id})`,
      `Closed by: ${ticket.closed_by ?? 'n/a'}`,
      `Messages: ${lines.length}`,
      ''.padEnd(60, '='),
      '',
    ].join('\n');
    const body = lines
      .map(
        (line) =>
          `[${line.created_at.toISOString()}] ${line.author_tag ?? line.author_id}: ${line.content ?? '(attachment)'}`,
      )
      .join('\n');
    return { text: `${header}\n${body}`, lines };
  }

  /** Auto-close sweeper invoked by the scheduler; never deletes without config. */
  async autoCloseStale(guild: Guild): Promise<number> {
    const settings = await this.getSettings(guild.id);
    if (!settings.enabled || settings.autoCloseHours <= 0) return 0;
    const stale = await this.repos.tickets.staleOpenTickets(settings.autoCloseHours);
    let closedCount = 0;
    for (const ticket of stale) {
      const channel = await guild.channels.fetch(ticket.channel_id).catch(() => null);
      if (channel?.isTextBased()) {
        await channel
          .send({
            embeds: [
              successEmbed(
                `This ticket was automatically closed after ${formatDuration(settings.autoCloseHours * 3_600_000)} of inactivity. Reopen it with \`/ticket reopen\`.`,
              ),
            ],
          })
          .catch(() => {});
      }
      const closed = await this.repos.tickets.close({
        guildId: guild.id,
        ticketNumber: ticket.ticket_number,
        closedBy: guild.members.me?.id ?? 'system',
        reason: 'Automatic close after inactivity',
      });
      if (closed) closedCount += 1;
    }
    if (closedCount > 0) {
      this.logger.info('auto-closed stale tickets', { guildId: guild.id, closed: closedCount });
    }
    return closedCount;
  }
}
