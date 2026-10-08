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
  formatRelativeTimestamp,
  formatTimestamp,
  parseDurationMs,
  shuffle,
  truncate,
  UserFacingError,
} from '@bot-by-ai/shared';
import { COLORS } from '../core/constants.js';
import { defineCommands, type BotCommand, type CommandContext } from '../core/command.js';
import { baseEmbed, successEmbed, warningEmbed } from '../core/embeds.js';
import { confirmAction, sendPaginated } from '../core/ui.js';
import { requireUserPermissions } from '../core/resolvers.js';

function guildOf(interaction: ChatInputCommandInteraction): Guild {
  if (!interaction.guild) throw new UserFacingError('This command only works inside a server.');
  return interaction.guild;
}

function actor(interaction: ChatInputCommandInteraction): GuildMember {
  const member = interaction.member;
  if (!member || !(member instanceof GuildMember)) throw new UserFacingError('Use this inside a server.');
  return member;
}

export const commands: BotCommand[] = defineCommands([
  {
    category: 'community',
    data: new SlashCommandBuilder()
      .setName('giveaway')
      .setDescription('Run giveaways')
      .addSubcommand((sub) =>
        sub
          .setName('start')
          .setDescription('Start a giveaway')
          .addStringOption((option) => option.setName('prize').setDescription('Prize').setRequired(true))
          .addStringOption((option) => option.setName('duration').setDescription('e.g. 1h, 2d, 30m').setRequired(true))
          .addIntegerOption((option) => option.setName('winners').setDescription('Number of winners (default 1)').setMinValue(1).setMaxValue(50))
          .addChannelOption((option) =>
            option.setName('channel').setDescription('Channel (defaults to here)').addChannelTypes(ChannelType.GuildText),
          )
          .addRoleOption((option) => option.setName('required_role').setDescription('Role required to enter'))
          .addRoleOption((option) => option.setName('bonus_role').setDescription('Role that doubles entries')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('end')
          .setDescription('End a giveaway early')
          .addIntegerOption((option) => option.setName('id').setDescription('Giveaway id').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('reroll')
          .setDescription('Draw replacement winners')
          .addIntegerOption((option) => option.setName('id').setDescription('Giveaway id').setRequired(true))
          .addIntegerOption((option) => option.setName('winners').setDescription('How many to draw').setMinValue(1).setMaxValue(20)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('cancel')
          .setDescription('Cancel a giveaway and void its entries')
          .addIntegerOption((option) => option.setName('id').setDescription('Giveaway id').setRequired(true)),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('List giveaways in this server'))
      .addSubcommand((sub) => sub.setName('settings').setDescription('Show giveaway settings')),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const member = actor(interaction);
      const sub = interaction.options.getSubcommand(true);
      const settings = await services.settings.get<{
        enabled: boolean;
        defaultDurationMs: number;
        maxWinners: number;
        bonusRoleIds: string[];
        requireRoleId: string | null;
        winnerDmEnabled: boolean;
      }>(guild.id, 'giveaways');

      if (sub === 'start') {
        requireUserPermissions(member, [PermissionFlagsBits.ManageMessages], 'giveaway hosting');
        const prize = interaction.options.getString('prize', true);
        const durationMs = parseDurationMs(interaction.options.getString('duration', true));
        if (!durationMs) throw new UserFacingError('Could not parse that duration — try `1h`, `30m`, or `2d`.');
        const winners = interaction.options.getInteger('winners') ?? 1;
        const channel = interaction.options.getChannel('channel') ?? interaction.channel;
        const requiredRole = interaction.options.getRole('required_role');
        const bonusRole = interaction.options.getRole('bonus_role');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await services.community.startGiveaway({
          guild,
          channelId: channel?.id ?? interaction.channelId,
          hostId: interaction.user.id,
          prize,
          durationMs,
          winners,
          requiredRoleId: requiredRole?.id ?? null,
          bonusRoleIds: bonusRole ? [bonusRole.id] : undefined,
        });
        await interaction.editReply({
          embeds: [
            successEmbed(
              `Giveaway **${truncate(prize, 100)}** started (id \`${result.id}\`) — ends ${formatRelativeTimestamp(result.endsAt)}.`,
            ),
          ],
        });
        return;
      }

      if (sub === 'list') {
        const rows = await services.repos.community.listGiveaways(guild.id, true, 25);
        await interaction.reply({
          embeds: [
            baseEmbed(COLORS.primary)
              .setTitle('🎉 Giveaways')
              .setDescription(
                rows.length === 0
                  ? 'No giveaways yet.'
                  : rows
                      .map(
                        (row) =>
                          `\`${row.id}\` **${truncate(row.prize, 60)}** — ${row.cancelled ? 'cancelled' : row.ended ? `ended (${row.winner_ids.length} winner(s))` : `ends ${formatRelativeTimestamp(new Date(row.ends_at).getTime())}`} • host <@${row.host_id}>`,
                      )
                      .join('\n'),
              ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === 'settings') {
        await interaction.reply({
          embeds: [
            baseEmbed(settings.enabled ? COLORS.success : COLORS.warning)
              .setTitle('🎉 Giveaway settings')
              .addFields(
                { name: 'Enabled', value: settings.enabled ? 'yes' : 'no', inline: true },
                { name: 'Default duration', value: `${Math.round(settings.defaultDurationMs / 60_000)} min`, inline: true },
                { name: 'Max winners', value: String(settings.maxWinners), inline: true },
                { name: 'Required role', value: settings.requireRoleId ? `<@&${settings.requireRoleId}>` : 'none', inline: true },
                { name: 'Bonus roles', value: settings.bonusRoleIds.map((id) => `<@&${id}>`).join(' ') || 'none', inline: true },
                { name: 'Winner DMs', value: settings.winnerDmEnabled ? 'enabled' : 'disabled', inline: true },
              ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const id = interaction.options.getInteger('id', true);
      const giveaway = await services.repos.community.getGiveaway(id);
      if (!giveaway || giveaway.guild_id !== guild.id) throw new UserFacingError(`Giveaway \`${id}\` was not found in this server.`);

      if (sub === 'end') {
        requireUserPermissions(member, [PermissionFlagsBits.ManageMessages], 'giveaway hosting');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await services.community.endGiveaway({ guild, giveawayId: id });
        await interaction.editReply({
          embeds: [
            successEmbed(
              `Giveaway **${truncate(result.prize, 80)}** ended after ${result.entries} entry record(s). Winners: ${result.winners.map((winner) => `<@${winner}>`).join(', ') || 'none'}`,
            ),
          ],
        });
        return;
      }

      if (sub === 'reroll') {
        requireUserPermissions(member, [PermissionFlagsBits.ManageMessages], 'giveaway hosting');
        if (!giveaway.ended) throw new UserFacingError('End the giveaway before rerolling winners.');
        const count = interaction.options.getInteger('winners') ?? 1;
        await interaction.deferReply();
        const entries = await services.repos.community.listEntries(id);
        const pool = shuffle([...new Set(entries.map((entry) => entry.user_id))]).filter(
          (userId) => !giveaway.winner_ids.includes(userId),
        );
        const picked = pool.slice(0, count);
        await services.repos.community.endGiveaway(id, [...giveaway.winner_ids, ...picked]);
        const channel = await guild.channels.fetch(giveaway.channel_id).catch(() => null);
        if (channel?.isTextBased()) {
          await channel
            .send({
              content:
                picked.length > 0
                  ? `🎉 Reroll: congratulations ${picked.map((userId) => `<@${userId}>`).join(', ')} — you won **${giveaway.prize}**!`
                  : `Reroll for **${giveaway.prize}** produced no eligible winners.`,
            })
            .catch(() => {});
        }
        await interaction.editReply({
          embeds: [successEmbed(picked.map((userId) => `<@${userId}>`).join(', ') || 'No eligible entries left to draw from.')],
        });
        return;
      }

      // cancel
      requireUserPermissions(member, [PermissionFlagsBits.ManageMessages], 'giveaway hosting');
      const confirmed = await confirmAction(interaction, {
        title: 'Cancel giveaway',
        description: `Cancel **${truncate(giveaway.prize, 100)}** (id \`${id}\`)? Existing entries are voided and the giveaway message is updated.`,
        confirmLabel: 'Cancel the giveaway',
      });
      if (!confirmed) return;
      if (!giveaway.ended) {
        await services.repos.community.cancelGiveaway(id);
        const channel = await guild.channels.fetch(giveaway.channel_id).catch(() => null);
        if (channel?.isTextBased() && giveaway.message_id) {
          const message = await channel.messages.fetch(giveaway.message_id).catch(() => null);
          await message
            ?.edit({
              embeds: [baseEmbed(COLORS.danger).setTitle('❌ Giveaway cancelled').setDescription(`**${giveaway.prize}** was cancelled by <@${interaction.user.id}>.`)],
              components: [],
            })
            .catch(() => {});
        }
      }
      await interaction.editReply({ embeds: [successEmbed(`Giveaway \`${id}\` cancelled.`)], components: [] });
    },
  },
  {
    category: 'community',
    data: new SlashCommandBuilder()
      .setName('suggestion')
      .setDescription('Suggestions board')
      .addSubcommand((sub) =>
        sub
          .setName('submit')
          .setDescription('Submit a suggestion')
          .addStringOption((option) => option.setName('text').setDescription('Your suggestion').setRequired(true).setMaxLength(2000)),
      )
      .addSubcommand((sub) => sub.setName('setup').setDescription('Show the suggestion configuration'))
      .addSubcommand((sub) =>
        sub
          .setName('channel')
          .setDescription('Set the suggestion channel')
          .addChannelOption((option) => option.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(ChannelType.GuildText))
          .addChannelOption((option) => option.setName('log_channel').setDescription('Staff decision log channel').addChannelTypes(ChannelType.GuildText))
          .addBooleanOption((option) => option.setName('threads').setDescription('Create a discussion thread per suggestion'))
          .addBooleanOption((option) => option.setName('anonymous').setDescription('Hide the author in the embed')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('resolve')
          .setDescription('Accept, deny or implement a suggestion')
          .addIntegerOption((option) => option.setName('id').setDescription('Suggestion id').setRequired(true))
          .addStringOption((option) =>
            option
              .setName('status')
              .setDescription('New status')
              .setRequired(true)
              .addChoices(
                { name: 'accepted', value: 'accepted' },
                { name: 'denied', value: 'denied' },
                { name: 'implemented', value: 'implemented' },
                { name: 'considered', value: 'considered' },
              ),
          )
          .addStringOption((option) => option.setName('response').setDescription('Staff response shown publicly').setMaxLength(1000)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('delete')
          .setDescription('Delete a suggestion')
          .addIntegerOption((option) => option.setName('id').setDescription('Suggestion id').setRequired(true)),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('List suggestions')),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const member = actor(interaction);
      const sub = interaction.options.getSubcommand(true);
      const settings = await services.settings.get<{
        enabled: boolean;
        channelId: string | null;
        logChannelId: string | null;
        threadEnabled: boolean;
        anonymous: boolean;
        upvoteEmoji: string;
        downvoteEmoji: string;
      }>(guild.id, 'suggestions');

      if (sub === 'submit') {
        const text = interaction.options.getString('text', true);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await services.community.submitSuggestion({ guild, member, content: text });
        await interaction.editReply({
          embeds: [successEmbed(`Suggestion **#${result.id}** posted${result.messageId ? `: https://discord.com/channels/${guild.id}/${settings.channelId}/${result.messageId}` : '.'}`)],
        });
        return;
      }
      if (sub === 'setup') {
        await interaction.reply({
          embeds: [
            baseEmbed(settings.enabled ? COLORS.success : COLORS.warning)
              .setTitle('💡 Suggestion settings')
              .addFields(
                { name: 'Enabled', value: settings.enabled ? 'yes' : 'no', inline: true },
                { name: 'Channel', value: settings.channelId ? `<#${settings.channelId}>` : 'not set', inline: true },
                { name: 'Decision log', value: settings.logChannelId ? `<#${settings.logChannelId}>` : 'not set', inline: true },
                { name: 'Discussion threads', value: settings.threadEnabled ? 'enabled' : 'disabled', inline: true },
                { name: 'Anonymous', value: settings.anonymous ? 'yes' : 'no', inline: true },
                { name: 'Vote emojis', value: `${settings.upvoteEmoji} / ${settings.downvoteEmoji}`, inline: true },
              ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (sub === 'channel') {
        requireUserPermissions(member, [PermissionFlagsBits.ManageGuild], 'suggestion configuration');
        const channel = interaction.options.getChannel('channel', true);
        const logChannel = interaction.options.getChannel('log_channel');
        const threads = interaction.options.getBoolean('threads');
        const anonymous = interaction.options.getBoolean('anonymous');
        const patch: Record<string, unknown> = { enabled: true, channelId: channel.id };
        if (logChannel) patch.logChannelId = logChannel.id;
        if (threads !== null) patch.threadEnabled = threads;
        if (anonymous !== null) patch.anonymous = anonymous;
        await services.settings.update(guild.id, 'suggestions', patch, { actorId: interaction.user.id, source: 'command' });
        await interaction.reply({
          embeds: [successEmbed(`Suggestions will be posted in <#${channel.id}>.`)],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (sub === 'resolve') {
        requireUserPermissions(member, [PermissionFlagsBits.ManageMessages], 'suggestion moderation');
        const id = interaction.options.getInteger('id', true);
        const status = interaction.options.getString('status', true) as 'accepted' | 'denied' | 'implemented' | 'considered';
        const response = interaction.options.getString('response');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await services.community.resolveSuggestion({
          guild,
          suggestionId: id,
          status,
          staffId: interaction.user.id,
          response: response ?? null,
        });
        await interaction.editReply({ embeds: [successEmbed(`Suggestion #${id} marked **${status}**.`)] });
        return;
      }
      if (sub === 'delete') {
        requireUserPermissions(member, [PermissionFlagsBits.ManageMessages], 'suggestion moderation');
        const id = interaction.options.getInteger('id', true);
        const suggestions = await services.repos.community.listSuggestions(guild.id, { limit: 100 });
        if (!suggestions.some((row) => row.id === id)) throw new UserFacingError(`Suggestion #${id} was not found.`);
        await services.db.query('DELETE FROM suggestions WHERE guild_id = $1 AND id = $2', [guild.id, id]);
        await interaction.reply({ embeds: [successEmbed(`Suggestion #${id} deleted from the database.`)], flags: MessageFlags.Ephemeral });
        return;
      }
      const rows = await services.repos.community.listSuggestions(guild.id, { limit: 100 });
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await sendPaginated(
        interaction,
        rows,
        (row) =>
          `**#${row.id}** \`${row.status}\` ${truncate(row.content.replace(/\n/g, ' '), 120)}\n<@${row.user_id}> — 👍 ${row.upvotes} / 👎 ${row.downvotes}${row.staff_response ? `\nStaff: ${truncate(row.staff_response, 120)}` : ''}`,
        { title: '💡 Suggestions', pageSize: 6, emptyMessage: 'No suggestions yet.' },
      );
    },
  },
  {
    category: 'community',
    data: new SlashCommandBuilder()
      .setName('starboard')
      .setDescription('Starboard configuration and status')
      .addSubcommand((sub) => sub.setName('status').setDescription('Show the starboard configuration'))
      .addSubcommand((sub) =>
        sub
          .setName('setup')
          .setDescription('Configure the starboard')
          .addChannelOption((option) => option.setName('channel').setDescription('Starboard channel').addChannelTypes(ChannelType.GuildText))
          .addIntegerOption((option) => option.setName('threshold').setDescription('Stars required (1-50)').setMinValue(1).setMaxValue(50))
          .addStringOption((option) => option.setName('emoji').setDescription('Star emoji (default ⭐)'))
          .addBooleanOption((option) => option.setName('enabled').setDescription('Enable or disable the starboard'))
          .addBooleanOption((option) => option.setName('self_star').setDescription('Allow authors to star their own messages'))
          .addBooleanOption((option) => option.setName('media_only').setDescription('Only star messages with attachments/embeds')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('ignore')
          .setDescription('Ignore a channel for the starboard')
          .addChannelOption((option) => option.setName('channel').setDescription('Channel').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('top')
          .setDescription('Show the most starred messages')
          .addIntegerOption((option) => option.setName('limit').setDescription('How many (default 10)').setMinValue(1).setMaxValue(25)),
      ),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const member = actor(interaction);
      const sub = interaction.options.getSubcommand(true);
      const settings = await services.settings.get<{
        enabled: boolean;
        channelId: string | null;
        threshold: number;
        emoji: string;
        selfStar: boolean;
        mediaOnly: boolean;
        ignoreChannelIds: string[];
        maxAgeDays: number;
      }>(guild.id, 'starboard');

      if (sub === 'status') {
        await interaction.reply({
          embeds: [
            baseEmbed(settings.enabled ? COLORS.economy : COLORS.warning)
              .setTitle('⭐ Starboard settings')
              .addFields(
                { name: 'Enabled', value: settings.enabled ? 'yes' : 'no', inline: true },
                { name: 'Channel', value: settings.channelId ? `<#${settings.channelId}>` : 'not set', inline: true },
                { name: 'Threshold', value: `${settings.emoji} ${settings.threshold}`, inline: true },
                { name: 'Self-star', value: settings.selfStar ? 'allowed' : 'blocked', inline: true },
                { name: 'Media only', value: settings.mediaOnly ? 'yes' : 'no', inline: true },
                { name: 'Max age', value: `${settings.maxAgeDays} day(s)`, inline: true },
                { name: 'Ignored channels', value: settings.ignoreChannelIds.map((id) => `<#${id}>`).join(' ') || 'none' },
              ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (sub === 'top') {
        const limit = interaction.options.getInteger('limit') ?? 10;
        const result = await services.db.query<{
          source_message_id: string;
          source_channel_id: string;
          star_count: number;
        }>(
          `SELECT source_message_id, source_channel_id, star_count
             FROM starboard_entries WHERE guild_id = $1 ORDER BY star_count DESC LIMIT $2`,
          [guild.id, limit],
        );
        await interaction.deferReply();
        await sendPaginated(
          interaction,
          result.rows,
          (row) =>
            `⭐ **${row.star_count}** — [message](https://discord.com/channels/${guild.id}/${row.source_channel_id}/${row.source_message_id})`,
          { title: '⭐ Most starred messages', pageSize: 10, emptyMessage: 'Nothing has been starred yet.' },
        );
        return;
      }
      requireUserPermissions(member, [PermissionFlagsBits.ManageGuild], 'starboard configuration');
      if (sub === 'ignore') {
        const channel = interaction.options.getChannel('channel', true);
        const ignoreChannelIds = settings.ignoreChannelIds.includes(channel.id)
          ? settings.ignoreChannelIds.filter((id) => id !== channel.id)
          : [...settings.ignoreChannelIds, channel.id];
        await services.settings.update(guild.id, 'starboard', { ignoreChannelIds }, { actorId: interaction.user.id, source: 'command' });
        await interaction.reply({
          embeds: [
            successEmbed(
              `${settings.ignoreChannelIds.includes(channel.id) ? 'No longer ignoring' : 'Ignoring'} <#${channel.id}> for the starboard.`,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const channel = interaction.options.getChannel('channel');
      const threshold = interaction.options.getInteger('threshold');
      const emoji = interaction.options.getString('emoji');
      const enabled = interaction.options.getBoolean('enabled');
      const selfStar = interaction.options.getBoolean('self_star');
      const mediaOnly = interaction.options.getBoolean('media_only');
      const patch: Record<string, unknown> = {};
      if (channel) patch.channelId = channel.id;
      if (threshold !== null) patch.threshold = threshold;
      if (emoji) patch.emoji = emoji;
      if (enabled !== null) patch.enabled = enabled;
      if (selfStar !== null) patch.selfStar = selfStar;
      if (mediaOnly !== null) patch.mediaOnly = mediaOnly;
      const updated = await services.settings.update<{ enabled: boolean; channelId: string | null; threshold: number; emoji: string }>(
        guild.id,
        'starboard',
        patch,
        { actorId: interaction.user.id, source: 'command' },
      );
      if (updated.enabled && !updated.channelId) throw new UserFacingError('Set a starboard channel before enabling the starboard.');
      await interaction.reply({
        embeds: [
          successEmbed(
            `Starboard ${updated.enabled ? 'enabled' : 'configured'}: channel ${updated.channelId ? `<#${updated.channelId}>` : 'not set'}, threshold ${updated.emoji} ${updated.threshold}.`,
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    category: 'community',
    data: new SlashCommandBuilder()
      .setName('birthday')
      .setDescription('Birthday tracking')
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('Save your birthday')
          .addIntegerOption((option) => option.setName('day').setDescription('Day of month').setRequired(true).setMinValue(1).setMaxValue(31))
          .addIntegerOption((option) => option.setName('month').setDescription('Month').setRequired(true).setMinValue(1).setMaxValue(12))
          .addIntegerOption((option) => option.setName('year').setDescription('Year (optional, never shown publicly)').setMinValue(1900).setMaxValue(2100)),
      )
      .addSubcommand((sub) => sub.setName('remove').setDescription('Delete your saved birthday'))
      .addSubcommand((sub) => sub.setName('next').setDescription('Show upcoming birthdays'))
      .addSubcommand((sub) =>
        sub
          .setName('setup')
          .setDescription('Configure birthday announcements')
          .addChannelOption((option) => option.setName('channel').setDescription('Announcement channel').addChannelTypes(ChannelType.GuildText))
          .addRoleOption((option) => option.setName('role').setDescription('Temporary birthday role'))
          .addStringOption((option) => option.setName('message').setDescription('Message template with {user}'))
          .addIntegerOption((option) => option.setName('timezone_offset').setDescription('UTC offset in minutes (-720 to 840)').setMinValue(-720).setMaxValue(840))
          .addBooleanOption((option) => option.setName('enabled').setDescription('Enable birthday announcements')),
      ),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const member = actor(interaction);
      const sub = interaction.options.getSubcommand(true);
      const settings = await services.settings.get<{
        enabled: boolean;
        channelId: string | null;
        roleId: string | null;
        message: string;
        timezoneOffsetMinutes: number;
      }>(guild.id, 'birthday');

      if (sub === 'set') {
        const day = interaction.options.getInteger('day', true);
        const month = interaction.options.getInteger('month', true);
        const year = interaction.options.getInteger('year');
        const daysInMonth = new Date(Date.UTC(2024, month, 0)).getUTCDate();
        if (day > daysInMonth) throw new UserFacingError(`Month ${month} has only ${daysInMonth} days.`);
        await services.community.setBirthday({ guildId: guild.id, userId: interaction.user.id, month, day, year: year ?? null });
        await interaction.reply({
          embeds: [
            successEmbed(
              `Birthday saved: **${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}**${year ? ' (year stored privately)' : ''}.`,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (sub === 'remove') {
        const removed = await services.repos.community.removeBirthday(guild.id, interaction.user.id);
        await interaction.reply({
          embeds: [removed ? successEmbed('Your birthday entry was deleted.') : warningEmbed('You have no saved birthday.')],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (sub === 'next') {
        const now = new Date(Date.now() + settings.timezoneOffsetMinutes * 60_000);
        const rows = await services.repos.community.upcomingBirthdays(guild.id, 15);
        void now;
        await interaction.reply({
          embeds: [
            baseEmbed(COLORS.primary)
              .setTitle('🎂 Upcoming birthdays')
              .setDescription(
                rows.length === 0
                  ? 'No birthdays recorded in the next 30 days.'
                  : rows
                      .map((row) => {
                        if (row.days_until === 0) return `**Today** — <@${row.user_id}> 🎉`;
                        const when = new Date(Date.now() + row.days_until * 86_400_000);
                        return `<t:${Math.floor(when.getTime() / 1000)}:D> (${row.days_until} day(s)) — <@${row.user_id}>`;
                      })
                      .join('\n'),
              )
              .setFooter({ text: 'Use /birthday set to add yours' }),
          ],
        });
        return;
      }
      requireUserPermissions(member, [PermissionFlagsBits.ManageGuild], 'birthday configuration');
      const channel = interaction.options.getChannel('channel');
      const role = interaction.options.getRole('role');
      const message = interaction.options.getString('message');
      const offset = interaction.options.getInteger('timezone_offset');
      const enabled = interaction.options.getBoolean('enabled');
      const patch: Record<string, unknown> = {};
      if (channel) patch.channelId = channel.id;
      if (role) patch.roleId = role.id;
      if (message) patch.message = message;
      if (offset !== null) patch.timezoneOffsetMinutes = offset;
      if (enabled !== null) patch.enabled = enabled;
      const updated = await services.settings.update<{ enabled: boolean; channelId: string | null; roleId: string | null; message: string }>(
        guild.id,
        'birthday',
        patch,
        { actorId: interaction.user.id, source: 'command' },
      );
      if (updated.enabled && !updated.channelId) throw new UserFacingError('Set a birthday channel before enabling announcements.');
      await interaction.reply({
        embeds: [
          successEmbed(
            `Birthday announcements ${updated.enabled ? '**enabled**' : 'updated'}. Channel: ${updated.channelId ? `<#${updated.channelId}>` : 'not set'} • role: ${updated.roleId ? `<@&${updated.roleId}>` : 'none'}\nMessage: ${truncate(updated.message, 200)}`,
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    category: 'community',
    data: new SlashCommandBuilder()
      .setName('reminder')
      .setDescription('Manage your reminders')
      .addSubcommand((sub) => sub.setName('list').setDescription('List your pending reminders'))
      .addSubcommand((sub) =>
        sub
          .setName('delete')
          .setDescription('Delete one of your reminders')
          .addIntegerOption((option) => option.setName('id').setDescription('Reminder id').setRequired(true)),
      )
      .addSubcommand((sub) => sub.setName('clear').setDescription('Delete all of your pending reminders')),
    async execute({ interaction, services }: CommandContext) {
      const sub = interaction.options.getSubcommand(true);
      if (sub === 'list') {
        const rows = await services.repos.community.listUserReminders(interaction.guildId, interaction.user.id);
        await interaction.reply({
          embeds: [
            baseEmbed(COLORS.primary)
              .setTitle('⏰ Your reminders')
              .setDescription(
                rows.length === 0
                  ? 'You have no pending reminders. Create one with `/remind`.'
                  : rows
                      .map(
                        (row) =>
                          `\`${row.id}\` — ${truncate(row.content, 80)}\nDue ${formatRelativeTimestamp(new Date(row.remind_at).getTime())} (${formatTimestamp(new Date(row.remind_at).getTime())})`,
                      )
                      .join('\n\n'),
              ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (sub === 'delete') {
        const id = interaction.options.getInteger('id', true);
        const removed = await services.repos.community.cancelReminder(interaction.guildId, interaction.user.id, id);
        await interaction.reply({
          embeds: [removed ? successEmbed(`Reminder \`${id}\` deleted.`) : warningEmbed(`No pending reminder with id \`${id}\` belongs to you.`)],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const rows = await services.repos.community.listUserReminders(interaction.guildId, interaction.user.id);
      for (const row of rows) {
        await services.repos.community.cancelReminder(interaction.guildId, interaction.user.id, row.id);
      }
      await interaction.reply({
        embeds: [successEmbed(rows.length > 0 ? `Deleted ${rows.length} reminder(s).` : 'You had no pending reminders.')],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
]);
