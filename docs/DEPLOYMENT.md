# Deployment

## 1. Prerequisites

| Component           | Required | Notes                                                     |
| ------------------- | -------- | --------------------------------------------------------- |
| Node.js             | yes      | 20.11+ (22 LTS recommended); the repo is ESM-only         |
| PostgreSQL          | yes      | 14+ (16 recommended). The bot exits if it cannot reach it |
| Redis               | no       | only for cross-process rate limiting                      |
| Lavalink 4          | optional | required for music playback                               |
| Spotify credentials | optional | metadata only; see §6                                     |

## 2. Environment

```bash
cp .env.example .env
```

Fill in at minimum: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `BOT_OWNER_IDS`,
`DATABASE_URL`, and for the dashboard `DISCORD_CLIENT_SECRET`,
`DISCORD_REDIRECT_URI`, `SESSION_SECRET` (`openssl rand -hex 32`).

`.env.example` documents every variable. Invalid configuration prints the offending
variable names and exits — no partial startup.

## 3. Bare-metal / VM

```bash
npm ci
npm run build
npm run migrate
npm run deploy:commands -- --global      # first deploy; up to 1h to propagate
node apps/bot/dist/index.js              # bot
npm run start -w @bot-by-ai/dashboard    # dashboard (separate process/port)
```

Systemd units (adjust paths and the user):

```ini
# /etc/systemd/system/bot-by-ai.service
[Unit]
Description=Bot-by-ai Discord bot
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=botbyai
WorkingDirectory=/opt/bot-by-ai
EnvironmentFile=/opt/bot-by-ai/.env
ExecStart=/usr/bin/node apps/bot/dist/index.js
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=20
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

The bot handles `SIGTERM`/`SIGINT`: it stops the scheduler, disconnects music, marks
its instance offline, closes the client and the pool, then exits within 15 s.

## 4. Docker / Compose

```bash
cp .env.example .env
docker compose up -d --build
docker compose run --rm migrate            # profile: tools
docker compose run --rm deploy-commands    # profile: tools
docker compose logs -f bot
```

Services: `postgres`, `redis`, `bot`, `dashboard`, plus profile-gated `lavalink`
(`--profile music`) and `lavalink-lavasrc` (`--profile music-spotify`).

Images:

- `Dockerfile` — bot runtime (tini, non-root `node`, healthcheck on `/healthz`)
- `Dockerfile.dashboard` — dashboard runtime (tini, non-root, healthcheck on `/`)

Notes:

- The bot container runs with `read_only: true` and a `/tmp` tmpfs — it writes
  nothing to disk.
- `docker compose build` reuses layers, so running both services is cheap.
- Compose injects `DATABASE_URL` pointing at the `postgres` service; anything you
  set in `.env` for the host is overridden inside the network.
- Set `DISCORD_REDIRECT_URI` to the URL the browser reaches the dashboard on
  (`http://localhost:3000/...` locally, your public HTTPS URL in production).

## 5. Health, metrics and shutdown

| Endpoint           | Meaning                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| `GET /healthz`     | process is alive (always 200 while serving)                                |
| `GET /readyz`      | 200 only when the gateway is ready **and** PostgreSQL answers `SELECT 1`   |
| `GET /metrics`     | JSON snapshot (uptime, ping, guilds, memory, CPU, DB latency, error count) |
| `GET /metrics.txt` | Prometheus text exposition for scraping                                    |

Served on `PORT` (default 8080) when `METRICS_ENABLED=true` (default) — keep it on a
private network or behind authentication; it exposes operational data, not secrets.

Kubernetes liveness/readiness:

```yaml
livenessProbe:
  { httpGet: { path: /healthz, port: 8080 }, initialDelaySeconds: 20, periodSeconds: 30 }
readinessProbe:
  { httpGet: { path: /readyz, port: 8080 }, initialDelaySeconds: 15, periodSeconds: 15 }
```

## 6. Music (Lavalink) — including the Spotify reality

The bot talks to Lavalink over WebSocket (`LAVALINK_HOST`, `LAVALINK_PORT`,
`LAVALINK_PASSWORD`, `LAVALINK_SECURE`) and only when `ENABLE_MUSIC=true`. Without
Lavalink the music commands report that music is unavailable instead of failing
silently.

```bash
cp docker/lavalink/application.yml /etc/lavalink/application.yml   # or run the compose profile
docker compose --profile music up -d
```

Then set in `.env`:

```bash
ENABLE_MUSIC=true
LAVALINK_HOST=lavalink        # service name inside compose, hostname/IP elsewhere
LAVALINK_PORT=2333
LAVALINK_PASSWORD=...         # must match the Lavalink server password
```

**Spotify:** with `SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET` and a Lavalink plugin
such as [LavaSrc] configured in `docker/lavalink/application-lavasrc.yml`, the bot
can resolve Spotify track/album/playlist _metadata_ and search an equivalent audio
source for playback. Without the plugin it falls back to title/artist search. The
bot never claims to stream Spotify audio directly, and Spotify credentials alone are
not enough to play Spotify tracks — a source plugin plus Lavalink is required.

[LavaSrc]: https://github.com/topi314/LavaSrc

Recommended YouTube fallback in Lavalink 4 (the built-in clients get blocked over
time): install `youtube-plugin` and keep it updated, or use another source.

## 7. Scaling and operations

- **Sharding** — the client is constructed in `core/client.ts`; add `shards: 'auto'`
  there for large deployments. `StatusService` already reports `shard_id` and each
  instance heartbeats separately into `bot_instances`.
- **Multiple bot instances** — safe: commands are stateless, settings reads are
  cache-per-process with a 30 s TTL, migrations are advisory-locked, and scheduled
  tasks are claimed with `FOR UPDATE SKIP LOCKED` semantics so two workers never run
  the same task.
- **Redis** — set `REDIS_URL` to share rate-limit state between instances.
- **Backups** — see [DATABASE.md](DATABASE.md#backups).
- **Upgrades** — pull, `npm ci`, `npm run build`, `npm run migrate`, restart the
  services. Reload slash commands with `npm run deploy:commands -- --global` when
  command definitions changed (the bot does _not_ re-register on every boot, which
  would waste rate limit).
- **CI** — `.github/workflows/ci.yml` runs Prettier, ESLint, typecheck (workspaces +
  tests), build, unit tests, PostgreSQL integration tests and both Docker builds on
  every push and PR.

## 8. First-deploy checklist

- [ ] `.env` filled in, `SESSION_SECRET` random and >= 32 chars
- [ ] `BOT_OWNER_IDS` contains the two ids you intend (both equal privilege)
- [ ] `npm run migrate` succeeded
- [ ] `npm run deploy:commands -- --global` registered 97 commands
- [ ] `/readyz` returns 200; `/metrics` responds on the private port
- [ ] Bot invited with the permissions listed in `core/constants.ts`
      (Manage Roles, Manage Channels, Manage Messages, Kick, Ban, Moderate Members,
      Read/Send Messages, Embed Links, Attach Files, Add Reactions, Manage Webhooks,
      Connect & Speak for music)
- [ ] Dashboard redirect URI matches `DISCORD_REDIRECT_URI` exactly
- [ ] Owner panel reachable from the owner account and 403 for a normal admin
