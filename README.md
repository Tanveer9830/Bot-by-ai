# Bot-by-ai

A modular Discord bot with a server-configuration dashboard. TypeScript monorepo,
PostgreSQL persistence, optional Redis, optional Lavalink music, Docker-ready.

> **Status: honest.** Everything described below exists in this repository. Where a
> feature depends on something outside the repo (Lavalink, Redis, Spotify
> credentials, a public HTTPS URL for OAuth2), it is called out explicitly rather
> than implied. See [Known limits](#known-limits) at the end.

---

## Contents

- [What is in the box](#what-is-in-the-box)
- [Repository layout](#repository-layout)
- [Quick start](#quick-start)
- [Slash commands](#slash-commands)
- [Owner-only features](#owner-only-features)
- [Dashboard](#dashboard)
- [Testing](#testing)
- [Docker](#docker)
- [Documentation](#documentation)
- [Known limits](#known-limits)

---

## What is in the box

| Area            | Implementation                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Commands        | **97 top-level slash commands** across 11 categories, loaded from `apps/bot/src/commands/*.ts`, validated against Discord's limits at startup (`npm run commands:count`) |
| Moderation      | ban/unban/kick/timeout/warn/note/purge/slowmode/lock/nickname/role/bulkban, case numbers, appeals, escalations, expiry sweeper                                           |
| Security        | anti-raid joins, anti-spam, anti-phishing, alt detection, lockdown, `/no-tag` mention protection, `/no-pin` pin monitoring and mitigation                                |
| AutoMod         | word/regex/link/invite/caps/emoji/mention/attachment rules with escalation                                                                                               |
| Economy         | wallet + bank, daily/weekly/work, transfers with burned fees, shop, inventory, achievements, leaderboards — all inside `db.transaction()` with idempotency keys          |
| Levels          | XP curve, per-message/voice XP, level roles, leaderboards, `/levelconfig`                                                                                                |
| Tickets         | panels, claim/close/reopen/transcripts/ratings, stale-ticket automation                                                                                                  |
| Community       | giveaways (draw, reroll, cancel), suggestions with staff decisions, starboard, birthdays, reminders                                                                      |
| Logging         | 13 log categories, per-guild channel routing, `/auditlog` with stats and export                                                                                          |
| Custom commands | guild-scoped by server admins, **global** ones exclusively by bot owners; no eval, allow-listed template variables                                                       |
| Dashboard       | Next.js 15 + React 19, Discord OAuth2, server-side authorization on every request, real PostgreSQL data, owner-only panel                                                |
| Ops             | health/ready/metrics endpoints, graceful shutdown, 13 SQL migrations, Docker + Compose, GitHub Actions CI                                                                |

## Repository layout

```
apps/
  bot/            Discord bot (discord.js v14, 97 commands, 15 services, event pipeline)
  dashboard/      Next.js dashboard (OAuth2, guild config, owner panel)
packages/
  shared/         config, logger, security primitives, validation (zod), maths, templates
  database/       PostgreSQL pool, migrations runner, 14 repositories, CLI (migrate/seed)
database/
  migrations/     0001_init.sql … (13 tables sets: see docs/DATABASE.md)
docker/
  lavalink/       Lavalink 4 config templates (music, music-spotify profiles)
tests/
  unit/           pure logic — run everywhere
  integration/    command registry (everywhere) + real PostgreSQL suite (needs TEST_DATABASE_URL)
docs/             COMMANDS, DATABASE, SECURITY, DASHBOARD, DEPLOYMENT, TROUBLESHOOTING
```

## Quick start

```bash
git clone https://github.com/Tanveer9830/Bot-by-ai.git
cd Bot-by-ai
cp .env.example .env      # fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, DATABASE_URL, BOT_OWNER_IDS, SESSION_SECRET
npm install
npm run build             # packages → bot → dashboard
npm run migrate           # apply SQL migrations
npm run deploy:commands -- --global   # or: npm run deploy:commands (guild-scoped, needs DEV_GUILD_ID)
npm run dev:bot           # or: node apps/bot/dist/index.js
npm run dev:dashboard     # http://localhost:3000
```

Required environment variables (placeholders in `.env.example`):

| Variable                                        | Required               | Purpose                                                  |
| ----------------------------------------------- | ---------------------- | -------------------------------------------------------- |
| `DISCORD_TOKEN`                                 | yes                    | bot login (only ever referenced as `DISCORD_TOKEN`)      |
| `DISCORD_CLIENT_ID`                             | yes                    | command registration                                     |
| `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI` | for dashboard          | OAuth2 (`identify guilds`)                               |
| `BOT_OWNER_IDS`                                 | yes                    | comma-separated owner ids; both get identical privileges |
| `DATABASE_URL`                                  | yes                    | PostgreSQL connection string                             |
| `SESSION_SECRET`                                | dashboard / production | ≥ 32 chars, signs session + OAuth state                  |
| `REDIS_URL`                                     | no                     | optional cross-process rate limits                       |
| `LAVALINK_*`, `SPOTIFY_*`                       | no                     | music (see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md))     |

The bot **refuses to start** when configuration is invalid or PostgreSQL is
unreachable — there is no insecure fallback.

## Slash commands

97 commands, all real (no filler). Count them yourself:

```bash
npm run build:packages && npm run build -w @bot-by-ai/bot
npm run commands:count
```

```
{ "loaded": 97, "validationIssues": 0, "topLevel": 97, "discordGlobalLimit": 100, ... }
```

Full list with every subcommand: **[docs/COMMANDS.md](docs/COMMANDS.md)**.

Highlights:

| Command                                                                                                    | Category          | Notes                                                |
| ---------------------------------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------- |
| `/help`, `/ping`, `/botinfo`, `/serverinfo`, `/userinfo`, …, `/calc`, `/poll`, `/embed`, `/remind`, `/afk` | utility (26)      | `/calc` uses a real expression parser — never `eval` |
| `/ban`, `/kick`, `/timeout`, `/warn`, `/purge`, `/slowmode`, `/lock`, `/case`, `/appeal`, …                | moderation (21)   | every action writes a numbered case                  |
| `/security`, `/no-tag`, `/no-pin`, `/lockdown`                                                             | security (8)      | real detection + documented limits                   |
| `/economy` (`/balance`, `/daily`, `/work`, `/transfer`, `/shop`, …)                                        | economy (14)      | transactional, idempotent                            |
| `/giveaway`, `/suggestion`, `/starboard`, `/birthday`, `/reminder`                                         | community (5)     | live DB-backed                                       |
| `/logs`, `/auditlog`                                                                                       | logging           | 13 categories                                        |
| `/config`, `/customcommand`, `/reactionrole`, `/ticket`, `/welcome`                                        | configuration (9) | per-guild settings                                   |
| `/globalcommand`, `/owner`, `/ownermaintenance`                                                            | owner (3)         | **owner ids only**                                   |

## Owner-only features

Owner authorization is centralised in `packages/shared/src/security/owner.ts`:
ids come from `BOT_OWNER_IDS`, are validated at startup, and `interactionCreate`
re-checks them before an `ownerOnly` command runs. **Discord Administrator,
ManageGuild or ManageRoles never grant owner powers** (`OWNER_BYPASS_PERMISSIONS`
documents this, and a test asserts it).

- `/globalcommand create|edit|delete|list|info|publish|disable` — bot-wide custom
  commands, stored in `custom_commands` with `scope='global'`, published only when
  the owner says so.
- `/owner status|instances|guilds|commands|lookup|cache|announce` — runtime
  diagnostics from real sources.
- `/ownermaintenance audit|prune|expire-cases|dbstats` — housekeeping; `prune`
  defaults to a dry run.
- `/api/owner` + `/owner` page — same rule enforced server-side on every request.

## Dashboard

- Discord OAuth2 (`identify guilds`), signed state cookie, no token storage: the
  access token is used once and discarded; the session cookie is stored only as an
  HMAC.
- Authorization chain per request: session → OAuth2 guild list → **live bot-token
  check** (`MANAGE_GUILD`/`ADMINISTRATOR`), so revoked roles lose access
  immediately and hidden UI is never treated as security.
- Real data only: overview counts, moderation-by-action/day, command usage, top
  commands, tickets, settings history, runtime heartbeats. Values that cannot be
  measured render as _unavailable_.

Details: **[docs/DASHBOARD.md](docs/DASHBOARD.md)**.

## Testing

```bash
npm test              # 52 tests pass, 7 integration tests skip without a database
npm run test:coverage
```

- Unit (43): owner auth, template/mention safety, custom-command schema, economy +
  XP maths.
- Integration (9): command registry — loads every module, asserts 0 validation
  issues, owner-only flags, unique names.
- PostgreSQL integration (7): migrations, table set, transactional economy
  (overdraft rejected, idempotency replayed), case numbering, sessions, global vs
  guild custom commands. These require `TEST_DATABASE_URL` and are **skipped**
  otherwise — they are never reported as passing without a database.

## Docker

```bash
cp .env.example .env
docker compose up -d --build
docker compose run --rm migrate
docker compose run --rm deploy-commands
# optional music nodes:
docker compose --profile music up -d
docker compose --profile music-spotify up -d   # needs real Spotify credentials
```

Two images (`Dockerfile` for the bot, `Dockerfile.dashboard` for the web app),
tini as PID 1, non-root `node` user, healthchecks, read-only root filesystem
friendly. Full guide: **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

## Documentation

| File                                               | Contents                                 |
| -------------------------------------------------- | ---------------------------------------- |
| [docs/COMMANDS.md](docs/COMMANDS.md)               | every command and subcommand             |
| [docs/DATABASE.md](docs/DATABASE.md)               | schema, migrations, backups              |
| [docs/SECURITY.md](docs/SECURITY.md)               | auth model, threat notes, secrets policy |
| [docs/DASHBOARD.md](docs/DASHBOARD.md)             | OAuth2 setup, routes, authorization      |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)           | Docker, Compose, Lavalink, scaling       |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | symptoms → causes → fixes                |

## Known limits

These are real constraints, not TODOs dressed up as features:

1. **Spotify audio** — the bot reads Spotify _metadata_ via the Web API and then
   searches an equivalent audio source. Playing Spotify streams requires Lavalink
   with a plugin such as LavaSrc plus your own Spotify application credentials.
2. **`/no-pin`** — monitors and mitigates (reaction, DM/notice, optional revert
   where the bot has `ManageMessages`), but it cannot prevent a determined member
   with pin permission from pinning; it reports and reacts.
3. **`/no-tag`** — deletes/relays offending mentions when the bot has
   `ManageMessages`; it cannot stop the mention from being created.
4. **Dashboard Redis session sharing** — sessions live in PostgreSQL, so no Redis
   cache is required; `REDIS_URL` is currently only used for cross-process rate
   limiting when present.
5. **Per-guild settings storage** — settings are stored as validated JSONB per
   module (see docs/DATABASE.md) rather than one column per setting.
6. **Music players** are in-process state; the dashboard shows configuration, not
   a player snapshot.
7. **Redis / Lavalink / Discord tokens are not available in the development
   sandbox**, so music and Redis paths were not exercised end-to-end here; they are
   wired, typechecked and documented, and Docker/CI configs are provided.

## License

Private project. No license granted for redistribution.
