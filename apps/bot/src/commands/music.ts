import {
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type VoiceBasedChannel,
} from 'discord.js';
import { formatDuration, truncate, UserFacingError } from '@bot-by-ai/shared';
import { COLORS } from '../core/constants.js';
import { defineCommands, type BotCommand, type CommandContext } from '../core/command.js';
import { baseEmbed, successEmbed, warningEmbed } from '../core/embeds.js';
import { sendPaginated } from '../core/ui.js';
import { requireUserPermissions } from '../core/resolvers.js';
import { checkMusicAccess, musicUnavailable, requireMusic } from '../core/music-access.js';

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

async function voiceChannelOf(
  interaction: ChatInputCommandInteraction,
  member: GuildMember,
): Promise<VoiceBasedChannel> {
  const guild = guildOf(interaction);
  await guild.voiceStates.fetch(member.id).catch(() => null);
  const channel = member.voice.channel;
  if (!channel)
    throw new UserFacingError('Join a voice channel first — I follow you into your channel.');
  const me = guild.members.me;
  const permissions = channel.permissionsFor(me ?? member.id);
  if (
    me &&
    (!permissions?.has(PermissionFlagsBits.Connect) || !permissions.has(PermissionFlagsBits.Speak))
  ) {
    throw new UserFacingError('I need **Connect** and **Speak** permission in that voice channel.');
  }
  return channel;
}

function queueLine(
  index: number,
  title: string,
  author: string,
  length: number,
  requestedBy: string,
): string {
  return `**${index}.** ${truncate(title, 60)} — ${truncate(author, 30)} \`${formatDuration(length)}\` (by <@${requestedBy}>)`;
}

export const commands: BotCommand[] = defineCommands([
  {
    category: 'music',
    data: new SlashCommandBuilder()
      .setName('play')
      .setDescription('Play a track or playlist from a URL or search query')
      .addStringOption((option) =>
        option.setName('query').setDescription('URL or search terms').setRequired(true),
      ),
    async execute({ interaction, services }: CommandContext) {
      const music = requireMusic(services);
      const guild = guildOf(interaction);
      const member = actor(interaction);
      const query = interaction.options.getString('query', true);
      const voiceChannel = await voiceChannelOf(interaction, member);
      await interaction.deferReply();
      const access = await checkMusicAccess(services, guild, member);
      if (!access.allowed)
        throw new UserFacingError(access.reason ?? 'You cannot control music here.');
      const result = await music.play({
        guild,
        member,
        voiceChannel,
        query,
        textChannelId: interaction.channelId,
      });
      const info = result.track.info;
      await interaction.editReply({
        embeds: [
          successEmbed(
            `${result.queued ? '➕ Queued' : '▶️ Now playing'} **${truncate(info.title, 100)}** by ${truncate(info.author, 60)}\n\`${formatDuration(info.length)}\` • source: \`${info.sourceName}\`${result.playlistName ? `\nPlaylist: **${truncate(result.playlistName, 80)}**` : ''}`,
          ),
        ],
      });
    },
  },
  {
    category: 'music',
    data: new SlashCommandBuilder()
      .setName('skip')
      .setDescription('Skip the current track')
      .addIntegerOption((option) =>
        option
          .setName('amount')
          .setDescription('How many tracks to skip')
          .setMinValue(1)
          .setMaxValue(50),
      ),
    async execute({ interaction, services }: CommandContext) {
      const music = requireMusic(services);
      const guild = guildOf(interaction);
      const member = actor(interaction);
      const access = await checkMusicAccess(services, guild, member);
      if (!access.allowed)
        throw new UserFacingError(access.reason ?? 'You cannot control music here.');
      await interaction.deferReply();
      const amount = Math.min(interaction.options.getInteger('amount') ?? 1, 50);
      const skipped: string[] = [];
      for (let index = 0; index < amount; index += 1) {
        try {
          skipped.push(await music.skip(guild.id));
        } catch {
          break;
        }
      }
      await interaction.editReply({
        embeds: [
          skipped.length > 0
            ? successEmbed(
                `Skipped: ${skipped.map((title) => `**${truncate(title, 60)}**`).join(', ')}`,
              )
            : warningEmbed('Nothing is playing right now.'),
        ],
      });
    },
  },
  {
    category: 'music',
    data: new SlashCommandBuilder()
      .setName('nowplaying')
      .setDescription('Show the track that is playing right now'),
    async execute({ interaction, services }: CommandContext) {
      const music = requireMusic(services);
      const guild = guildOf(interaction);
      const state = music.getState(guild.id);
      if (!state?.current) throw new UserFacingError('Nothing is playing right now.');
      const info = state.current.track.info;
      await interaction.reply({
        embeds: [
          baseEmbed(COLORS.primary)
            .setTitle('🎶 Now playing')
            .setDescription(`**${truncate(info.title, 120)}**\nby ${truncate(info.author, 80)}`)
            .addFields(
              {
                name: 'Length',
                value: info.isStream ? 'live stream' : formatDuration(info.length),
                inline: true,
              },
              { name: 'Source', value: info.sourceName, inline: true },
              { name: 'Requested by', value: `<@${state.current.requestedBy}>`, inline: true },
              { name: 'Loop', value: state.loop, inline: true },
              { name: 'Volume', value: `${state.volume}%`, inline: true },
              { name: 'Queued', value: `${state.queue.length} track(s)`, inline: true },
            )
            .setThumbnail(info.artworkUrl ?? null)
            .setURL(info.uri ?? null),
        ],
      });
    },
  },
  {
    category: 'music',
    data: new SlashCommandBuilder()
      .setName('queue')
      .setDescription('Show the upcoming tracks')
      .addIntegerOption((option) =>
        option.setName('page').setDescription('Page').setMinValue(1).setMaxValue(50),
      ),
    async execute({ interaction, services }: CommandContext) {
      const music = requireMusic(services);
      const guild = guildOf(interaction);
      const state = music.getState(guild.id);
      if (!state) throw new UserFacingError('I am not connected in this server.');
      const lines = state.queue.map((item, index) =>
        queueLine(
          index + 1,
          item.track.info.title,
          item.track.info.author,
          item.track.info.length,
          item.requestedBy,
        ),
      );
      const totalMs = state.queue.reduce(
        (sum, item) => sum + (item.track.info.isStream ? 0 : item.track.info.length),
        0,
      );
      await interaction.deferReply();
      await sendPaginated(
        interaction,
        lines.length > 0 ? lines : ['The queue is empty — add something with `/play`.'],
        (line) => line,
        {
          title: `🎵 Queue — ${state.current ? `now: ${truncate(state.current.track.info.title, 60)}` : 'idle'} (${state.queue.length} track(s), ${formatDuration(totalMs)} • loop ${state.loop} • volume ${state.volume}%)`,
          pageSize: 10,
        },
      );
    },
  },
  {
    category: 'music',
    data: new SlashCommandBuilder()
      .setName('volume')
      .setDescription('Set the player volume (1-200)')
      .addIntegerOption((option) =>
        option
          .setName('percent')
          .setDescription('Volume in percent')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(200),
      ),
    async execute({ interaction, services }: CommandContext) {
      const music = requireMusic(services);
      const guild = guildOf(interaction);
      const member = actor(interaction);
      const access = await checkMusicAccess(services, guild, member);
      if (!access.allowed)
        throw new UserFacingError(access.reason ?? 'You cannot control music here.');
      const percent = interaction.options.getInteger('percent', true);
      const applied = await music.setVolume(guild.id, percent);
      await interaction.reply({ embeds: [successEmbed(`Volume set to **${applied}%**.`)] });
    },
  },
  {
    category: 'music',
    data: new SlashCommandBuilder()
      .setName('music')
      .setDescription('Player controls, queue management and music settings')
      .addSubcommand((sub) =>
        sub
          .setName('join')
          .setDescription('Make the bot join your voice channel without playing anything'),
      )
      .addSubcommand((sub) =>
        sub
          .setName('leave')
          .setDescription('Disconnect the bot and clear the queue')
          .addBooleanOption((option) =>
            option.setName('force').setDescription('Leave even if a track is playing'),
          ),
      )
      .addSubcommand((sub) => sub.setName('pause').setDescription('Pause playback'))
      .addSubcommand((sub) => sub.setName('resume').setDescription('Resume playback'))
      .addSubcommand((sub) =>
        sub
          .setName('seek')
          .setDescription('Jump to a position in the current track')
          .addStringOption((option) =>
            option.setName('position').setDescription('e.g. 1m30s').setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('loop')
          .setDescription('Set the loop mode')
          .addStringOption((option) =>
            option
              .setName('mode')
              .setDescription('Loop mode')
              .setRequired(true)
              .addChoices(
                { name: 'off', value: 'off' },
                { name: 'track', value: 'track' },
                { name: 'queue', value: 'queue' },
              ),
          ),
      )
      .addSubcommand((sub) => sub.setName('shuffle').setDescription('Shuffle the queue'))
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Remove a track from the queue')
          .addIntegerOption((option) =>
            option
              .setName('position')
              .setDescription('Queue position')
              .setRequired(true)
              .setMinValue(1),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName('clear').setDescription('Clear the queue but keep the current track'),
      )
      .addSubcommand((sub) =>
        sub.setName('stop').setDescription('Stop playback and clear the queue'),
      )
      .addSubcommand((sub) =>
        sub.setName('settings').setDescription('Show the music configuration'),
      )
      .addSubcommand((sub) =>
        sub
          .setName('dj')
          .setDescription('Restrict music control to a DJ role')
          .addRoleOption((option) => option.setName('role').setDescription('DJ role'))
          .addBooleanOption((option) =>
            option.setName('remove').setDescription('Remove the role instead'),
          )
          .addBooleanOption((option) =>
            option.setName('enabled').setDescription('Enforce DJ-only control'),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('limit')
          .setDescription('Configure music limits')
          .addIntegerOption((option) =>
            option
              .setName('max_queue')
              .setDescription('Maximum queue size (1-500)')
              .setMinValue(1)
              .setMaxValue(500),
          )
          .addIntegerOption((option) =>
            option
              .setName('max_duration_minutes')
              .setDescription('Maximum track length in minutes')
              .setMinValue(1)
              .setMaxValue(600),
          )
          .addBooleanOption((option) =>
            option.setName('vote_skip').setDescription('Require a vote to skip'),
          )
          .addIntegerOption((option) =>
            option
              .setName('vote_skip_percent')
              .setDescription('Vote skip percentage (10-100)')
              .setMinValue(10)
              .setMaxValue(100),
          ),
      ),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const member = actor(interaction);
      const sub = interaction.options.getSubcommand(true);

      if (sub === 'settings' || sub === 'dj' || sub === 'limit') {
        requireUserPermissions(member, [PermissionFlagsBits.ManageGuild], 'music configuration');
      }
      if (musicUnavailable(services) && sub !== 'settings') {
        throw new UserFacingError(
          'Music is unavailable on this deployment: no Lavalink node is configured. See docs/COMMANDS.md → Music.',
        );
      }
      const settings = await services.settings.get<{
        enabled: boolean;
        djOnly: boolean;
        djRoleIds: string[];
        maxQueueSize: number;
        maxTrackDurationMs: number;
        voteSkip: boolean;
        voteSkipPercent: number;
        defaultVolume: number;
      }>(guild.id, 'music');

      if (sub === 'settings') {
        await interaction.reply({
          embeds: [
            baseEmbed(COLORS.primary)
              .setTitle('🎧 Music configuration')
              .addFields(
                { name: 'Enabled', value: settings.enabled ? 'yes' : 'no', inline: true },
                {
                  name: 'Lavalink node',
                  value: musicUnavailable(services) ? '**not configured**' : 'configured',
                  inline: true,
                },
                { name: 'DJ only', value: settings.djOnly ? 'yes' : 'no', inline: true },
                {
                  name: 'DJ roles',
                  value: settings.djRoleIds.map((id) => `<@&${id}>`).join(' ') || 'none',
                  inline: true,
                },
                { name: 'Max queue', value: String(settings.maxQueueSize), inline: true },
                {
                  name: 'Max track length',
                  value: `${Math.round(settings.maxTrackDurationMs / 60_000)} min`,
                  inline: true,
                },
                {
                  name: 'Vote skip',
                  value: settings.voteSkip
                    ? `${settings.voteSkipPercent}% of listeners`
                    : 'disabled',
                  inline: true,
                },
                { name: 'Default volume', value: `${settings.defaultVolume}%`, inline: true },
              )
              .setFooter({
                text: 'Spotify links are resolved to metadata; real Spotify audio requires a Lavalink plugin such as LavaSrc.',
              }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === 'dj') {
        const role = interaction.options.getRole('role');
        const remove = interaction.options.getBoolean('remove') ?? false;
        const enabled = interaction.options.getBoolean('enabled');
        const patch: Record<string, unknown> = {};
        if (role) {
          patch.djRoleIds = remove
            ? settings.djRoleIds.filter((id) => id !== role.id)
            : [...new Set([...settings.djRoleIds, role.id])];
          if (!remove) patch.djOnly = true;
        }
        if (enabled !== null) patch.djOnly = enabled;
        await services.settings.update(guild.id, 'music', patch, {
          actorId: interaction.user.id,
          source: 'command',
        });
        await interaction.reply({
          embeds: [
            successEmbed(
              'DJ configuration updated. Members with the DJ role (or Manage Server) can control playback.',
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === 'limit') {
        const patch: Record<string, unknown> = {};
        const maxQueue = interaction.options.getInteger('max_queue');
        const maxDuration = interaction.options.getInteger('max_duration_minutes');
        const voteSkip = interaction.options.getBoolean('vote_skip');
        const votePercent = interaction.options.getInteger('vote_skip_percent');
        if (maxQueue !== null) patch.maxQueueSize = maxQueue;
        if (maxDuration !== null) patch.maxTrackDurationMs = maxDuration * 60_000;
        if (voteSkip !== null) patch.voteSkip = voteSkip;
        if (votePercent !== null) patch.voteSkipPercent = votePercent;
        await services.settings.update(guild.id, 'music', patch, {
          actorId: interaction.user.id,
          source: 'command',
        });
        await interaction.reply({
          embeds: [successEmbed('Music limits updated.')],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const music = requireMusic(services);
      const access = await checkMusicAccess(services, guild, member);
      if (!access.allowed)
        throw new UserFacingError(access.reason ?? 'You cannot control music here.');

      switch (sub) {
        case 'join': {
          const voiceChannel = await voiceChannelOf(interaction, member);
          await music.join(guild, voiceChannel, interaction.channelId);
          await interaction.reply({ embeds: [successEmbed(`Joined <#${voiceChannel.id}>.`)] });
          return;
        }
        case 'leave': {
          const force = interaction.options.getBoolean('force') ?? false;
          const state = music.getState(guild.id);
          if (!state && !force) throw new UserFacingError('I am not connected in this server.');
          await music.leave(guild.id);
          await interaction.reply({
            embeds: [successEmbed('Left the voice channel and cleared the queue.')],
          });
          return;
        }
        case 'pause':
        case 'resume': {
          await music.pause(guild.id, sub === 'pause');
          await interaction.reply({
            embeds: [successEmbed(sub === 'pause' ? '⏸️ Paused.' : '▶️ Resumed.')],
          });
          return;
        }
        case 'stop': {
          await music.stop(guild.id);
          await interaction.reply({
            embeds: [successEmbed('Stopped playback and cleared the queue.')],
          });
          return;
        }
        case 'seek': {
          const position = interaction.options.getString('position', true);
          const parsed = parsePosition(position);
          if (parsed === null)
            throw new UserFacingError('Use a format like `90`, `1m30s` or `1:30`.');
          await music.seek(guild.id, parsed);
          await interaction.reply({
            embeds: [successEmbed(`Jumped to \`${formatDuration(parsed)}\`.`)],
          });
          return;
        }
        case 'loop': {
          const mode = interaction.options.getString('mode', true) as 'off' | 'track' | 'queue';
          const applied = music.setLoop(guild.id, mode);
          await interaction.reply({ embeds: [successEmbed(`Loop mode: **${applied}**.`)] });
          return;
        }
        case 'shuffle': {
          const count = music.shuffleQueue(guild.id);
          await interaction.reply({ embeds: [successEmbed(`Shuffled ${count} queued track(s).`)] });
          return;
        }
        case 'remove': {
          const position = interaction.options.getInteger('position', true);
          const removed = music.removeFromQueue(guild.id, position);
          await interaction.reply({
            embeds: [successEmbed(`Removed **${truncate(removed, 80)}** from the queue.`)],
          });
          return;
        }
        case 'clear': {
          const count = music.clearQueue(guild.id);
          await interaction.reply({ embeds: [successEmbed(`Cleared ${count} queued track(s).`)] });
          return;
        }
        default:
          throw new UserFacingError('Unknown music subcommand.');
      }
    },
  },
]);

/** Accepts "90", "1:30", "1m30s" or "1h2m3s". Returns milliseconds or null. */
export function parsePosition(input: string): number | null {
  const trimmed = input.trim();
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(trimmed)) {
    const parts = trimmed.split(':').map(Number);
    const seconds = parts.reduce((acc, part) => acc * 60 + part, 0);
    return seconds * 1000;
  }
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const match = trimmed.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  const [, hours, minutes, seconds] = match;
  return (Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0)) * 1000;
}
