import {
  ChannelType,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
} from 'discord.js';
import { formatDuration, truncate, UserFacingError } from '@bot-by-ai/shared';
import { COLORS } from '../core/constants.js';
import { defineCommands, type BotCommand, type CommandContext } from '../core/command.js';
import { baseEmbed, successEmbed } from '../core/embeds.js';
import { requireUserPermissions } from '../core/resolvers.js';
import type { TicketSettings } from '../services/types.js';

function guildOf(interaction: ChatInputCommandInteraction): Guild {
  if (!interaction.guild) throw new UserFacingError('This command only works inside a server.');
  return interaction.guild;
}

function actor(interaction: ChatInputCommandInteraction): GuildMember {
  const member = interaction.member;
  if (!member || !(member instanceof GuildMember))
    throw new UserFacingError('Use this inside a server.');
  return member;
}

function isStaff(member: GuildMember, settings: TicketSettings): boolean {
  return (
    member.permissions.has(PermissionFlagsBits.ManageChannels) ||
    settings.supportRoleIds.some((roleId) => member.roles.cache.has(roleId))
  );
}

export const commands: BotCommand[] = defineCommands([
  {
    category: 'tickets',
    data: new SlashCommandBuilder()
      .setName('ticket')
      .setDescription('Ticket system: setup, panels, claim, close, transcripts and stats')
      .addSubcommand((sub) =>
        sub
          .setName('setup')
          .setDescription('Configure the ticket system')
          .addChannelOption((option) =>
            option
              .setName('category')
              .setDescription('Category where ticket channels are created')
              .addChannelTypes(ChannelType.GuildCategory),
          )
          .addChannelOption((option) =>
            option
              .setName('archive_category')
              .setDescription('Category for archived tickets')
              .addChannelTypes(ChannelType.GuildCategory),
          )
          .addChannelOption((option) =>
            option
              .setName('transcripts')
              .setDescription('Channel for transcript files')
              .addChannelTypes(ChannelType.GuildText),
          )
          .addChannelOption((option) =>
            option
              .setName('log')
              .setDescription('Ticket log channel')
              .addChannelTypes(ChannelType.GuildText),
          )
          .addRoleOption((option) =>
            option.setName('support_role').setDescription('Support team role'),
          )
          .addIntegerOption((option) =>
            option
              .setName('max_open')
              .setDescription('Max open tickets per user (1-10)')
              .setMinValue(1)
              .setMaxValue(10),
          )
          .addIntegerOption((option) =>
            option
              .setName('auto_close_hours')
              .setDescription('Auto-close after N idle hours (0 = never)')
              .setMinValue(0)
              .setMaxValue(8760),
          )
          .addBooleanOption((option) =>
            option.setName('enabled').setDescription('Enable the ticket system'),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('panel')
          .setDescription('Publish a support panel (button per category)')
          .addChannelOption((option) =>
            option
              .setName('channel')
              .setDescription('Channel for the panel')
              .setRequired(true)
              .addChannelTypes(ChannelType.GuildText),
          )
          .addStringOption((option) =>
            option.setName('title').setDescription('Panel title').setRequired(true),
          )
          .addStringOption((option) =>
            option.setName('description').setDescription('Panel description').setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName('categories')
              .setDescription('Comma separated categories, optionally "label:key" (max 5)')
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName('open').setDescription('Open a ticket (uses the first configured panel)'),
      )
      .addSubcommand((sub) =>
        sub.setName('close').setDescription('Close the ticket in this channel'),
      )
      .addSubcommand((sub) =>
        sub.setName('claim').setDescription('Claim the ticket in this channel'),
      )
      .addSubcommand((sub) =>
        sub
          .setName('reopen')
          .setDescription('Reopen a closed ticket')
          .addIntegerOption((option) =>
            option
              .setName('ticket')
              .setDescription('Ticket number (defaults to the most recent closed ticket)'),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Add a member to this ticket')
          .addUserOption((option) =>
            option.setName('user').setDescription('Member').setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Remove a member from this ticket')
          .addUserOption((option) =>
            option.setName('user').setDescription('Member').setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName('transcript').setDescription('Export a transcript of this ticket'),
      )
      .addSubcommand((sub) =>
        sub
          .setName('rate')
          .setDescription('Rate a closed ticket')
          .addIntegerOption((option) =>
            option
              .setName('stars')
              .setDescription('1-5 stars')
              .setRequired(true)
              .setMinValue(1)
              .setMaxValue(5),
          )
          .addStringOption((option) => option.setName('comment').setDescription('Optional comment'))
          .addIntegerOption((option) =>
            option
              .setName('ticket')
              .setDescription('Ticket number (defaults to the last one in this channel)'),
          ),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('List tickets (staff only)'))
      .addSubcommand((sub) => sub.setName('stats').setDescription('Ticket statistics'))
      .addSubcommand((sub) =>
        sub.setName('autoclose').setDescription('Close every ticket that exceeded the idle window'),
      )
      .addSubcommand((sub) =>
        sub
          .setName('support')
          .setDescription('Add or remove a support role')
          .addRoleOption((option) =>
            option.setName('role').setDescription('Support role').setRequired(true),
          )
          .addBooleanOption((option) =>
            option.setName('remove').setDescription('Remove instead of add'),
          ),
      ),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const member = actor(interaction);
      const sub = interaction.options.getSubcommand(true);
      const settings = await services.tickets.getSettings(guild.id);
      const requireStaff = (): void =>
        requireUserPermissions(
          member,
          [PermissionFlagsBits.ManageChannels],
          'ticket staff actions',
        );

      if (sub === 'setup') {
        requireUserPermissions(member, [PermissionFlagsBits.ManageGuild], 'ticket setup');
        const patch: Record<string, unknown> = { ...settings };
        const category = interaction.options.getChannel('category');
        const archive = interaction.options.getChannel('archive_category');
        const transcripts = interaction.options.getChannel('transcripts');
        const log = interaction.options.getChannel('log');
        const supportRole = interaction.options.getRole('support_role');
        const maxOpen = interaction.options.getInteger('max_open');
        const autoClose = interaction.options.getInteger('auto_close_hours');
        const enabled = interaction.options.getBoolean('enabled');
        if (category) patch.categoryId = category.id;
        if (archive) patch.archiveCategoryId = archive.id;
        if (transcripts) patch.transcriptsChannelId = transcripts.id;
        if (log) patch.logChannelId = log.id;
        if (supportRole)
          patch.supportRoleIds = [...new Set([...settings.supportRoleIds, supportRole.id])];
        if (maxOpen !== null) patch.maxOpenPerUser = maxOpen;
        if (autoClose !== null) patch.autoCloseHours = autoClose;
        if (enabled !== null) patch.enabled = enabled;
        const updated = await services.settings.update<TicketSettings>(guild.id, 'tickets', patch, {
          actorId: interaction.user.id,
          source: 'command',
        });
        await interaction.reply({
          embeds: [
            successEmbed(
              [
                `Ticket system ${updated.enabled ? '**enabled**' : '**disabled**'}.`,
                `Category: ${updated.categoryId ? `<#${updated.categoryId}>` : 'not set'}`,
                `Support roles: ${updated.supportRoleIds.map((id) => `<@&${id}>`).join(' ') || 'none'}`,
                `Transcript channel: ${updated.transcriptsChannelId ? `<#${updated.transcriptsChannelId}>` : 'disabled'}`,
                `Max open per user: ${updated.maxOpenPerUser}`,
                `Auto-close after: ${updated.autoCloseHours > 0 ? formatDuration(updated.autoCloseHours * 3_600_000) : 'never'}`,
                '',
                'Publish a panel with `/ticket panel` so members can open tickets with a button.',
              ].join('\n'),
            ),
          ],
        });
        return;
      }

      if (sub === 'panel') {
        requireStaff();
        const channel = interaction.options.getChannel('channel', true);
        const title = interaction.options.getString('title', true);
        const description = interaction.options.getString('description', true);
        const rawCategories = interaction.options.getString('categories', true);
        const categories = rawCategories
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
          .slice(0, 5)
          .map((entry) => {
            const [labelPart, keyPart] = entry.includes(':') ? entry.split(':') : [entry, entry];
            const label = truncate((labelPart ?? entry).trim(), 80);
            const key =
              (keyPart ?? entry)
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9_-]/g, '-')
                .slice(0, 32) || 'general';
            return { key, label };
          });
        const panel = {
          id: `panel-${Date.now().toString(36)}`,
          channelId: channel.id,
          title,
          description,
          categories,
        };
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const messageId = await services.tickets.publishPanel(guild, panel);
        const existing = Array.isArray(settings.panels) ? settings.panels : [];
        await services.settings.update(
          guild.id,
          'tickets',
          {
            enabled: true,
            panels: [
              ...existing.filter((entry) => (entry as { id?: string }).id !== panel.id).slice(0, 9),
              { ...panel, messageId },
            ],
          },
          { actorId: interaction.user.id, source: 'command' },
        );
        await interaction.editReply({
          embeds: [
            successEmbed(
              `Panel published in <#${channel.id}> with ${categories.length} category button(s): ${categories.map((category) => category.label).join(', ')}.`,
            ),
          ],
        });
        return;
      }

      if (sub === 'open') {
        const panel = (
          settings.panels as {
            id: string;
            channelId: string;
            title: string;
            description: string;
            categories: { key: string; label: string }[];
          }[]
        )[0];
        if (!panel)
          throw new UserFacingError(
            'No ticket panel is configured — ask staff to run `/ticket panel`.',
          );
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const { ticket, channel } = await services.tickets.open({
          guild,
          user: member,
          panel,
          categoryKey: panel.categories[0]?.key ?? 'general',
          reason: null,
        });
        await interaction.editReply({
          embeds: [successEmbed(`Ticket #${ticket.ticket_number} created: <#${channel.id}>`)],
        });
        return;
      }

      if (sub === 'list') {
        requireStaff();
        const { rows, total } = await services.repos.tickets.list(guild.id, { limit: 50 });
        const { sendPaginated } = await import('../core/ui.js');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await sendPaginated(
          interaction,
          rows,
          (ticket) =>
            `**#${ticket.ticket_number}** \`${ticket.status}\` <#${ticket.channel_id}> — <@${ticket.user_id}>${ticket.claimed_by ? ` • claimed by <@${ticket.claimed_by}>` : ''}`,
          { title: `Tickets (${total} total)`, pageSize: 15, emptyMessage: 'No tickets yet.' },
        );
        return;
      }

      if (sub === 'stats') {
        requireStaff();
        const stats = await services.repos.tickets.stats(guild.id);
        await interaction.reply({
          embeds: [
            baseEmbed(COLORS.primary)
              .setTitle('🎫 Ticket statistics')
              .addFields(
                { name: 'Open', value: String(stats.open), inline: true },
                { name: 'Claimed', value: String(stats.claimed), inline: true },
                { name: 'Closed', value: String(stats.closed), inline: true },
                {
                  name: 'Average rating',
                  value: stats.avgRating ? `${stats.avgRating.toFixed(2)} / 5` : 'no ratings yet',
                  inline: true,
                },
              ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === 'autoclose') {
        requireStaff();
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const closed = await services.tickets.autoCloseStale(guild);
        await interaction.editReply({
          embeds: [
            successEmbed(
              closed > 0 ? `Closed ${closed} stale ticket(s).` : 'No stale tickets found.',
            ),
          ],
        });
        return;
      }

      if (sub === 'support') {
        requireUserPermissions(
          member,
          [PermissionFlagsBits.ManageGuild],
          'support team configuration',
        );
        const role = interaction.options.getRole('role', true);
        const remove = interaction.options.getBoolean('remove') ?? false;
        const supportRoleIds = remove
          ? settings.supportRoleIds.filter((id) => id !== role.id)
          : [...new Set([...settings.supportRoleIds, role.id])];
        await services.settings.update(
          guild.id,
          'tickets',
          { supportRoleIds },
          { actorId: interaction.user.id, source: 'command' },
        );
        await interaction.reply({
          embeds: [
            successEmbed(
              `${remove ? 'Removed' : 'Added'} <@&${role.id}> ${remove ? 'from' : 'to'} the support team.`,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === 'reopen') {
        requireStaff();
        const target =
          interaction.options.getInteger('ticket') ??
          (await services.repos.tickets.list(guild.id, { status: 'closed', limit: 1 })).rows[0]
            ?.ticket_number;
        if (!target)
          throw new UserFacingError('No recently closed ticket found — pass the ticket number.');
        await services.tickets.reopen(guild, target, member);
        await interaction.reply({ embeds: [successEmbed(`Ticket #${target} reopened.`)] });
        return;
      }

      // Channel-scoped actions below this point.
      const ticket = await services.repos.tickets.getByChannel(interaction.channelId);
      if (!ticket) throw new UserFacingError('This channel is not an open ticket.');

      if (sub === 'close') {
        const ownsIt = ticket.user_id === interaction.user.id;
        if (!isStaff(member, settings) && !ownsIt)
          throw new UserFacingError('Only the ticket owner or support team can close this ticket.');
        await interaction.deferReply();
        const result = await services.tickets.close({
          guild,
          ticketNumber: ticket.ticket_number,
          closedBy: member,
          reason: `Closed by ${member.user.tag}`,
        });
        await interaction.editReply({
          embeds: [
            successEmbed(
              `Ticket #${ticket.ticket_number} closed. ${result.transcript ? 'Transcript archived.' : 'Transcripts are disabled for this server.'}`,
            ),
          ],
        });
        return;
      }

      if (sub === 'claim') {
        if (!isStaff(member, settings))
          throw new UserFacingError('Only the support team can claim tickets.');
        await interaction.deferReply();
        await services.tickets.claim(guild, ticket.ticket_number, member);
        await interaction.editReply({
          embeds: [successEmbed(`You claimed ticket #${ticket.ticket_number}.`)],
        });
        return;
      }

      if (sub === 'add' || sub === 'remove') {
        if (!isStaff(member, settings))
          throw new UserFacingError('Only the support team can change ticket participants.');
        const user = interaction.options.getUser('user', true);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (sub === 'add')
          await services.tickets.addUser(guild, ticket.ticket_number, user.id, member);
        else await services.tickets.removeUser(guild, ticket.ticket_number, user.id, member);
        await interaction.editReply({
          embeds: [
            successEmbed(
              `${sub === 'add' ? 'Added' : 'Removed'} <@${user.id}> ${sub === 'add' ? 'to' : 'from'} ticket #${ticket.ticket_number}.`,
            ),
          ],
        });
        return;
      }

      if (sub === 'transcript') {
        if (!isStaff(member, settings))
          throw new UserFacingError('Only the support team can export transcripts.');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const { text, lines } = await services.tickets.buildTranscript(ticket, member);
        await interaction.editReply({
          content: `Transcript for ticket #${ticket.ticket_number} (${lines.length} recorded messages):`,
          files: [
            {
              attachment: Buffer.from(text || 'No messages were recorded for this ticket.', 'utf8'),
              name: `ticket-${ticket.ticket_number}.txt`,
            },
          ],
        });
        return;
      }

      // Rate
      const stars = interaction.options.getInteger('stars', true);
      const comment = interaction.options.getString('comment');
      const ticketNumber = interaction.options.getInteger('ticket') ?? ticket.ticket_number;
      const ok = await services.repos.tickets.rate({
        guildId: guild.id,
        ticketNumber,
        userId: interaction.user.id,
        rating: stars,
        comment: comment ?? null,
      });
      if (!ok) throw new UserFacingError('You can only rate your own closed tickets.');
      await interaction.reply({
        embeds: [successEmbed(`Thanks! Ticket #${ticketNumber} rated ${'⭐'.repeat(stars)}.`)],
        flags: MessageFlags.Ephemeral,
      });
      if (settings.logChannelId) {
        await services.logging.sendTo(guild, settings.logChannelId, {
          category: 'tickets',
          title: `Ticket #${ticketNumber} rated ${stars}/5`,
          description: `<@${interaction.user.id}> rated the support they received.${comment ? `\nComment: ${truncate(comment, 500)}` : ''}`,
          actorId: interaction.user.id,
        });
      }
    },
  },
]);
