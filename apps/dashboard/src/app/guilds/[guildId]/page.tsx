import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MODULE_NAMES } from '@bot-by-ai/shared';
import { TopBar } from '@/components/TopBar';
import { SettingsEditor } from '@/components/SettingsEditor';
import { requireGuildAccess } from '@/lib/authz';
import { getConfig, getDatabase } from '@/lib/server';

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

export default async function GuildPage({ params }: { params: Promise<{ guildId: string }> }) {
  const { guildId } = await params;
  const auth = await requireGuildAccess(guildId);
  if (!auth.ok) {
    if (auth.response.status === 401) {
      return (
        <>
          <TopBar />
          <main className="shell">
            <div className="card">
              <h2>Sign in required</h2>
              <p>
                <Link className="button" href="/api/auth/login">
                  Continue with Discord
                </Link>
              </p>
            </div>
          </main>
        </>
      );
    }
    if (auth.response.status === 403) {
      const detail = await auth.response.json().catch(() => ({ error: 'Access denied.' }));
      return (
        <>
          <TopBar />
          <main className="shell">
            <div className="card">
              <h2 className="error">Access denied</h2>
              <p>{detail.error}</p>
              <p>
                <Link href="/">Back to your servers</Link>
              </p>
            </div>
          </main>
        </>
      );
    }
    notFound();
  }

  const { repos } = getDatabase();
  const config = getConfig();
  const [
    guild,
    overview,
    moderationByAction,
    moderationByDay,
    commandDays,
    topCommands,
    tickets,
    settings,
    customCommands,
    history,
  ] = await Promise.all([
    repos.guilds.getGuild(guildId),
    repos.analytics.guildOverview(guildId),
    repos.analytics.moderationByAction(guildId, 30),
    repos.analytics.moderationByDay(guildId, 14),
    repos.commandUsage.statsForGuild(guildId, 14),
    repos.commandUsage.topCommands(guildId, 30, 10),
    repos.tickets.stats(guildId),
    repos.guilds.getAllModuleSettings(guildId),
    repos.customCommands.listGuild(guildId),
    repos.guilds
      .getSettingsHistory(guildId, 10)
      .catch(() => [] as Awaited<ReturnType<typeof repos.guilds.getSettingsHistory>>),
  ]);

  const enabledModules = Object.keys(settings);

  return (
    <>
      <TopBar />
      <main className="shell">
        <div className="card">
          <h2>
            {guild?.name ?? auth.value.guildName} <span className="badge">{guildId}</span>
          </h2>
          <p className="muted">
            {guild
              ? `${guild.member_count} members recorded in the database`
              : 'This server has not been stored yet — the bot writes it on the next event.'}
            {auth.value.verifiedFresh ? '' : ' · you are the server owner'}
          </p>
        </div>

        <div className="card">
          <h2>Overview (last 30 days)</h2>
          <div className="grid">
            <Stat
              label="Moderation cases"
              value={overview.moderationCases30d}
              sub="30 day window"
            />
            <Stat label="Warnings" value={overview.warnings30d} sub="30 day window" />
            <Stat label="Security events" value={overview.securityEvents30d} sub="30 day window" />
            <Stat
              label="Open tickets"
              value={overview.openTickets}
              sub={`${tickets.closed} closed · avg rating ${tickets.avgRating ?? 'unavailable'}`}
            />
            <Stat label="Active giveaways" value={overview.giveawaysActive} />
            <Stat label="Suggestions" value={overview.suggestions30d} sub="30 day window" />
            <Stat label="Economy accounts" value={overview.economyAccounts} />
            <Stat label="Members with XP" value={overview.levelsTracked} />
            <Stat label="Users tracked (all guilds)" value={overview.trackedUsers} />
            <Stat
              label="Configured modules"
              value={enabledModules.length}
              sub={enabledModules.join(', ') || 'none yet'}
            />
            <Stat label="Custom commands" value={customCommands.length} />
          </div>
        </div>

        <div className="card">
          <h2>Moderation by action</h2>
          {moderationByAction.length === 0 ? (
            <p className="muted">No moderation cases recorded yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Cases</th>
                </tr>
              </thead>
              <tbody>
                {moderationByAction.map((row) => (
                  <tr key={row.action}>
                    <td>{row.action}</td>
                    <td>{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <h2>Daily activity</h2>
          <div className="grid">
            <div>
              <h3>Moderation (14 days)</h3>
              {moderationByDay.length === 0 ? (
                <p className="muted">Unavailable — no rows yet.</p>
              ) : (
                <table>
                  <tbody>
                    {moderationByDay.map((row) => (
                      <tr key={row.day}>
                        <td>{row.day}</td>
                        <td>{row.count} case(s)</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div>
              <h3>Command usage (14 days)</h3>
              {commandDays.length === 0 ? (
                <p className="muted">Unavailable — no rows yet.</p>
              ) : (
                <table>
                  <tbody>
                    {commandDays.map((row) => (
                      <tr key={row.day}>
                        <td>{row.day}</td>
                        <td>
                          {row.total} run(s){row.failed > 0 ? ` · ${row.failed} failed` : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>

        <div className="card">
          <h2>Most used commands (30 days)</h2>
          {topCommands.length === 0 ? (
            <p className="muted">
              Unavailable — command usage is recorded per invocation by the bot.
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Command</th>
                  <th>Uses</th>
                </tr>
              </thead>
              <tbody>
                {topCommands.map((row) => (
                  <tr key={row.command_name}>
                    <td>
                      <code>/{row.command_name}</code>
                    </td>
                    <td>{row.uses}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <SettingsEditor guildId={guildId} modules={MODULE_NAMES} />

        <div className="card">
          <h2>Server custom commands</h2>
          {customCommands.length === 0 ? (
            <p className="muted">
              None yet. Server commands are created in Discord with{' '}
              <code>/customcommand create</code>.
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Description</th>
                  <th>Enabled</th>
                  <th>Uses</th>
                </tr>
              </thead>
              <tbody>
                {customCommands.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <code>{row.name}</code>
                    </td>
                    <td>{row.description}</td>
                    <td>{row.enabled ? 'yes' : 'no'}</td>
                    <td>{row.uses}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <h2>Recent configuration changes</h2>
          {history.length === 0 ? (
            <p className="muted">No settings history recorded yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Module</th>
                  <th>By</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <tr key={row.id}>
                    <td>{new Date(row.changed_at).toISOString()}</td>
                    <td>{row.module}</td>
                    <td>{row.changed_by ?? 'system'}</td>
                    <td>{row.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <h2>Runtime features</h2>
          <p>
            Music: <span className="badge">{config.music.enabled ? 'enabled' : 'disabled'}</span> ·
            Lavalink:{' '}
            <span className="badge">{config.music.lavalink ? 'configured' : 'not configured'}</span>{' '}
            · Spotify metadata:{' '}
            <span className="badge">{config.music.spotify ? 'configured' : 'not configured'}</span>{' '}
            · Redis:{' '}
            <span className="badge">{config.redisUrl ? 'configured' : 'not configured'}</span> ·
            Metrics: <span className="badge">{config.metricsEnabled ? 'on' : 'off'}</span>
          </p>
          <p className="muted">
            Active music players per guild are held in the bot process and are not exposed by the
            database, so this page shows configuration, not a player snapshot.
          </p>
        </div>
      </main>
    </>
  );
}
