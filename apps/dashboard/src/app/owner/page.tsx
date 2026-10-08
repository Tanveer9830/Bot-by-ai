import Link from 'next/link';
import { TopBar } from '@/components/TopBar';
import { APP_VERSION } from '@/lib/meta';
import { requireOwner } from '@/lib/authz';
import { getConfig, getDatabase, getOwners } from '@/lib/server';

export const dynamic = 'force-dynamic';

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  );
}

/**
 * Owner-only panel. `requireOwner()` runs on the server for this request; a
 * non-owner never reaches the queries below, and the API route enforces the
 * same rule independently.
 */
export default async function OwnerPage() {
  const auth = await requireOwner();

  if (!auth.ok) {
    const status = auth.response.status;
    const body = await auth.response.json().catch(() => ({ error: 'Access denied.' }));
    return (
      <>
        <TopBar />
        <main className="shell">
          <div className="card">
            <h2 className={status === 403 ? 'error' : undefined}>
              {status === 403 ? 'Owner access required' : 'Sign in required'}
            </h2>
            <p>{body.error}</p>
            <p className="muted">
              This panel is limited to the ids in <code>BOT_OWNER_IDS</code>. Discord administrator permissions do
              not grant access, and the check runs server-side on every request.
            </p>
            {status === 401 ? (
              <p>
                <Link className="button" href="/api/auth/login">
                  Continue with Discord
                </Link>
              </p>
            ) : (
              <p>
                <Link href="/">Back to overview</Link>
              </p>
            )}
          </div>
        </main>
      </>
    );
  }

  const { db, repos } = getDatabase();
  const config = getConfig();
  const owners = getOwners();

  const [health, instances, usage, sessions, pending, audit, globals] = await Promise.all([
    db.health().catch((error: unknown) => ({ ok: false, latencyMs: 0, error: String(error) })),
    repos.analytics.listBotInstances(),
    repos.commandUsage.globalStats(7),
    repos.sessions.countActive(),
    repos.tasks.pendingCount(),
    repos.audit.list({ limit: 25 }),
    repos.customCommands.listGlobal(),
  ]);

  return (
    <>
      <TopBar />
      <main className="shell">
        <div className="card">
          <h2>
            Owner panel <span className="badge ok">authorized server-side</span>
          </h2>
          <p className="muted">
            Signed in as <code>{auth.session.userId}</code> · owners: {owners.ids.map((id) => <code key={id}>{id} </code>)} ·
            dashboard v{APP_VERSION} · node {process.version}
          </p>
        </div>

        <div className="card">
          <h2>Database</h2>
          <div className="grid">
            <Stat
              label="PostgreSQL"
              value={health.ok ? 'healthy' : 'DOWN'}
              sub={health.ok ? `${health.latencyMs} ms round trip` : (health.error ?? 'unknown error')}
            />
            <Stat label="Active dashboard sessions" value={sessions ?? 'unavailable'} />
            <Stat label="Pending scheduled tasks" value={pending ?? 'unavailable'} />
            <Stat
              label="Commands (7 days, all guilds)"
              value={usage.total}
              sub={`${usage.failed} failed · ${usage.activeGuilds} active guild(s)`}
            />
          </div>
        </div>

        <div className="card">
          <h2>Recorded bot instances</h2>
          {instances.length === 0 ? (
            <p className="muted">
              No heartbeat recorded yet. The bot writes one to <code>bot_instances</code> after it connects.
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Instance</th>
                  <th>Status</th>
                  <th>Guilds</th>
                  <th>Users</th>
                  <th>Ping</th>
                  <th>Memory</th>
                  <th>Uptime</th>
                  <th>Version</th>
                  <th>Last heartbeat</th>
                </tr>
              </thead>
              <tbody>
                {instances.map((instance) => (
                  <tr key={instance.id}>
                    <td>
                      <code>{instance.id}</code>
                    </td>
                    <td>
                      <span className={`badge ${instance.status === 'online' ? 'ok' : 'warn'}`}>{instance.status}</span>
                    </td>
                    <td>{instance.guild_count}</td>
                    <td>{Number(instance.user_count).toLocaleString('en-US')}</td>
                    <td>{instance.ws_ping_ms === null ? 'unavailable' : `${instance.ws_ping_ms} ms`}</td>
                    <td>{instance.memory_mb === null ? 'unavailable' : `${instance.memory_mb} MB`}</td>
                    <td>{Math.round(Number(instance.uptime_seconds) / 60)} min</td>
                    <td>
                      {instance.version ?? '?'} / {instance.node_version ?? '?'}
                    </td>
                    <td>{new Date(instance.last_heartbeat_at).toISOString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <h2>Environment (no secret values)</h2>
          <table>
            <tbody>
              {Object.entries({
                NODE_ENV: config.nodeEnv,
                'production mode': String(config.isProduction),
                'dashboard module': config.dashboard.enabled ? 'enabled' : 'disabled',
                'session TTL': `${Math.round(config.dashboard.sessionTtlMs / 3_600_000)} h`,
                'music module': config.music.enabled ? 'enabled' : 'disabled',
                Lavalink: config.music.lavalink ? 'configured' : 'not configured',
                'Spotify metadata': config.music.spotify ? 'configured' : 'not configured',
                Redis: config.redisUrl ? 'configured' : 'not configured',
                metrics: config.metricsEnabled ? 'enabled' : 'disabled',
              }).map(([key, value]) => (
                <tr key={key}>
                  <th>{key}</th>
                  <td>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            Secret values (token, client secret, session secret, database URL, Lavalink password) are never rendered —
            only whether they are configured.
          </p>
        </div>

        <div className="card">
          <h2>Global custom commands</h2>
          {globals.length === 0 ? (
            <p className="muted">
              None defined. Create them in Discord with <code>/globalcommand create</code> (owner-only) and publish
              with <code>/globalcommand publish</code>.
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Published</th>
                  <th>Enabled</th>
                  <th>Uses</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {globals.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <code>{row.name}</code>
                    </td>
                    <td>{row.published ? 'yes' : 'no'}</td>
                    <td>{row.enabled ? 'yes' : 'no'}</td>
                    <td>{row.uses}</td>
                    <td>{new Date(row.updated_at).toISOString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <h2>Recent audit entries ({audit.total} total)</h2>
          {audit.rows.length === 0 ? (
            <p className="muted">No audit rows yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Actor</th>
                  <th>Guild</th>
                  <th>Target</th>
                </tr>
              </thead>
              <tbody>
                {audit.rows.map((row) => (
                  <tr key={row.id}>
                    <td>{new Date(row.created_at).toISOString()}</td>
                    <td>
                      <code>{row.action}</code>
                    </td>
                    <td>
                      {row.actor_id ? `${row.actor_id} (${row.actor_type})` : row.actor_type}
                    </td>
                    <td>{row.guild_id ?? '—'}</td>
                    <td>{row.target_type ? `${row.target_type}:${row.target_id ?? '—'}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </>
  );
}
