import { requireSession } from '@/lib/authz';
import { avatarUrl } from '@/lib/discord';
import { getDatabase } from '@/lib/server';

export const dynamic = 'force-dynamic';

/** Returns the caller's own session data — never another user's. */
export async function GET(): Promise<Response> {
  const result = await requireSession();
  if (!result.ok) return result.response;
  const { session } = result;

  const { repos } = getDatabase();
  const guilds = await repos.guilds.listGuildsForIds(session.guildIds).catch(() => []);

  return Response.json({
    ok: true,
    user: {
      id: session.userId,
      username: session.username,
      globalName: session.globalName,
      avatarUrl:
        session.avatar !== null || session.username
          ? avatarUrl({ id: session.userId, avatar: session.avatar })
          : null,
      isOwner: session.isOwner,
      expiresAt: session.expiresAt.toISOString(),
    },
    guilds: session.guildIds.map((id) => {
      const tracked = guilds.find((guild) => guild.id === id);
      return {
        id,
        name: tracked?.name ?? null,
        memberCount: tracked?.member_count ?? null,
        tracked: Boolean(tracked),
      };
    }),
  });
}
