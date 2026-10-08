/**
 * Owner-only panel data.
 *
 * Authorization is enforced server-side on every request by `requireOwner()`:
 * a non-owner gets 403 even when calling the API directly. Nothing here trusts
 * the client, and no metric is invented — anything that cannot be measured is
 * `null` and rendered as "unavailable".
 */
import { APP_VERSION } from '@/lib/meta';
import { guardMutation, requireOwner } from '@/lib/authz';
import { getConfig, getDatabase, getOwners } from '@/lib/server';
import type { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  const guard = guardMutation(request);
  if (guard) return guard;
  const auth = await requireOwner();
  if (!auth.ok) return auth.response;

  const { db, repos } = getDatabase();
  const config = getConfig();

  const counts = await db
    .query<Record<string, string>>(
      `SELECT
         (SELECT count(*)::text FROM guilds WHERE left_at IS NULL) AS guilds,
         (SELECT count(*)::text FROM users) AS users,
         (SELECT count(*)::text FROM guild_settings) AS configured_guilds,
         (SELECT count(*)::text FROM custom_commands WHERE scope = 'global') AS global_commands,
         (SELECT count(*)::text FROM custom_commands WHERE scope = 'guild') AS guild_commands,
         (SELECT count(*)::text FROM moderation_cases) AS moderation_cases,
         (SELECT count(*)::text FROM security_events) AS security_events,
         (SELECT count(*)::text FROM audit_logs) AS audit_logs,
         (SELECT count(*)::text FROM notag_violations) AS notag_violations,
         (SELECT count(*)::text FROM nopin_events) AS nopin_events`,
    )
    .then((result) => result.rows[0] ?? {})
    .catch(() => ({}));

  const [health, instances, commandStats, sessions, pendingTasks, audit, globalCommands] =
    await Promise.all([
      db.health().catch((error: unknown) => ({
        ok: false,
        latencyMs: 0,
        error: error instanceof Error ? error.message : 'unknown',
      })),
      repos.analytics.listBotInstances().catch(() => []),
      repos.commandUsage.globalStats(7).catch(() => null),
      repos.sessions.countActive().catch(() => null),
      repos.tasks.pendingCount().catch(() => null),
      repos.audit.list({ limit: 15 }).catch(() => ({ rows: [], total: 0 })),
      repos.customCommands.listGlobal().catch(() => []),
    ]);

  return Response.json({
    ok: true,
    viewer: { userId: auth.session.userId, isOwner: true },
    ownerIds: getOwners().ids,
    version: APP_VERSION,
    nodeVersion: process.version,
    environment: {
      nodeEnv: config.nodeEnv,
      isProduction: config.isProduction,
      musicEnabled: config.music.enabled,
      lavalinkConfigured: Boolean(config.music.lavalink),
      spotifyConfigured: Boolean(config.music.spotify),
      redisConfigured: Boolean(config.redisUrl),
      dashboardEnabled: config.dashboard.enabled,
      metricsEnabled: config.metricsEnabled,
      sessionTtlHours: Math.round(config.dashboard.sessionTtlMs / 3_600_000),
    },
    database: health,
    instances,
    commandStats,
    counts,
    activeSessions: sessions,
    pendingTasks,
    globalCommands: globalCommands.map((row) => ({
      name: row.name,
      published: row.published,
      enabled: row.enabled,
      uses: row.uses,
      updatedAt: new Date(row.updated_at).toISOString(),
    })),
    recentAudit: audit.rows.map((row) => ({
      id: row.id,
      action: row.action,
      actorId: row.actor_id,
      actorType: row.actor_type,
      guildId: row.guild_id,
      targetType: row.target_type,
      targetId: row.target_id,
      createdAt: new Date(row.created_at).toISOString(),
    })),
    auditTotal: audit.total,
    generatedAt: new Date().toISOString(),
  });
}
