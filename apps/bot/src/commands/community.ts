/**
 * Community commands: giveaways, suggestions, starboard, birthdays, reminders.
 *
 * Every command uses real database rows and the shared configuration modules —
 * there are no placeholder responses here. Long-running work (giveaway end,
 * reminder delivery, birthday announcements) is executed by the scheduler, not
 * by sleeping inside the command handler.
 */
import {
  ChannelType,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
} from 'discord.js';
import {
  formatDuration,
  formatRelativeTimestamp,
  formatTimestamp,
  parseDurationMs,
  truncate,
  UserFacingError,
} from '@bot-by-ai/shared';
import { COLORS } from '../core/constants.js';
import { defineCommands, type BotCommand, type CommandContext } from '../core/command.js';
import { baseEmbed, successEmbed, warningEmbed } from '../core/embeds.js';
import { confirmAction, sendPaginated } from '../core/ui.js';
import { requireUserPermissions } from '../core/resolvers.js';
import type {
  BirthdaySettings,
  GiveawaySettings,
  StarboardSettings,
  SuggestionSettings,
} from '../services/types.js';

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

function requireManager(interaction: ChatInputCommandInteraction, action: string): GuildMember {
  const member = actor(interaction);
  requireUserPermissions(member, [PermissionFlagsBits.ManageGuild], action);
  return member;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export const commands: BotCommand[] = defineCommands([
  /* ------------------------------------------------------------------ giveaways */
  {
    category: 'community',
    data: new SlashCommandBuilder()
      .setName('giveaway')
      .setDescription('Create and manage giveaways')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) =>
        sub
          .setName('start')
          .setDescription('Start a new giveaway')
          .addStringOption((option) =>
            option
              .setName('prize')
              .setDescription('What are you giving away?')
              .setRequired(true)
              .setMaxLength(200),
          )
          .addStringOption((option) =>
            option
              .setName('duration')
              .setDescription('How long it runs, e.g. 30m, 12h, 2d')
              .setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName('winners')
              .setDescription('Number of winners')
              .setMinValue(1)
              .setMaxValue(50),
          )
          .addChannelOption((option) =>
            option
              .setName('channel')
              .setDescription('Channel to post in (defaults to here)')
              .addChannelTypes(ChannelType.GuildText),
          )
          .addRoleOption((option) =>
            option.setName('required_role').setDescription('Only members with this role can enter'),
          )
          .addRoleOption((option) =>
            option
              .setName('bonus_role')
              .setDescription('Members with this role get a double entry'),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('end')
          .setDescription('End a giveaway now and draw the winners')
          .addIntegerOption((option) =>
            option.setName('id').setDescription('Giveaway id').setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('reroll')
          .setDescription('Draw new winners for an ended giveaway')
          .addIntegerOption((option) =>
            option.setName('id').setDescription('Giveaway id').setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName('winners')
              .setDescription('How many winners to draw')
              .setMinValue(1)
              .setMaxValue(20),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('cancel')
          .setDescription('Cancel a giveaway without drawing winners')
          .addIntegerOption((option) =>
            option.setName('id').setDescription('Giveaway id').setRequired(true),
          ),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('List giveaways in this server'))
      .addSubcommand((sub) =>
        sub.setName('settings').setDescription('Show the giveaway configuration'),
      ),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const sub = interaction.options.getSubcommand(true);

      if (sub === 'start') {
        const member = requireManager(interaction, 'start giveaways');
        const prize = interaction.options.getString('prize', true);
        const durationRaw = interaction.options.getString('duration', true);
        const durationMs = parseDurationMs(durationRaw);
        if (!durationMs || durationMs < 60_000) {
          throw new UserFacingError(
            'Durations look like `30m`, `12h` or `2d` and must be at least one minute.',
          );
        }
        const channel = interaction.options.getChannel('channel') ?? interaction.channel;
        if (!channel) throw new UserFacingError('I could not work out which channel to use.');
        const winners = interaction.options.getInteger('winners') ?? 1;
        const requiredRole = interaction.options.getRole('required_role');
        const bonusRole = interaction.options.getRole('bonus_role');

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await services.community.startGiveaway({
          guild,
          channelId: channel.id,
          hostId: member.id,
          prize,
          durationMs,
          winners,
          requiredRoleId: requiredRole?.id ?? null,
          bonusRoleIds: bonusRole ? [bonusRole.id] : [],
        });
        await interaction.editReply({
          embeds: [
            successEmbed(
              `Giveaway **#${result.id}** for **${prize}** is live in <#${channel.id}> and ends ${formatRelativeTimestamp(result.endsAt)}.`,
            ),
          ],
        });
        return;
      }

      if (sub === 'end') {
        requireManager(interaction, 'end giveaways');
        const id = interaction.options.getInteger('id', true);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await services.community.endGiveaway({ guild, giveawayId: id });
        await interaction.editReply({
          embeds: [
            successEmbed(
              `Giveaway **#${id}** for **${result.prize}** ended with ${result.entries} entries.\nWinners: ${result.winners.map((winner) => `<@${winner}>`).join(', ') || 'none'}`,
            ),
          ],
        });
        return;
      }

      if (sub === 'reroll') {
        requireManager(interaction, 'reroll giveaways');
        const id = interaction.options.getInteger('id', true);
        const count = interaction.options.getInteger('winners') ?? 1;
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const giveaway = await services.repos.community.getGiveaway(id);
        if (!giveaway || giveaway.guild_id !== guild.id)
          throw new UserFacingError(`Giveaway #${id} was not found in this server.`);
        if (giveaway.cancelled)
          throw new UserFacingError('That giveaway was cancelled, so it cannot be rerolled.');
        const entries = await services.repos.community.listEntries(id);
        const previous = new Set(giveaway.winner_ids ?? []);
        const candidates: string[] = [];
        for (const entry of entries) {
          if (previous.has(entry.user_id)) continue;
          if (!(await guild.members.fetch(entry.user_id).catch(() => null))) continue;
          candidates.push(entry.user_id);
        }
        if (candidates.length === 0)
          throw new UserFacingError('There are no other entries to draw from.');
        const winners: string[] = [];
        const pool = [...candidates];
        while (winners.length < Math.min(count, candidates.length) && pool.length > 0) {
          const [picked] = pool.splice(Math.floor(Math.random() * pool.length), 1);
          if (picked) winners.push(picked);
        }
        const updated = await services.repos.community.rerollGiveaway(id, winners);
        if (!updated)
          throw new UserFacingError(
            'That giveaway could not be updated — it may have been cancelled.',
          );

        const channel = guild.channels.cache.get(giveaway.channel_id);
        const announcement = `🎲 Reroll for **${giveaway.prize}**: ${winners.map((winner) => `<@${winner}>`).join(', ')}`;
        if (channel?.isSendable()) await channel.send({ content: announcement }).catch(() => {});
        await interaction.editReply({
          embeds: [
            successEmbed(
              `New winners for giveaway **#${id}**: ${winners.map((winner) => `<@${winner}>`).join(', ')}`,
            ),
          ],
        });
        return;
      }

      if (sub === 'cancel') {
        requireManager(interaction, 'cancel giveaways');
        const id = interaction.options.getInteger('id', true);
        const giveaway = await services.repos.community.getGiveaway(id);
        if (!giveaway || giveaway.guild_id !== guild.id)
          throw new UserFacingError(`Giveaway #${id} was not found in this server.`);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const confirmed = await confirmAction(interaction, {
          title: `Cancel giveaway #${id}?`,
          description: `**${truncate(giveaway.prize, 100)}** will be cancelled and its entries voided.`,
          confirmLabel: 'Cancel giveaway',
          danger: true,
        });
        if (!confirmed) {
          await interaction.editReply({ embeds: [warningEmbed('Nothing was changed.')] });
          return;
        }
        const cancelled = await services.repos.community.cancelGiveaway(id);
        await interaction.editReply({
          embeds: [
            cancelled
              ? successEmbed(`Giveaway **#${id}** was cancelled.`)
              : warningEmbed('That giveaway had already ended, so it was not cancelled.'),
          ],
        });
        return;
      }

      if (sub === 'list') {
        requireManager(interaction, 'list giveaways');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const giveaways = await services.repos.community.listGiveaways(guild.id, true, 50);
        await sendPaginated(
          interaction,
          giveaways,
          (giveaway) =>
            [
              `**#${giveaway.id}** ${truncate(giveaway.prize, 80)}`,
              `host <@${giveaway.host_id}> • winners drawn: ${(giveaway.winner_ids ?? []).length}/${giveaway.winners_count}`,
              giveaway.cancelled
                ? 'cancelled'
                : giveaway.ended
                  ? `ended ${formatRelativeTimestamp(new Date(giveaway.ended_at ?? giveaway.created_at).getTime())} • winners ${(giveaway.winner_ids ?? []).length}`
                  : `ends ${formatRelativeTimestamp(new Date(giveaway.ends_at).getTime())}`,
            ].join('\n'),
          { title: '🎉 Giveaways', pageSize: 5, emptyMessage: 'This server has no giveaways yet.' },
        );
        return;
      }

      // settings
      requireManager(interaction, 'view giveaway settings');
      const settings = await services.settings.get<GiveawaySettings>(guild.id, 'giveaways');
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [
          baseEmbed(COLORS.primary)
            .setTitle('🎉 Giveaway settings')
            .setDescription(
              [
                `Enabled: **${settings.enabled}**`,
                `Default duration: **${formatDuration(settings.defaultDurationMs)}**`,
                `Max winners: **${settings.maxWinners}**`,
                `Winner DM: **${settings.winnerDmEnabled}**`,
                `Required role: ${settings.requireRoleId ? `<@&${settings.requireRoleId}>` : 'none'}`,
                `Bonus roles: ${settings.bonusRoleIds.map((id) => `<@&${id}>`).join(', ') || 'none'}`,
                `Minimum account age: **${settings.minAccountAgeDays} day(s)**`,
                `Log channel: ${settings.logChannelId ? `<#${settings.logChannelId}>` : 'not set'}`,
              ].join('\n'),
            ),
        ],
      });
    },
  },

  /* ---------------------------------------------------------------- suggestions */
  {
    category: 'community',
    data: new SlashCommandBuilder()
      .setName('suggestion')
      .setDescription('Suggestions with staff decisions')
      .addSubcommand((sub) =>
        sub
          .setName('setup')
          .setDescription('Configure where suggestions are posted')
          .addChannelOption((option) =>
            option
              .setName('channel')
              .setDescription('Suggestion channel')
              .addChannelTypes(ChannelType.GuildText),
          )
          .addChannelOption((option) =>
            option
              .setName('log_channel')
              .setDescription('Where staff decisions are logged')
              .addChannelTypes(ChannelType.GuildText),
          )
          .addBooleanOption((option) =>
            option.setName('enabled').setDescription('Enable or disable suggestions'),
          )
          .addBooleanOption((option) =>
            option.setName('anonymous').setDescription('Hide the author of suggestions'),
          )
          .addBooleanOption((option) =>
            option.setName('threads').setDescription('Create a discussion thread per suggestion'),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('submit')
          .setDescription('Submit a suggestion')
          .addStringOption((option) =>
            option
              .setName('content')
              .setDescription('Your suggestion')
              .setRequired(true)
              .setMaxLength(1500),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('resolve')
          .setDescription('Decide on a suggestion')
          .addIntegerOption((option) =>
            option.setName('id').setDescription('Suggestion id').setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName('status')
              .setDescription('Decision')
              .setRequired(true)
              .addChoices(
                { name: 'accepted', value: 'accepted' },
                { name: 'denied', value: 'denied' },
                { name: 'implemented', value: 'implemented' },
                { name: 'considered', value: 'considered' },
              ),
          )
          .addStringOption((option) =>
            option
              .setName('response')
              .setDescription('Message shown with the decision')
              .setMaxLength(1000),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('list')
          .setDescription('List recent suggestions')
          .addStringOption((option) =>
            option
              .setName('status')
              .setDescription('Filter by status')
              .addChoices(
                { name: 'open', value: 'open' },
                { name: 'accepted', value: 'accepted' },
                { name: 'denied', value: 'denied' },
                { name: 'implemented', value: 'implemented' },
                { name: 'considered', value: 'considered' },
              ),
          ),
      ),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const sub = interaction.options.getSubcommand(true);

      if (sub === 'setup') {
        requireManager(interaction, 'configure suggestions');
        const channel = interaction.options.getChannel('channel');
        const logChannel = interaction.options.getChannel('log_channel');
        const enabled = interaction.options.getBoolean('enabled');
        const anonymous = interaction.options.getBoolean('anonymous');
        const threads = interaction.options.getBoolean('threads');
        const patch: Record<string, unknown> = {};
        if (channel) patch['channelId'] = channel.id;
        if (logChannel) patch['logChannelId'] = logChannel.id;
        if (enabled !== null) patch['enabled'] = enabled;
        if (anonymous !== null) patch['anonymous'] = anonymous;
        if (threads !== null) patch['threadEnabled'] = threads;
        if (Object.keys(patch).length === 0)
          throw new UserFacingError('Provide at least one option to change.');
        const settings = await services.settings.update<SuggestionSettings>(
          guild.id,
          'suggestions',
          patch,
          {
            actorId: interaction.user.id,
            source: 'command',
          },
        );
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          embeds: [
            successEmbed(
              [
                `Suggestions are **${settings.enabled ? 'enabled' : 'disabled'}**.`,
                `Channel: ${settings.channelId ? `<#${settings.channelId}>` : 'not set'}`,
                `Log channel: ${settings.logChannelId ? `<#${settings.logChannelId}>` : 'not set'}`,
                `Anonymous: **${settings.anonymous}**`,
                `Threads: **${settings.threadEnabled}**`,
              ].join('\n'),
            ),
          ],
        });
        return;
      }

      if (sub === 'submit') {
        const member = actor(interaction);
        const content = interaction.options.getString('content', true);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await services.community.submitSuggestion({ guild, member, content });
        await interaction.editReply({
          embeds: [successEmbed(`Suggestion **#${result.id}** was posted.`)],
        });
        return;
      }

      if (sub === 'resolve') {
        requireManager(interaction, 'resolve suggestions');
        const id = interaction.options.getInteger('id', true);
        const status = interaction.options.getString('status', true) as
          'accepted' | 'denied' | 'implemented' | 'considered';
        const response = interaction.options.getString('response');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await services.community.resolveSuggestion({
          guild,
          suggestionId: id,
          status,
          staffId: interaction.user.id,
          response: response ?? null,
        });
        await interaction.editReply({
          embeds: [successEmbed(`Suggestion **#${id}** was marked **${status}**.`)],
        });
        return;
      }

      // list
      requireManager(interaction, 'list suggestions');
      const status = interaction.options.getString('status');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const suggestions = await services.repos.community.listSuggestions(guild.id, {
        ...(status ? { status } : {}),
        limit: 50,
      });
      await sendPaginated(
        interaction,
        suggestions,
        (suggestion) =>
          [
            `**#${suggestion.id}** (${suggestion.status}) — ${truncate(suggestion.content, 120)}`,
            `by <@${suggestion.user_id}> • 👍 ${suggestion.upvotes} / 👎 ${suggestion.downvotes} • ${formatRelativeTimestamp(new Date(suggestion.created_at).getTime())}`,
          ].join('\n'),
        { title: '💡 Suggestions', pageSize: 5, emptyMessage: 'No suggestions match that filter.' },
      );
    },
  },

  /* ------------------------------------------------------------------ starboard */
  {
    category: 'community',
    data: new SlashCommandBuilder()
      .setName('starboard')
      .setDescription('Pin the best messages to a starboard channel')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) =>
        sub
          .setName('setup')
          .setDescription('Configure the starboard channel and threshold')
          .addChannelOption((option) =>
            option
              .setName('channel')
              .setDescription('Starboard channel')
              .addChannelTypes(ChannelType.GuildText),
          )
          .addIntegerOption((option) =>
            option
              .setName('threshold')
              .setDescription('Stars required')
              .setMinValue(1)
              .setMaxValue(100),
          )
          .addStringOption((option) =>
            option.setName('emoji').setDescription('Star emoji (default ⭐)').setMaxLength(64),
          )
          .addBooleanOption((option) =>
            option.setName('enabled').setDescription('Enable or disable the starboard'),
          )
          .addBooleanOption((option) =>
            option.setName('self_star').setDescription('Allow authors to star their own message'),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('ignore')
          .setDescription('Ignore or unignore a channel')
          .addChannelOption((option) =>
            option.setName('channel').setDescription('Channel to ignore').setRequired(true),
          )
          .addBooleanOption((option) =>
            option.setName('remove').setDescription('Remove the channel from the ignore list'),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName('status').setDescription('Show the starboard configuration'),
      ),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      requireManager(interaction, 'configure the starboard');
      const sub = interaction.options.getSubcommand(true);

      if (sub === 'setup') {
        const channel = interaction.options.getChannel('channel');
        const threshold = interaction.options.getInteger('threshold');
        const emoji = interaction.options.getString('emoji');
        const enabled = interaction.options.getBoolean('enabled');
        const selfStar = interaction.options.getBoolean('self_star');
        const patch: Record<string, unknown> = {};
        if (channel) patch['channelId'] = channel.id;
        if (threshold !== null) patch['threshold'] = threshold;
        if (emoji) patch['emoji'] = emoji;
        if (enabled !== null) patch['enabled'] = enabled;
        if (selfStar !== null) patch['selfStar'] = selfStar;
        if (Object.keys(patch).length === 0)
          throw new UserFacingError('Provide at least one option to change.');
        const settings = await services.settings.update<StarboardSettings>(
          guild.id,
          'starboard',
          patch,
          {
            actorId: interaction.user.id,
            source: 'command',
          },
        );
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          embeds: [
            successEmbed(
              [
                `Starboard: **${settings.enabled ? 'enabled' : 'disabled'}**`,
                `Channel: ${settings.channelId ? `<#${settings.channelId}>` : 'not set'}`,
                `Threshold: **${settings.threshold}** ${settings.emoji}`,
                `Self-star: **${settings.selfStar}**`,
              ].join('\n'),
            ),
          ],
        });
        return;
      }

      if (sub === 'ignore') {
        const channel = interaction.options.getChannel('channel', true);
        const remove = interaction.options.getBoolean('remove') === true;
        const settings = await services.settings.get<StarboardSettings>(guild.id, 'starboard');
        const next = remove
          ? settings.ignoreChannelIds.filter((id) => id !== channel.id)
          : [...new Set([...settings.ignoreChannelIds, channel.id])];
        await services.settings.update(
          guild.id,
          'starboard',
          { ignoreChannelIds: next },
          {
            actorId: interaction.user.id,
            source: 'command',
          },
        );
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          embeds: [
            successEmbed(`${remove ? 'Unignored' : 'Ignored'} <#${channel.id}> for the starboard.`),
          ],
        });
        return;
      }

      const settings = await services.settings.get<StarboardSettings>(guild.id, 'starboard');
      const tracked = await services.repos.analytics.guildOverview(guild.id).catch(() => null);
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [
          baseEmbed(COLORS.primary)
            .setTitle('⭐ Starboard status')
            .setDescription(
              [
                `Enabled: **${settings.enabled}**`,
                `Channel: ${settings.channelId ? `<#${settings.channelId}>` : 'not set'}`,
                `Emoji: ${settings.emoji}`,
                `Threshold: **${settings.threshold}**`,
                `Self-star: **${settings.selfStar}**`,
                `Ignored channels: ${settings.ignoreChannelIds.map((id) => `<#${id}>`).join(', ') || 'none'}`,
                tracked ? `Tracked members: **${tracked.trackedUsers}**` : null,
              ]
                .filter(Boolean)
                .join('\n'),
            ),
        ],
      });
    },
  },

  /* ------------------------------------------------------------------ birthdays */
  {
    category: 'community',
    data: new SlashCommandBuilder()
      .setName('birthday')
      .setDescription('Birthday announcements')
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('Save your birthday')
          .addIntegerOption((option) =>
            option
              .setName('month')
              .setDescription('Month (1-12)')
              .setRequired(true)
              .setMinValue(1)
              .setMaxValue(12),
          )
          .addIntegerOption((option) =>
            option
              .setName('day')
              .setDescription('Day (1-31)')
              .setRequired(true)
              .setMinValue(1)
              .setMaxValue(31),
          )
          .addIntegerOption((option) =>
            option
              .setName('year')
              .setDescription('Year (optional, never shown publicly)')
              .setMinValue(1900)
              .setMaxValue(2100),
          ),
      )
      .addSubcommand((sub) => sub.setName('remove').setDescription('Delete your saved birthday'))
      .addSubcommand((sub) =>
        sub.setName('list').setDescription('Upcoming birthdays in this server'),
      )
      .addSubcommand((sub) =>
        sub
          .setName('setup')
          .setDescription('Configure birthday announcements')
          .addChannelOption((option) =>
            option
              .setName('channel')
              .setDescription('Announcement channel')
              .addChannelTypes(ChannelType.GuildText),
          )
          .addStringOption((option) =>
            option
              .setName('message')
              .setDescription('Message ({user} is replaced)')
              .setMaxLength(1000),
          )
          .addRoleOption((option) =>
            option.setName('role').setDescription('Role granted on the birthday'),
          )
          .addBooleanOption((option) =>
            option.setName('enabled').setDescription('Enable or disable birthdays'),
          )
          .addIntegerOption((option) =>
            option
              .setName('timezone_offset')
              .setDescription('Timezone offset in minutes from UTC (e.g. 330 for IST)')
              .setMinValue(-720)
              .setMaxValue(840),
          ),
      ),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const sub = interaction.options.getSubcommand(true);

      if (sub === 'set') {
        const month = interaction.options.getInteger('month', true);
        const day = interaction.options.getInteger('day', true);
        const year = interaction.options.getInteger('year');
        const maxDay = new Date(Date.UTC(2024, month, 0)).getUTCDate();
        if (day > maxDay)
          throw new UserFacingError(
            `${MONTHS[month - 1] ?? 'That month'} has only ${maxDay} days.`,
          );
        await services.community.setBirthday({
          guildId: guild.id,
          userId: interaction.user.id,
          month,
          day,
          year: year ?? null,
        });
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          embeds: [
            successEmbed(
              `Saved your birthday as **${day} ${MONTHS[month - 1]}**${year ? ` (${year})` : ''}.`,
            ),
          ],
        });
        return;
      }

      if (sub === 'remove') {
        const removed = await services.repos.community.removeBirthday(
          guild.id,
          interaction.user.id,
        );
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          embeds: [
            removed
              ? successEmbed('Your birthday was deleted.')
              : warningEmbed('You had no birthday saved here.'),
          ],
        });
        return;
      }

      if (sub === 'list') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const birthdays = await services.repos.community.upcomingBirthdays(guild.id, 25);
        await sendPaginated(
          interaction,
          birthdays,
          (entry) =>
            `<@${entry.user_id}> — **${entry.day} ${MONTHS[entry.month - 1]}** ${
              entry.days_until === 0 ? '(today 🎂)' : `(in ${entry.days_until} day(s))`
            }`,
          {
            title: '🎂 Upcoming birthdays',
            pageSize: 10,
            emptyMessage: 'Nobody has saved a birthday in the next 60 days.',
          },
        );
        return;
      }

      // setup
      requireManager(interaction, 'configure birthdays');
      const channel = interaction.options.getChannel('channel');
      const message = interaction.options.getString('message');
      const role = interaction.options.getRole('role');
      const enabled = interaction.options.getBoolean('enabled');
      const offset = interaction.options.getInteger('timezone_offset');
      const patch: Record<string, unknown> = {};
      if (channel) patch['channelId'] = channel.id;
      if (message) patch['message'] = message;
      if (role) patch['roleId'] = role.id;
      if (enabled !== null) patch['enabled'] = enabled;
      if (offset !== null) patch['timezoneOffsetMinutes'] = offset;
      if (Object.keys(patch).length === 0)
        throw new UserFacingError('Provide at least one option to change.');
      const settings = await services.settings.update<BirthdaySettings>(
        guild.id,
        'birthday',
        patch,
        {
          actorId: interaction.user.id,
          source: 'command',
        },
      );
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [
          successEmbed(
            [
              `Birthdays are **${settings.enabled ? 'enabled' : 'disabled'}**.`,
              `Channel: ${settings.channelId ? `<#${settings.channelId}>` : 'not set'}`,
              `Message: ${truncate(settings.message, 120)}`,
              `Role: ${settings.roleId ? `<@&${settings.roleId}>` : 'none'}`,
              `Timezone offset: **${settings.timezoneOffsetMinutes} minutes**`,
            ].join('\n'),
          ),
        ],
      });
    },
  },

  /* ------------------------------------------------------------------ reminders */
  {
    category: 'community',
    data: new SlashCommandBuilder()
      .setName('reminder')
      .setDescription('Manage your scheduled reminders')
      .addSubcommand((sub) =>
        sub.setName('list').setDescription('List your pending reminders in this server'),
      )
      .addSubcommand((sub) =>
        sub
          .setName('cancel')
          .setDescription('Cancel one of your reminders')
          .addIntegerOption((option) =>
            option
              .setName('id')
              .setDescription('Reminder id from /reminder list')
              .setRequired(true),
          ),
      ),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const sub = interaction.options.getSubcommand(true);

      if (sub === 'list') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const reminders = await services.repos.community.listUserReminders(
          guild.id,
          interaction.user.id,
          25,
        );
        await sendPaginated(
          interaction,
          reminders,
          (reminder) =>
            `**#${reminder.id}** — ${truncate(reminder.content, 120)}\n${formatRelativeTimestamp(new Date(reminder.remind_at).getTime())} (${formatTimestamp(new Date(reminder.remind_at).getTime())})`,
          {
            title: '⏰ Your reminders',
            pageSize: 5,
            emptyMessage: 'You have no pending reminders here.',
          },
        );
        return;
      }

      const id = interaction.options.getInteger('id', true);
      const cancelled = await services.repos.community.cancelReminder(
        guild.id,
        interaction.user.id,
        id,
      );
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [
          cancelled
            ? successEmbed(`Reminder **#${id}** was cancelled.`)
            : warningEmbed('That reminder was not found — it may already have been delivered.'),
        ],
      });
    },
  },
]);
