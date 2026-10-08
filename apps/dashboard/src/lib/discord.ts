/**
 * Discord OAuth2 (identity only) and bot-token guild checks.
 *
 * The user's OAuth2 access token is used once, during the callback, to read the
 * account identity and the list of guilds the user manages. It is never stored
 * and never sent to the browser.
 *
 * Every later permission decision is re-derived server-side with the BOT token
 * (`GET /guilds/{id}/members/{user}`), which also catches members who lost their
 * role after logging in.
 */
import { getConfig } from './server';

export const DISCORD_API = 'https://discord.com/api/v10';

export const MANAGE_GUILD_PERMISSIONS = {
  ADMINISTRATOR: 0x8n,
  MANAGE_GUILD: 0x20n,
  MANAGE_ROLES: 0x10000000n,
} as const;

export function authorizeUrl(state: string): string {
  const config = getConfig();
  if (!config.discord.redirectUri) {
    throw new Error('DISCORD_REDIRECT_URI must be set before the OAuth2 flow can start.');
  }
  const params = new URLSearchParams([
    ['client_id', config.discord.clientId],
    ['redirect_uri', config.discord.redirectUri],
    ['response_type', 'code'],
    ['scope', 'identify guilds'],
    ['state', state],
    ['prompt', 'consent'],
  ]);
  return `${DISCORD_API}/oauth2/authorize?${params.toString()}`;
}

export interface DiscordTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export async function exchangeCode(code: string): Promise<DiscordTokenResponse> {
  const config = getConfig();
  const response = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.discord.clientId,
      client_secret: config.discord.clientSecret ?? '',
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.discord.redirectUri ?? '',
    }),
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Discord rejected the authorization code (HTTP ${response.status})`);
  }
  return (await response.json()) as DiscordTokenResponse;
}

export interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
  discriminator: string;
}

export interface DiscordPartialGuild {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: string;
  approximate_member_count?: number;
}

async function userGet<T>(path: string, accessToken: string): Promise<T> {
  const response = await fetch(`${DISCORD_API}${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Discord API ${path} failed with HTTP ${response.status}`);
  return (await response.json()) as T;
}

export async function fetchIdentity(accessToken: string): Promise<DiscordUser> {
  return userGet<DiscordUser>('/users/@me', accessToken);
}

export async function fetchUserGuilds(accessToken: string): Promise<DiscordPartialGuild[]> {
  return userGet<DiscordPartialGuild[]>('/users/@me/guilds', accessToken);
}

export function canManage(permissions: string | bigint): boolean {
  const value = typeof permissions === 'bigint' ? permissions : BigInt(permissions);
  return (
    (value & MANAGE_GUILD_PERMISSIONS.ADMINISTRATOR) === MANAGE_GUILD_PERMISSIONS.ADMINISTRATOR ||
    (value & MANAGE_GUILD_PERMISSIONS.MANAGE_GUILD) === MANAGE_GUILD_PERMISSIONS.MANAGE_GUILD
  );
}

export function avatarUrl(user: { id: string; avatar: string | null }, size = 128): string {
  if (!user.avatar) return `${DISCORD_API.replace('/api/v10', '')}/embed/avatars/${Number(BigInt(user.id) % 5n)}.png`;
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=${size}`;
}

export function guildIconUrl(guild: { id: string; icon: string | null }, size = 128): string | null {
  if (!guild.icon) return null;
  return `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=${size}`;
}

/* ------------------------------------------------------ bot-token guild check */

interface BotGuildMember {
  user?: { id: string; username: string };
  roles: string[];
  joined_at: string;
}

interface BotGuild {
  id: string;
  name: string;
  owner_id: string;
  member_count?: number;
}

/**
 * Fresh, bot-side authorization check. Returns the member record plus whether
 * the user currently holds ManageGuild/Administrator in that guild.
 */
export async function checkGuildAccess(
  guildId: string,
  userId: string,
): Promise<{ ok: boolean; reason?: string; guildName?: string; isOwnerOfGuild?: boolean }> {
  const token = getConfig().discord.token;

  const guildResponse = await fetch(`${DISCORD_API}/guilds/${guildId}?with_counts=true`, {
    headers: { authorization: `Bot ${token}` },
    cache: 'no-store',
  });
  if (guildResponse.status === 404) {
    return { ok: false, reason: 'The bot is not in that server, so no data is available.' };
  }
  if (!guildResponse.ok) {
    return { ok: false, reason: `Discord returned HTTP ${guildResponse.status} while checking the server.` };
  }
  const guild = (await guildResponse.json()) as BotGuild;

  if (guild.owner_id === userId) {
    return { ok: true, guildName: guild.name, isOwnerOfGuild: true };
  }

  const memberResponse = await fetch(`${DISCORD_API}/guilds/${guildId}/members/${userId}`, {
    headers: { authorization: `Bot ${token}` },
    cache: 'no-store',
  });
  if (memberResponse.status === 404) {
    return { ok: false, reason: 'You are not a member of that server.' };
  }
  if (!memberResponse.ok) {
    return { ok: false, reason: `Discord returned HTTP ${memberResponse.status} while checking your membership.` };
  }
  const member = (await memberResponse.json()) as BotGuildMember;

  // Role-level permission computation: ask Discord for the member's effective
  // permissions in the guild channel context by resolving roles server-side.
  const rolesResponse = await fetch(`${DISCORD_API}/guilds/${guildId}/roles`, {
    headers: { authorization: `Bot ${token}` },
    cache: 'no-store',
  });
  if (!rolesResponse.ok) {
    return { ok: false, reason: 'Could not read the server roles to verify your permissions.' };
  }
  const roles = (await rolesResponse.json()) as { id: string; permissions: string }[];
  let permissions = 0n;
  for (const role of roles) {
    if (role.id === guildId || member.roles.includes(role.id)) {
      permissions |= BigInt(role.permissions);
    }
  }
  if (!canManage(permissions)) {
    return { ok: false, reason: 'You need the Manage Server permission to use the dashboard for this server.' };
  }
  return { ok: true, guildName: guild.name, isOwnerOfGuild: false };
}
