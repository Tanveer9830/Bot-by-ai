import Link from 'next/link';
import { TopBar } from '@/components/TopBar';
import { LogoutButton } from '@/components/LogoutButton';
import { getConfig, getDatabase, getSession } from '@/lib/server';

export const dynamic = 'force-dynamic';

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const session = await getSession().catch(() => null);
  const config = getConfig();

  if (!session) {
    return (
      <>
        <TopBar />
        <main className="shell">
          {error ? <div className="card error">Sign-in failed: {error}</div> : null}
          <div className="card">
            <h2>Sign in with Discord</h2>
            <p className="muted">
              The dashboard uses Discord OAuth2 (<code>identify guilds</code>) to learn which
              servers you manage. Server-side authorization is re-checked on every request with the
              bot token, so URL guessing or hidden UI is never enough to read another server&apos;s
              data.
            </p>
            <p>
              <Link className="button" href="/api/auth/login">
                Continue with Discord
              </Link>
            </p>
            <p className="muted">
              Dashboard module:{' '}
              <span className="badge">{config.dashboard.enabled ? 'enabled' : 'disabled'}</span>{' '}
              Music: <span className="badge">{config.music.enabled ? 'enabled' : 'disabled'}</span>
            </p>
          </div>
        </main>
      </>
    );
  }

  const { repos } = getDatabase();
  const tracked = await repos.guilds.listGuildsForIds(session.guildIds).catch(() => []);
  const byId = new Map(tracked.map((row) => [row.id, row]));

  return (
    <>
      <TopBar right={<LogoutButton />} />
      <main className="shell">
        <div className="card">
          <h2>
            Signed in as {session.globalName ?? session.username ?? session.userId}{' '}
            {session.isOwner ? <span className="badge ok">bot owner</span> : null}
          </h2>
          <p className="muted">
            Session expires {session.expiresAt.toISOString()} · {session.guildIds.length} manageable
            server(s).
          </p>
        </div>

        <div className="card">
          <h2>Your servers</h2>
          {session.guildIds.length === 0 ? (
            <p className="muted">You do not manage any server that this bot can see.</p>
          ) : (
            <div className="grid">
              {session.guildIds.map((id) => {
                const row = byId.get(id);
                return (
                  <div className="stat" key={id}>
                    <div className="label">{row?.name ?? 'Unknown server'}</div>
                    <div className="value">{row?.member_count ?? '—'}</div>
                    <div className="sub">
                      {row ? (
                        row.left_at ? (
                          <span className="badge bad">bot left</span>
                        ) : (
                          <span className="badge ok">tracked</span>
                        )
                      ) : (
                        <span className="badge warn">not yet seen</span>
                      )}
                    </div>
                    <p>
                      <Link href={`/guilds/${id}`}>Open configuration →</Link>
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>
    </>
  );
}
