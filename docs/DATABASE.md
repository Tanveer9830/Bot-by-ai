# Database

PostgreSQL is the only persistence layer. **There is no MongoDB/Mongoose anywhere
in this repository** (verify with `grep -ri mongo --exclude-dir=node_modules .`).

- Driver: `pg` (node-postgres) with a pooled connection (`packages/database/src/pool.ts`)
- Migrations: plain SQL files in `database/migrations`, applied in a transaction
  each, under a PostgreSQL advisory lock (`982451653`) so parallel deploys are safe
- Access: 14 repositories in `packages/database/src/repositories/*`
- CLI: `npm run migrate`, `npm run migrate:status`, `npm run seed`

## Migrations

| File                 | Contents                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `0001_init.sql`      | full schema: users, guilds, settings, moderation, security, tickets, economy, levels, community, tasks, audit, sessions, instances |
| `0002_dashboard.sql` | dashboard session profile columns + partial index for active sessions                                                              |

```bash
export DATABASE_URL=postgres://user:pass@localhost:5432/botbyai
npm run migrate           # apply pending
npm run migrate:status    # list applied/pending + checksum drift
npm run seed              # shop items, achievements and other reference rows
npm run test:db           # validate every migration file against a real engine (PGlite)
```

Behaviour worth knowing:

- **Checksum drift is reported, never silently repaired.** If an already-applied
  file changed, `migrate` prints the drift and leaves the database alone.
- Advisory locking means several bot/dashboard containers can start at once; only
  one applies the migration, the others wait.
- Migrations run inside `BEGIN … COMMIT`, so a failure leaves no half-applied file.
  Additive `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS` keep reruns
  idempotent.

## Entity overview

```
users ─┬─ member_levels (xp, level)
       ├─ economy_accounts ── economy_transactions (idempotency_key UNIQUE)
       ├─ warnings / moderation_cases ── moderation_appeals
       ├─ inventory ── shop_items
       └─ birthdays / reminders
guilds ─┬─ guild_settings (per-module JSONB) ── guild_settings_history
        ├─ custom_commands (scope: global | guild)
        ├─ tickets ── ticket_messages (transcripts)
        ├─ giveaways ── giveaway_entries
        ├─ suggestions ── suggestion_votes
        ├─ reaction_role_panels, starboard_entries
        ├─ security_events, automod_violations, notag_violations, nopin_events
        ├─ audit_logs, command_usage
        └─ scheduled_tasks  (worker queue: claim_due / complete / fail)
dashboard_sessions   (HMAC of the cookie value only)
bot_instances        (heartbeats written by StatusService)
schema_migrations    (applied migration bookkeeping)
```

### Settings storage model

Each guild holds one row per module in `guild_settings`:

```sql
CREATE TABLE guild_settings (
  guild_id   TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  module     TEXT NOT NULL,
  values     JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, module)
);
```

Why JSONB per module rather than one column per setting:

- 21 modules × ~10 fields would mean a very wide table and a migration for every
  new option;
- the zod schemas in `packages/shared/src/validation/schemas.ts` are the contract —
  `validateModuleSettings()` checks every write from both the bot and the dashboard;
- `guild_settings_history` keeps the previous/new values for every change, so
  rollbacks and audits stay possible.

Trade-off: ad-hoc SQL queries over settings need JSONB operators
(`values->>'channelId'`), and the schema is only enforced by the application layer.
Queries that need to be fast on settings values should get an expression index.

### Economy integrity

`EconomyRepository` performs every balance change inside `db.transaction()`:

1. `SELECT … FOR UPDATE` on the account rows (ordered by `user_id` to avoid
   deadlocks between two simultaneous transfers);
2. the transaction row is inserted with its `idempotency_key`; a replay of the same
   key returns the stored `balance_after` and moves no money;
3. the balance update is `wallet = wallet + $delta` with a `CHECK (wallet >= 0)`
   guard, so an overdraft raises instead of silently going negative.

The integration test suite asserts all three properties against a real database.

## Backups

```bash
# logical backup
pg_dump --format=custom --no-owner "$DATABASE_URL" > backup-$(date +%F).dump
# restore into a fresh database
pg_restore --clean --if-exists --no-owner -d "$TARGET_URL" backup-$(date +%F).dump
```

- Retentions already implemented in code: `AuditRepository.pruneOlderThan(days)`
  (used by `/ownermaintenance prune`), `TaskRepository.cleanup(days)`, and the
  scheduler's `retention_cleanup` task driven by the logging module's
  `retentionDays`.
- `dashboard_sessions.cleanup()` removes expired/revoked sessions.
- Restore drill: point `TEST_DATABASE_URL` at a restored database and run
  `npx vitest run tests/integration` — it validates the schema and core writes.

## Operational notes

- The pool defaults to 10 connections (`DATABASE_POOL_MAX`). With N bot containers,
  keep `N × max` below the server's `max_connections` (or put PgBouncer in front).
- `DATABASE_SSL=true` enables TLS with `rejectUnauthorized: false` for managed
  providers that use their own CA chain; mount a CA and adjust `pool.ts` if you need
  strict verification.
- The bot refuses to start when `SELECT 1` fails — there is no unauthenticated or
  offline fallback path that could corrupt state.
