import { requireSession } from '@/lib/authz';
import { getDatabase } from '@/lib/server';

export const dynamic = 'force-dynamic';

/** Servers the signed-in user can manage, cross-referenced with bot state. */
export async function GET(): Promise<Response> {
  const result = await requireSession();
  if (!result.ok) return result.response;
  const { session } = result;

  const { repos } = getDatabase();
  const tracked = await repos.guilds.listGuildsForIds(session.guildIds).catch(() => []);
  const byId = new Map(tracked.map((row) => [row.id, row]));

  return Response.json({
    ok: true,
    guilds: session.guildIds.map((id) => {
      const row = byId.get(id);
      return {
        id,
        name: row?.name ?? null,
        memberCount: row?.member_count ?? null,
        botPresent: Boolean(row && !row.left_at),
        trackedInDatabase: Boolean(row),
        joinedAt: row?.joined_at ? new Date(row.joined_at).toISOString() : null,
      };
    }),
  });
}
