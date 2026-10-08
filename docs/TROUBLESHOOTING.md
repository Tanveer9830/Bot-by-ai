# Troubleshooting

## Startup

**`✖ Configuration is invalid. Fix these environment variables and restart`**
Prints the variable names. Common causes: `DISCORD_TOKEN` missing, `BOT_OWNER_IDS`
empty or containing a non-snowflake value, `SESSION_SECRET` shorter than 32 chars
(required when `ENABLE_DASHBOARD=true` or `NODE_ENV=production`), `SPOTIFY_CLIENT_ID`
without `SPOTIFY_CLIENT_SECRET`.

**`database is unreachable — refusing to start (no insecure fallback)`**
Check `DATABASE_URL`, that PostgreSQL is running and reachable
(`psql "$DATABASE_URL" -c 'select 1'`), and `DATABASE_SSL` for managed providers.
Inside Compose the host is the service name `postgres`, not `localhost`.

**`relation "guild_settings" does not exist` or similar**
Migrations were not applied: `npm run migrate`. In Compose:
`docker compose run --rm migrate`.

**`migration 000X failed: …`**
The failing file is transactional, so nothing was applied from it. Fix the SQL,
then re-run. Checksum drift on an already-applied file is only _reported_ — revert
the file or add a new migration instead of editing history.

## Commands

**Commands do not appear in Discord**

1. `npm run deploy:commands -- --global` (or without `--global` and with
   `DEV_GUILD_ID` set). Global propagation can take up to an hour.
2. Verify the count: `npm run commands:count` → expect `loaded: 97`,
   `validationIssues: 0`.
3. The bot must be invited with the `applications.commands` scope.
4. A command module that fails validation is skipped and logged at startup — check
   the logs for `command failed validation`.

**`That command is not available right now`**
The command exists in Discord but not in the registry — deploy commands after
pulling changes, or the name was renamed.

**A custom command answers nothing**
Guild commands are looked up first, then _published_ global ones. Check
`/customcommand list` / `/globalcommand list` (state must be enabled and, for
global, published). Prefix commands also need the guild prefix (`/config view` →
`general.prefix`) and the name must not be in `disabledCommandNames`.

**`/help` shows a category but the command is missing**
That module failed to load. Startup logs list the file and the validation issue.

## Permissions

**`I need the following permission(s) …`**
The bot's own role is too low or a permission is missing. Required set is listed in
`core/constants.ts` and `/permissions`.

**`You cannot moderate a member with an equal or higher role`**
Discord role hierarchy: move the bot's role above the target's, or act as a bot
owner (the override is audited).

**A server admin cannot run `/globalcommand`**
Correct, by design. Global custom commands are restricted to `BOT_OWNER_IDS`;
Discord Administrator does not grant them.

## Dashboard

**`Discord OAuth2 is not configured` (HTTP 503)**
Set `DISCORD_CLIENT_SECRET` and `DISCORD_REDIRECT_URI` and restart the dashboard.

**`Invalid or expired OAuth2 state`**
The state cookie is missing or older than 10 minutes. Start sign-in again from the
dashboard; make sure cookies are not blocked and that the domain in
`DISCORD_REDIRECT_URI` matches the one you browse.

**`invalid_grant` from Discord**
`DISCORD_REDIRECT_URI` does not match the portal entry exactly (scheme, host, port,
trailing slash), or the code was already used — start over.

**Signed in but "You do not have access to that server"**
Either the guild is not in your OAuth2 guild list (you lack Manage Server there), or
the live bot check failed: the bot is not in that guild, or you lost the permission
after logging in. Re-check in Discord and reload; the dashboard re-verifies on every
request.

**`/owner` returns 403**
Your user id is not in `BOT_OWNER_IDS`. Update the env and restart both the bot and
the dashboard (they read the list independently).

**`SESSION_SECRET is required (>= 32 characters)`**
The dashboard refuses to start auth without a real secret rather than using a weak
default. Generate one: `openssl rand -hex 32`.

**A settings save returns 422 with an `issues` array**
The shared zod schema rejected the value. The response lists `path` and `message` per
field; the editor shows them inline. This is the same validation the bot applies.

## Database

**`remaining connection slots are reserved`**
Too many pools: lower `DATABASE_POOL_MAX` or add PgBouncer. Each bot/dashboard
process opens its own pool.

**Tasks pile up in `scheduled_tasks`**
The scheduler runs in the bot process. Check `/owner status`, then inspect failed
tasks: they retry with backoff up to 5 attempts and record the error. Giveaway ends,
reminder delivery, ticket auto-close and retention cleanup are all task-driven.

**Command usage/time-line charts are empty**
`command_usage` is written per invocation, so a fresh install shows nothing until
commands run. The UI says "unavailable" rather than inventing data.

## Tests

**`7 tests skipped` in `npm test`**
`tests/integration/database.test.ts` needs `TEST_DATABASE_URL`. Without it those
tests skip (never reported as passing). Locally:

```bash
createdb botbyai_test
TEST_DATABASE_URL=postgres://localhost/botbyai_test npm test
```

**Prettier/ESLint fails in CI but not locally**
Run the same commands CI does: `npm run format` (writes), `npm run lint`,
`npm run typecheck:all`.

## Music

**`Music is disabled on this deployment`**
`ENABLE_MUSIC` is false or Lavalink credentials are missing. The bot only connects
when both are present.

**Connected to Lavalink but tracks fail to load**
Lavalink has no working source. Update Lavalink and the YouTube plugin, or configure
LavaSrc for Spotify metadata (`docker/lavalink/application-lavasrc.yml`). Spotify
credentials alone do not decode Spotify audio.

## Logs and metrics

**`/metrics` returns 404**
`METRICS_ENABLED=false` (and `NODE_ENV=production`, where the health server is only
started when metrics are on). Set `METRICS_ENABLED=true` and restart.

**Unexpected restarts**
Check `bot_instances` and the logs for `uncaught exception`. The process deliberately
shuts down (exit code 1) on an uncaught exception after logging it, so the supervisor
can start a clean process rather than continue in an unknown state.
