import { PermissionFlagsBits, type Guild, type GuildMember } from 'discord.js';
import { UserFacingError } from '@bot-by-ai/shared';
import type { BotServices } from './context.js';
import type { MusicService } from '../music/musicService.js';

export interface MusicAccess {
  allowed: boolean;
  reason?: string;
}

/** Music is an optional subsystem: it needs LAVALINK_HOST + LAVALINK_PASSWORD. */
export function musicUnavailable(services: BotServices): boolean {
  return services.music === null;
}

/** Returns the music service or explains honestly why music is unavailable. */
export function requireMusic(services: BotServices): MusicService {
  const music = services.music;
  if (!music) {
    throw new UserFacingError(
      'Music is unavailable on this deployment because no Lavalink node is configured. ' +
        'Set LAVALINK_HOST, LAVALINK_PORT, LAVALINK_PASSWORD and ENABLE_MUSIC=true, then restart the bot.',
    );
  }
  return music;
}

/**
 * Central music permission check:
 *  - the configured DJ roles (or Manage Server) when djOnly is enabled
 *  - the member must be in the same voice channel as the bot, unless they have Manage Server
 */
export async function checkMusicAccess(
  services: BotServices,
  guild: Guild,
  member: GuildMember,
): Promise<MusicAccess> {
  const settings = await services.settings.get<{ djOnly: boolean; djRoleIds: string[] }>(guild.id, 'music');
  const isManager = member.permissions.has(PermissionFlagsBits.ManageGuild);
  if (settings.djOnly && settings.djRoleIds.length > 0 && !isManager) {
    const isDj = settings.djRoleIds.some((roleId) => member.roles.cache.has(roleId));
    if (!isDj) return { allowed: false, reason: 'Only members with a DJ role can control music in this server.' };
  }
  const botChannel = guild.members.me?.voice.channelId;
  if (botChannel && member.voice.channelId !== botChannel && !isManager) {
    return { allowed: false, reason: 'Join my voice channel to control the player.' };
  }
  return { allowed: true };
}
