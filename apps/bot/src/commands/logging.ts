import {
  ChannelType,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
} from 'discord.js';
import { truncate, UserFacingError } from '@bot-by-ai/shared';
import { COLORS, LOG_CATEGORIES } from '../core/constants.js';
import { defineCommands, type BotCommand, type CommandContext } from '../core/command.js';
import { baseEmbed, successEmbed, warningEmbed } from '../core/embeds.js';
import { sendPaginated } from '../core/ui.js';
import { requireUserPermissions } from '../core/resolvers.js';
import type { LoggingSettings } from '../services/types.js';

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

export const commands: BotCommand[] = defineCommands([
  {
    category: 'configuration',
    data: new SlashCommandBuilder()
      .setName('logs')
      .setDescription('Configure which events are logged and where')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) =>
        sub.setName('status').setDescription('Show the current logging configuration'),
      )
      .addSubcommand((sub) =>
        sub
          .setName('channel')
          .setDescription('Route one category (or all) to a channel')
          .addStringOption((option) =>
            option
              .setName('category')
              .setDescription('Which category')
              .setRequired(true)
              .addChoices(
                ...LOG_CATEGORIES.map((category) => ({ name: category, value: category })),
              ),
          )
          .addChannelOption((option) =>
            option
              .setName('channel')
              .setDescription('Channel (omit to disable)')
              .addChannelTypes(ChannelType.GuildText),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('events')
          .setDescription('Enable or disable individual event groups')
          .addBooleanOption((option) =>
            option.setName('messages').setDescription('Message edits/deletes/purges'),
          )
          .addBooleanOption((option) =>
            option.setName('members').setDescription('Joins, leaves, nickname and role changes'),
          )
          .addBooleanOption((option) =>
            option.setName('moderation').setDescription('Moderation actions and cases'),
          )
          .addBooleanOption((option) =>
            option.setName('security').setDescription('Anti-nuke/anti-raid/anti-spam events'),
          )
          .addBooleanOption((option) =>
            option.setName('voice').setDescription('Voice channel joins/leaves/moves'),
          )
          .addBooleanOption((option) =>
            option.setName('server').setDescription('Channel, role and emoji changes'),
          )
          .addBooleanOption((option) =>
            option.setName('audit').setDescription('Audit-log mirrored entries'),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('ignore')
          .setDescription('Ignore a channel or member for logging')
          .addChannelOption((option) =>
            option.setName('channel').setDescription('Channel to ignore'),
          )
          .addUserOption((option) => option.setName('user').setDescription('Member to ignore')),
      )
      .addSubcommand((sub) => sub.setName('disable').setDescription('Disable all logging')),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const member = actor(interaction);
      requireUserPermissions(member, [PermissionFlagsBits.ManageGuild], 'logging configuration');
      const sub = interaction.options.getSubcommand(true);
      const settings = await services.settings.get<LoggingSettings>(guild.id, 'logging');

      if (sub === 'status') {
        const routes = LOG_CATEGORIES.map(
          (category) =>
            `**${category}** → ${settings.channels?.[category] ? `<#${settings.channels[category]}>` : 'not routed'}`,
        ).join('\n');
        await interaction.reply({
          embeds: [
            baseEmbed(settings.enabled ? COLORS.success : COLORS.warning)
              .setTitle('📝 Logging configuration')
              .setDescription(routes)
              .addFields(
                { name: 'Enabled', value: settings.enabled ? 'yes' : 'no', inline: true },
                {
                  name: 'Events',
                  value:
                    Object.entries(settings.events ?? {})
                      .map(([key, value]) => `${key}: ${value ? 'on' : 'off'}`)
                      .join(' • ') || 'defaults',
                  inline: false,
                },
                {
                  name: 'Ignored channels',
                  value: settings.ignoreChannelIds.map((id) => `<#${id}>`).join(' ') || 'none',
                },
                {
                  name: 'Ignored members',
                  value: settings.ignoreUserIds.map((id) => `<@${id}>`).join(' ') || 'none',
                },
                {
                  name: 'Retention',
                  value:
                    settings.retentionDays > 0 ? `${settings.retentionDays} day(s)` : 'unlimited',
                  inline: true,
                },
              ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === 'channel') {
        const category = interaction.options.getString('category', true);
        const channel = interaction.options.getChannel('channel');
        const channels = { ...(settings.channels ?? {}) } as Record<string, string | null>;
        if (channel) channels[category] = channel.id;
        else delete channels[category];
        await services.settings.update(
          guild.id,
          'logging',
          { channels, enabled: true },
          { actorId: interaction.user.id, source: 'command' },
        );
        await interaction.reply({
          embeds: [
            successEmbed(
              channel
                ? `**${category}** logs → <#${channel.id}>.`
                : `**${category}** logs disabled.`,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === 'events') {
        const events: Record<string, boolean> = { ...(settings.events ?? {}) };
        for (const key of [
          'messages',
          'members',
          'moderation',
          'security',
          'voice',
          'server',
          'audit',
        ] as const) {
          const value = interaction.options.getBoolean(key);
          if (value !== null) events[key] = value;
        }
        await services.settings.update(
          guild.id,
          'logging',
          { events, enabled: true },
          { actorId: interaction.user.id, source: 'command' },
        );
        await interaction.reply({
          embeds: [
            successEmbed(
              `Event logging updated: ${Object.entries(events)
                .map(([key, value]) => `${key}=${value ? 'on' : 'off'}`)
                .join(', ')}`,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === 'ignore') {
        const channel = interaction.options.getChannel('channel');
        const user = interaction.options.getUser('user');
        if (!channel && !user)
          throw new UserFacingError('Provide a `channel` or a `user` (or both).');
        let ignoreChannelIds = settings.ignoreChannelIds;
        let ignoreUserIds = settings.ignoreUserIds;
        if (channel) {
          ignoreChannelIds = ignoreChannelIds.includes(channel.id)
            ? ignoreChannelIds.filter((id) => id !== channel.id)
            : [...ignoreChannelIds, channel.id];
        }
        if (user) {
          ignoreUserIds = ignoreUserIds.includes(user.id)
            ? ignoreUserIds.filter((id) => id !== user.id)
            : [...ignoreUserIds, user.id];
        }
        await services.settings.update(
          guild.id,
          'logging',
          { ignoreChannelIds, ignoreUserIds },
          { actorId: interaction.user.id, source: 'command' },
        );
        await interaction.reply({
          embeds: [
            successEmbed(
              [
                channel
                  ? `<#${channel.id}> is now ${ignoreChannelIds.includes(channel.id) ? 'ignored' : 'logged'}.`
                  : null,
                user
                  ? `<@${user.id}> is now ${ignoreUserIds.includes(user.id) ? 'ignored' : 'logged'}.`
                  : null,
              ]
                .filter(Boolean)
                .join('\n'),
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await services.settings.update(
        guild.id,
        'logging',
        { enabled: false },
        { actorId: interaction.user.id, source: 'command' },
      );
      await interaction.reply({
        embeds: [warningEmbed('All logging disabled.')],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    category: 'configuration',
    data: new SlashCommandBuilder()
      .setName('auditlog')
      .setDescription('Browse the audit trail the bot keeps in the database')
      .setDefaultMemberPermissions(PermissionFlagsBits.ViewAuditLog)
      .addSubcommand((sub) =>
        sub
          .setName('view')
          .setDescription('Recent entries')
          .addUserOption((option) =>
            option.setName('actor').setDescription('Filter by the member who acted'),
          )
          .addStringOption((option) =>
            option.setName('action').setDescription('Filter by action prefix, e.g. moderation.'),
          )
          .addIntegerOption((option) =>
            option
              .setName('limit')
              .setDescription('How many entries (1-100)')
              .setMinValue(1)
              .setMaxValue(100),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName('stats').setDescription('Action counts for the last 30 days'),
      )
      .addSubcommand((sub) =>
        sub
          .setName('export')
          .setDescription('Export recent entries as JSON')
          .addIntegerOption((option) =>
            option
              .setName('limit')
              .setDescription('How many entries (1-1000)')
              .setMinValue(1)
              .setMaxValue(1000),
          ),
      ),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const sub = interaction.options.getSubcommand(true);

      if (sub === 'view') {
        const limit = interaction.options.getInteger('limit') ?? 25;
        const entries = await services.repos.audit.list({
          guildId: guild.id,
          actorId: interaction.options.getUser('actor')?.id,
          action: interaction.options.getString('action') ?? undefined,
          limit,
        });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await sendPaginated(
          interaction,
          entries.rows,
          (entry) =>
            `\`${entry.action}\` — ${entry.actor_id ? `<@${entry.actor_id}>` : 'system'}${entry.target_id ? ` → \`${entry.target_id}\`` : ''}\n<t:${Math.floor(new Date(entry.created_at).getTime() / 1000)}:R> ${truncate(JSON.stringify(entry.metadata ?? {}), 120)}`,
          {
            title: `📚 Audit log (${entries.rows.length} of ${entries.total})`,
            pageSize: 8,
            emptyMessage: 'No audit entries yet.',
          },
        );
        return;
      }

      if (sub === 'stats') {
        const [days, top] = await Promise.all([
          services.repos.commandUsage.statsForGuild(guild.id, 30),
          services.repos.commandUsage.topCommands(guild.id, 30, 10),
        ]);
        await interaction.reply({
          embeds: [
            baseEmbed(COLORS.primary)
              .setTitle('📚 Command usage (30 days)')
              .setDescription(
                top.length === 0
                  ? 'No command usage recorded yet.'
                  : top.map((row) => `**/${row.command_name}** — ${row.uses} use(s)`).join('\n'),
              )
              .addFields({
                name: 'Daily totals (last 7 days)',
                value:
                  days
                    .slice(-7)
                    .map((row) => `${row.day}: ${row.total} (${row.failed} failed)`)
                    .join('\n') || 'no data',
              }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const limit = interaction.options.getInteger('limit') ?? 500;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const entries = await services.repos.audit.list({ guildId: guild.id, limit });
      await interaction.editReply({
        content: `Audit log export (${entries.rows.length} entries, 30-day default filters):`,
        files: [
          {
            attachment: Buffer.from(JSON.stringify(entries.rows, null, 2), 'utf8'),
            name: `audit-${guild.id}-${Date.now()}.json`,
          },
        ],
      });
    },
  },
]);
