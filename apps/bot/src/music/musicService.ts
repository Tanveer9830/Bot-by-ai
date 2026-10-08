import type { Client, Guild, GuildMember, VoiceBasedChannel } from 'discord.js';
import type { AppConfig, Logger } from '@bot-by-ai/shared';
import { formatDuration, shuffle, UserFacingError } from '@bot-by-ai/shared';
import type { GuildSettingsService } from '../services/settings.js';
import type { MusicSettings } from '../services/types.js';
import { LavalinkNode, type LavalinkTrack } from './lavalink.js';
import { baseEmbed, warningEmbed } from '../core/embeds.js';
import { COLORS } from '../core/constants.js';

export type LoopMode = 'off' | 'track' | 'queue';

interface QueueItem {
  track: LavalinkTrack;
  requestedBy: string;
}

interface GuildPlayer {
  guildId: string;
  channelId: string;
  voiceChannelId: string;
  queue: QueueItem[];
  current: QueueItem | null;
  history: QueueItem[];
  loop: LoopMode;
  paused: boolean;
  volume: number;
  nowPlayingMessageId: string | null;
  textChannelId: string | null;
}

/**
 * Music service built on a Lavalink v4 node.
 *
 * Supported behaviour is documented honestly in docs/COMMANDS.md:
 *  - Direct playback: YouTube/YouTube Music, SoundCloud, Bandcamp, Twitch,
 *    Vimeo, http streams and any other source the Lavalink server has enabled.
 *  - Spotify: links are resolved to metadata via the Spotify Web API (client
 *    credentials) and the equivalent track is searched on the configured
 *    Lavalink source. Direct Spotify audio playback requires a Lavalink plugin
 *    that supports it (e.g. LavaSrc) — without that plugin the bot says so.
 */
export class MusicService {
  private readonly node: LavalinkNode;
  private readonly players = new Map<string, GuildPlayer>();
  private spotifyAccess: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly client: Client,
    private readonly settings: GuildSettingsService,
    private readonly logger: Logger,
  ) {
    if (!config.music.lavalink)
      throw new Error('MusicService requires LAVALINK_HOST and LAVALINK_PASSWORD');
    this.node = new LavalinkNode(
      {
        host: config.music.lavalink.host,
        port: config.music.lavalink.port,
        password: config.music.lavalink.password,
        secure: config.music.lavalink.secure,
      },
      config.discord.clientId,
      logger,
    );
  }

  async connect(): Promise<void> {
    await this.node.connect(this.config.discord.clientId);
    this.node.onEvent((payload) => {
      void this.handleEvent(payload);
    });
    this.logger.info('music subsystem ready', { node: this.node.name, session: this.node.session });
  }

  get healthy(): boolean {
    return this.node.connected;
  }

  get nodeStats(): Record<string, unknown> | null {
    return this.node.stats;
  }

  async getSettings(guildId: string): Promise<MusicSettings> {
    return this.settings.get<MusicSettings>(guildId, 'music');
  }

  private getPlayer(guildId: string): GuildPlayer | undefined {
    return this.players.get(guildId);
  }

  private async ensurePlayer(guild: Guild, voiceChannel: VoiceBasedChannel): Promise<GuildPlayer> {
    const settings = await this.getSettings(guild.id);
    if (!settings.enabled) throw new UserFacingError('Music is disabled in this server.');
    const existing = this.players.get(guild.id);
    if (existing) {
      existing.voiceChannelId = voiceChannel.id;
      return existing;
    }
    const player: GuildPlayer = {
      guildId: guild.id,
      channelId: voiceChannel.id,
      voiceChannelId: voiceChannel.id,
      queue: [],
      current: null,
      history: [],
      loop: 'off',
      paused: false,
      volume: settings.defaultVolume,
      nowPlayingMessageId: null,
      textChannelId: null,
    };
    this.players.set(guild.id, player);
    return player;
  }

  /** Resolves Spotify metadata via the Web API (client credentials flow). */
  private async resolveSpotify(url: string): Promise<string | null> {
    const credentials = this.config.music.spotify;
    if (!credentials) return null;
    if (this.spotifyAccess && this.spotifyAccess.expiresAt > Date.now() + 5_000) {
      // fallthrough with cached token
    } else {
      const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64')}`,
        },
        body: 'grant_type=client_credentials',
      }).catch(() => null);
      if (!response?.ok) return null;
      const data = (await response.json()) as { access_token?: string; expires_in?: number };
      if (!data.access_token) return null;
      this.spotifyAccess = {
        value: data.access_token,
        expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
      };
    }
    const token = this.spotifyAccess?.value;
    if (!token) return null;

    const match = /spotify\.com\/(?:intl-\w+\/)?(track|album|playlist)\/([A-Za-z0-9]+)/.exec(url);
    if (!match) return null;
    const [, type, id] = match;
    if (type === 'track') {
      const response = await fetch(`https://api.spotify.com/v1/tracks/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => null);
      if (!response?.ok) return null;
      const track = (await response.json()) as { name?: string; artists?: { name: string }[] };
      if (!track.name) return null;
      return `${track.artists?.map((artist) => artist.name).join(' ') ?? ''} ${track.name}`.trim();
    }
    if (type === 'album') {
      const response = await fetch(`https://api.spotify.com/v1/albums/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => null);
      if (!response?.ok) return null;
      const album = (await response.json()) as { name?: string; artists?: { name: string }[] };
      if (!album.name) return null;
      return `${album.artists?.[0]?.name ?? ''} ${album.name}`.trim();
    }
    const response = await fetch(`https://api.spotify.com/v1/playlists/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => null);
    if (!response?.ok) return null;
    const playlist = (await response.json()) as {
      name?: string;
      owner?: { display_name?: string };
    };
    return playlist.name ? `${playlist.name}` : null;
  }

  async search(query: string): Promise<LavalinkTrack[]> {
    const isUrl = /^https?:\/\//i.test(query);
    let identifier = query;
    let spotifyFallback = false;
    if (isUrl) {
      identifier = query;
    } else {
      identifier = `ytsearch:${query}`;
    }

    let result = await this.node.loadTracks(identifier);
    if (isUrl && identifier.includes('spotify.com')) {
      const resolved = await this.resolveSpotify(identifier);
      if (resolved) {
        result = await this.node.loadTracks(`ytsearch:${resolved}`);
        spotifyFallback = true;
      }
      if (result.tracks.length === 0) {
        throw new UserFacingError(
          'This Spotify link could not be resolved. Spotify playback requires either the LavaSrc Lavalink plugin or Spotify API credentials (SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET) plus a search source such as YouTube.',
        );
      }
      if (spotifyFallback) {
        this.logger.info('spotify link resolved through search', {
          query: resolved_for_log(result),
        });
      }
    }
    if (result.loadType === 'error') {
      throw new UserFacingError(
        `The music backend rejected that request: ${result.exception?.message ?? 'unknown error'}`,
      );
    }
    if (result.tracks.length === 0) {
      throw new UserFacingError('Nothing was found for that query.');
    }
    return result.tracks;
  }

  async play(input: {
    guild: Guild;
    member: GuildMember;
    voiceChannel: VoiceBasedChannel;
    query: string;
    textChannelId: string;
  }): Promise<{ track: LavalinkTrack; queued: boolean; playlistName?: string }> {
    const player = await this.ensurePlayer(input.guild, input.voiceChannel);
    const settings = await this.getSettings(input.guild.id);
    if (settings.djOnly && settings.djRoleIds.length > 0) {
      const isDj =
        input.member.roles.cache.some((role) => settings.djRoleIds.includes(role.id)) ||
        input.member.permissions.has('ManageGuild');
      if (!isDj) throw new UserFacingError('Only DJs can start playback in this server.');
    }
    const result = await this.loadResult(input.query);
    const tracks = result.tracks;
    if (tracks.length === 0) throw new UserFacingError('Nothing was found for that query.');
    const toQueue = result.loadType === 'playlist' ? tracks : [tracks[0] as LavalinkTrack];
    if (player.queue.length + toQueue.length > settings.maxQueueSize) {
      throw new UserFacingError(`The queue is limited to ${settings.maxQueueSize} tracks.`);
    }
    player.volume = player.volume || settings.defaultVolume;
    player.textChannelId = input.textChannelId;
    const wasIdle = player.current === null;

    for (const track of toQueue) {
      player.queue.push({ track, requestedBy: input.member.id });
    }
    if (wasIdle) {
      await this.playNext(input.guild);
    }
    return {
      track: toQueue[0] as LavalinkTrack,
      queued: !wasIdle,
      playlistName: result.playlistName,
    };
  }

  /** Loads either a URL, a playlist or a search term. */
  private async loadResult(query: string) {
    const result = await this.node.loadTracks(
      /^https?:\/\//i.test(query) ? query : `ytsearch:${query}`,
    );
    if (result.tracks.length === 0 && /spotify\.com/.test(query)) {
      const resolved = await this.resolveSpotify(query);
      if (resolved) {
        return this.node.loadTracks(`ytsearch:${resolved}`);
      }
    }
    return result;
  }

  private async playNext(guild: Guild): Promise<void> {
    const player = this.getPlayer(guild.id);
    if (!player) return;
    let next = player.queue.shift() ?? null;
    if (!next && player.loop === 'queue' && player.history.length > 0) {
      player.queue = player.history.map((item) => ({ ...item }));
      player.history = [];
      next = player.queue.shift() ?? null;
    }
    if (!next) {
      player.current = null;
      if (player.textChannelId) {
        const channel = await guild.channels.fetch(player.textChannelId).catch(() => null);
        if (channel?.isTextBased()) {
          await channel
            .send({ embeds: [warningEmbed('The queue is empty — leaving the voice channel.')] })
            .catch(() => {});
        }
      }
      const settings = await this.getSettings(guild.id);
      if (!settings.twentyFourSeven) {
        await this.destroy(guild.id, true);
      }
      return;
    }
    player.current = next;
    await this.node.updatePlayer(guild.id, {
      track: { encoded: next.track.encoded },
      volume: player.volume,
      paused: false,
    });
    player.paused = false;
  }

  private async handleEvent(payload: Record<string, unknown>): Promise<void> {
    const type = payload.type as string | undefined;
    const guildId = payload.guildId as string | undefined;
    if (!guildId || !type) return;
    const guild =
      this.client.guilds.cache.get(guildId) ??
      (await this.client.guilds.fetch(guildId).catch(() => null));
    if (!guild) return;
    const player = this.getPlayer(guildId);
    if (!player) return;

    switch (type) {
      case 'TrackStart': {
        const track = (payload.track as LavalinkTrack | undefined) ?? player.current?.track ?? null;
        if (track) await this.announceNowPlaying(guild, player, track);
        break;
      }
      case 'TrackEnd': {
        const reason = payload.reason as string | undefined;
        if (reason === 'replaced' || reason === 'stop') return;
        const finished = player.current;
        if (finished) player.history.push(finished);
        if (player.loop === 'track' && finished && reason === 'finished') {
          player.queue.unshift({ ...finished });
        }
        await this.playNext(guild);
        break;
      }
      case 'TrackException': {
        const exception = payload.exception as { message?: string } | undefined;
        this.logger.warn('track playback exception', { guildId, message: exception?.message });
        if (player.textChannelId) {
          const channel = await guild.channels.fetch(player.textChannelId).catch(() => null);
          if (channel?.isTextBased()) {
            await channel
              .send({
                embeds: [
                  warningEmbed(
                    `Playback failed for the current track: ${exception?.message?.slice(0, 300) ?? 'unknown error'}`,
                  ),
                ],
              })
              .catch(() => {});
          }
        }
        break;
      }
      case 'TrackStuck': {
        if (player.textChannelId) {
          const channel = await guild.channels.fetch(player.textChannelId).catch(() => null);
          if (channel?.isTextBased()) {
            await channel
              .send({ embeds: [warningEmbed('Playback stalled — skipping to the next track.')] })
              .catch(() => {});
          }
        }
        await this.skip(guild.id).catch(() => {});
        break;
      }
      case 'WebSocketClosed': {
        this.logger.warn('voice websocket closed', { guildId, code: payload.code });
        setTimeout(() => {
          void this.destroy(guildId).catch(() => {});
        }, 5_000);
        break;
      }
      default:
        break;
    }
  }

  private async announceNowPlaying(
    guild: Guild,
    player: GuildPlayer,
    track: LavalinkTrack,
  ): Promise<void> {
    const settings = await this.getSettings(guild.id);
    if (!settings.announceNowPlaying || !player.textChannelId) return;
    const channel = await guild.channels.fetch(player.textChannelId).catch(() => null);
    if (!channel?.isTextBased()) return;
    const embed = baseEmbed(COLORS.music)
      .setTitle('🎶 Now playing')
      .setDescription(
        `**[${track.info.title}](${track.info.uri ?? 'https://lavalink.dev'})**\nby ${track.info.author}`,
      )
      .addFields(
        {
          name: 'Duration',
          value: track.info.isStream ? 'live stream' : formatDuration(track.info.length),
          inline: true,
        },
        {
          name: 'Requested by',
          value: `<@${player.current?.requestedBy ?? 'unknown'}>`,
          inline: true,
        },
      );
    if (track.info.artworkUrl) embed.setThumbnail(track.info.artworkUrl);
    const message = await channel.send({ embeds: [embed] }).catch(() => null);
    player.nowPlayingMessageId = message?.id ?? null;
  }

  /** Joins a voice channel without starting playback (used by `/music join`). */
  async join(guild: Guild, voiceChannel: VoiceBasedChannel, textChannelId?: string): Promise<void> {
    const player = await this.ensurePlayer(guild, voiceChannel);
    if (textChannelId) player.textChannelId = textChannelId;
  }

  /** Leaves the voice channel and clears the queue for a guild. */
  async leave(guildId: string): Promise<void> {
    await this.destroy(guildId, true);
  }

  async pause(guildId: string, pause: boolean): Promise<void> {
    const player = this.getPlayer(guildId);
    if (!player?.current) throw new UserFacingError('Nothing is playing right now.');
    player.paused = pause;
    await this.node.updatePlayer(guildId, { paused: pause });
  }

  async skip(guildId: string): Promise<string> {
    const player = this.getPlayer(guildId);
    if (!player?.current) throw new UserFacingError('Nothing is playing right now.');
    const skipped = player.current.track.info.title;
    if (player.loop === 'track') {
      player.queue.unshift({ ...player.current });
    }
    player.history.push(player.current);
    player.current = null;
    const guild = this.client.guilds.cache.get(guildId);
    if (guild) {
      const next = player.queue[0];
      if (next) {
        await this.node.updatePlayer(guildId, { track: { encoded: next.track.encoded } });
      } else {
        await this.node.updatePlayer(guildId, { track: { encoded: null } }).catch(() => {});
        player.current = null;
      }
    }
    return skipped;
  }

  async stop(guildId: string): Promise<void> {
    const player = this.getPlayer(guildId);
    if (!player) throw new UserFacingError('The bot is not playing anything.');
    player.queue = [];
    player.current = null;
    player.history = [];
    await this.node.updatePlayer(guildId, { track: { encoded: null } });
  }

  async setVolume(guildId: string, volume: number): Promise<number> {
    const settings = await this.getSettings(guildId);
    const player = this.getPlayer(guildId);
    if (!player) throw new UserFacingError('The bot is not in a voice channel.');
    if (volume < 1 || volume > settings.maxVolume) {
      throw new UserFacingError(`Volume must be between 1 and ${settings.maxVolume}.`);
    }
    player.volume = volume;
    await this.node.updatePlayer(guildId, { volume });
    return volume;
  }

  async seek(guildId: string, positionMs: number): Promise<void> {
    const player = this.getPlayer(guildId);
    if (!player?.current) throw new UserFacingError('Nothing is playing right now.');
    if (player.current.track.info.isStream)
      throw new UserFacingError('Cannot seek in a live stream.');
    if (positionMs < 0 || positionMs > player.current.track.info.length) {
      throw new UserFacingError('That position is outside the track length.');
    }
    await this.node.updatePlayer(guildId, { position: Math.floor(positionMs) });
  }

  setLoop(guildId: string, mode: LoopMode): LoopMode {
    const player = this.getPlayer(guildId);
    if (!player) throw new UserFacingError('The bot is not in a voice channel.');
    player.loop = mode;
    return mode;
  }

  shuffleQueue(guildId: string): number {
    const player = this.getPlayer(guildId);
    if (!player) throw new UserFacingError('The bot is not in a voice channel.');
    player.queue = shuffle(player.queue);
    return player.queue.length;
  }

  removeFromQueue(guildId: string, position: number): string {
    const player = this.getPlayer(guildId);
    if (!player) throw new UserFacingError('The bot is not in a voice channel.');
    if (position < 1 || position > player.queue.length)
      throw new UserFacingError('Invalid queue position.');
    const [removed] = player.queue.splice(position - 1, 1);
    return removed?.track.info.title ?? 'unknown';
  }

  clearQueue(guildId: string): number {
    const player = this.getPlayer(guildId);
    if (!player) throw new UserFacingError('The bot is not in a voice channel.');
    const size = player.queue.length;
    player.queue = [];
    return size;
  }

  getState(guildId: string): {
    current: QueueItem | null;
    queue: QueueItem[];
    loop: LoopMode;
    paused: boolean;
    volume: number;
    history: QueueItem[];
  } | null {
    const player = this.getPlayer(guildId);
    if (!player) return null;
    return {
      current: player.current,
      queue: player.queue,
      loop: player.loop,
      paused: player.paused,
      volume: player.volume,
      history: player.history,
    };
  }

  async destroy(guildId: string, leave?: boolean): Promise<void> {
    await this.node.destroyPlayer(guildId);
    this.players.delete(guildId);
    const guild = this.client.guilds.cache.get(guildId);
    if (leave && guild) {
      const me = guild.members.me;
      if (me?.voice.channel) await me.voice.disconnect().catch(() => {});
    }
  }

  async disconnect(): Promise<void> {
    for (const guildId of [...this.players.keys()]) {
      await this.destroy(guildId, true).catch(() => {});
    }
    this.node.disconnect();
  }
}

function resolved_for_log(result: { tracks: LavalinkTrack[] }): string {
  return result.tracks[0]?.info.title ?? '(no track)';
}
