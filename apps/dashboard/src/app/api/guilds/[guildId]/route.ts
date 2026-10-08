/**
 * Real dashboard data for one guild. Every number comes from PostgreSQL or the
 * Discord API; unavailable metrics are reported as `null` so the UI can render
 * "unavailable" instead of a fabricated value.
 */
import { requireGuildAccess, guardMutation } from '@/lib/authz';
import { getConfig, getDatabase, getOwners } from '@/lib/server';
import type { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ guildId: string }> },
): Promise<Response> {
  const { guildId } = await context.params;
  const guard = guardMutation(request);
  if (guard) return guard;

  const auth = await requireGuildAccess(guildId);
  if (!auth.ok) return auth.response;
  const { session } = auth.value;

  const { repos } = getDatabase();
  const ownership = await repos.customCommands.listGuild(guildId).catch(() => []);
  const [
    overview,
    guild,
    settings,
    moderationByAction,
    moderationByDay,
    commandUsage,
    topCommands,
    tickets,
    instances,
  ] = await Promise.all([
    repos.analytics.guildOverview(guildId),
    repos.guilds.getGuild(guildId),
    repos.guilds.getAllModuleSettings(guildId),
    repos.analytics.moderationByAction(guildId, 30),
    repos.analytics.moderationByDay(guildId, 30),
    repos.commandUsage.statsForGuild(guildId, 14),
    repos.commandUsage.topCommands(guildId, 30, 10),
    repos.tickets.stats(guildId),
    repos.analytics.listBotInstances().catch(() => []),
  ]);

  const botInstance = instances[0] ?? null;

  return Response.json({
    ok: true,
    guild: {
      id: guildId,
      dbName: guild?.name ?? auth.value.guildName,
      dbMemberCount: guild?.member_count ?? null,
      tracked: Boolean(guild),
      leftAt: guild?.left_at ? new Date(guild.left_at).toISOString() : null,
    },
    viewer: {
      userId: session.userId,
      isOwner: getOwners().isOwner(session.userId),
      verifiedFresh: auth.value.verifiedFresh,
    },
    overview,
    settings,
    customCommandCount: ownership.length,
    moderation: { byAction: moderationByAction, byDay: moderationByDay },
    commands: { byDay: commandUsage, top: topCommands },
    tickets,
    runtime: botInstance
      ? {
          instanceId: botInstance.id,
          status: botInstance.status,
          guildCount: botInstance.guild_count,
          userCount: Number(botInstance.user_count),
          wsPingMs: botInstance.ws_ping_ms,
          memoryMb: botInstance.memory_mb,
          uptimeSeconds: Number(botInstance.uptime_seconds),
          version: botInstance.version,
          nodeVersion: botInstance.node_version,
          lastHeartbeatAt: new Date(botInstance.last_heartbeat_at).toISOString(),
        }
      : null,
    music: {
      enabled: getConfig().music.enabled,
      lavalinkConfigured: Boolean(getConfig().music.lavalink),
      // A guild-level player snapshot would be fabricated here; the bot owns it.
      activePlayer: null,
    },
  });
}
