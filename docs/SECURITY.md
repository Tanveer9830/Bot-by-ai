# Security

This document describes the security model that is actually implemented, plus the
limits you should know about before deploying.

## 1. Owner authorization (centralised)

- Owner ids come from `BOT_OWNER_IDS` (comma separated). They are validated at
  startup: malformed ids throw `ConfigError` and the process exits — the bot never
  boots with a half-parsed owner list.
- `packages/shared/src/security/owner.ts` is the **only** place that compares a user
  id against an owner id. There is no other hard-coded owner check in the codebase.
- Both configured ids have identical privileges. There is no primary owner with
  extra powers, no hidden account, no backdoor command, and no bypass of the check.
- `interactionCreate` refuses `ownerOnly` commands for non-owners _before_ the
  handler runs, and the handlers call `owners.assertOwner()` again (defence in
  depth).
- **Discord permissions never grant owner powers.** `OWNER_BYPASS_PERMISSIONS`
  lists Administrator / ManageGuild / ManageRoles / ManageWebhooks explicitly so a
  reviewer can confirm the intent, and a unit test asserts it. Owner-only commands
  also declare no `default_member_permissions`, which a test verifies.
- Dashboard: `/owner` page and `/api/owner` both call `requireOwner()` server-side;
  a non-owner receives 403 even when calling the API directly.

## 2. Dashboard authorization

Per request, in order:

1. session cookie present and valid in `dashboard_sessions` (not expired, not
   revoked);
2. the guild id appears in the guild list captured at OAuth2 login;
3. **live check** with the bot token: the bot is in the guild and the user still
   holds `MANAGE_GUILD` or `ADMINISTRATOR` (or is the guild owner).

Consequences: losing a role removes access immediately; a server where the bot is
absent cannot be read; and hiding UI is never used as an authorization decision.

Additional controls:

- OAuth2 `state` is random and HMAC-signed, stored in an HttpOnly, SameSite=Lax
  cookie with a 10-minute lifetime.
- The OAuth2 access token is used once (identity + guild list) and discarded — it is
  never stored, never logged, and never sent to the browser.
- Session cookies are opaque random values; the database stores only
  `HMAC-SHA256(SESSION_SECRET, token)` and lookups are indexed by that hash.
- Mutating API routes reject cross-origin requests (`Origin` check), and all routes
  are `force-dynamic` so no response is cached across users.
- Security headers are set in `next.config.mjs`
  (`X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options: DENY`,
  `Permissions-Policy`), telemetry is off, `poweredByHeader` is disabled.
- Sessions are revocable: `/api/auth/logout` revokes server-side.

## 3. Custom commands are data, not code

`/customcommand` (server admins) and `/globalcommand` (owners) store a JSON payload
validated by `customCommandSchema` (zod):

- the only executable-looking field is `actions`, restricted to
  `add_role | remove_role | send_dm | reply_ephemeral`;
- templates use `renderTemplate`, an allow-listed substitution
  (user/server/channel/command/date/timestamp). Unknown placeholders are left
  verbatim and reported, never evaluated;
- there is **no `eval`, `new Function`, `child_process`, `vm` or dynamic import**
  anywhere in the custom-command path (grep for them: the only `eval` matches are in
  documentation text);
- markdown is escaped for usernames and mentions are sanitised in arguments, so a
  command cannot be used to ping `@everyone` from untrusted input;
- role changes are clamped: the bot only adds/removes roles strictly below its own
  highest role.

## 4. Secrets

- Secret values are read from the environment only. No secret is committed —
  `.gitignore` excludes `.env`, `.env.*` (except `.env.example`), `*.pem`, dumps and
  backups.
- `.env.example` contains placeholders only.
- `SECRET_ENV_KEYS` in `packages/shared/src/config/env.ts` lists every secret the
  logger must redact: `DISCORD_TOKEN`, `DISCORD_CLIENT_SECRET`, `SESSION_SECRET`,
  `DATABASE_URL`, `REDIS_URL`, `LAVALINK_PASSWORD`, `SPOTIFY_CLIENT_SECRET`. The
  logger escapes control characters and redacts Discord/bearer token shapes.
- Configuration errors print the variable _name_ and the problem, never the value.
- The dashboard renders "configured / not configured", never a secret.
- One consistent variable name — `DISCORD_TOKEN` — is used everywhere.

## 5. Discord-side controls

- Slash commands declare `default_member_permissions` where appropriate (moderation
  and configuration commands), and the bot re-checks permissions server-side via
  `assertCanModerate` and role-hierarchy comparisons. Discord's UI permissions are a
  convenience, never the only gate.
- Hierarchy: the bot refuses to act on members whose highest role is at or above its
  own, unless the caller is a bot owner (`botOwnerOverride`, audited).
- Owner-only commands are registered globally without permission defaults so they
  are visible only to the owners who can actually run them.

## 6. Abuse resistance

- Per-user/per-guild command cooldown buckets, plus a shared `RateLimiter` for
  expensive paths.
- AutoMod handles mention floods, duplicate spam, invite/phishing links, caps,
  emojis and attachment rules before other handlers run.
- `no-tag` and `no-pin` react to violations instead of pretending to prevent them
  (see README limits).
- Economy writes are transactional with idempotency keys, so a replayed request
  cannot duplicate currency.

## 7. Reporting / rotation

1. Rotate the Discord token in the developer portal, update `DISCORD_TOKEN`, restart.
2. Rotate `SESSION_SECRET`: all dashboard sessions become invalid immediately
   (`openssl rand -hex 32`).
3. Rotate the database password and `LAVALINK_PASSWORD`; update the secret store and
   restart the affected services.
4. Review `audit_logs` (`/ownermaintenance audit`, or the owner panel) for the
   window of exposure — bot, dashboard and owner actions are all recorded with actor
   ids and actor types (`user`, `system`, `dashboard`, `bot`).

## 8. Known limits (stated plainly)

- The dashboard trusts PostgreSQL and the Discord API for authorization; anyone with
  direct database access can read/modify everything by design.
- No 2FA is implemented on top of Discord's own account security.
- `/no-pin` cannot stop a member with pin permission from pinning; it monitors,
  reports and can revert when the bot has `ManageMessages`.
- Rate limiting is per process unless `REDIS_URL` is configured.
- `DATABASE_SSL=true` uses `rejectUnauthorized: false` for managed providers; use a
  mounted CA with strict verification if your threat model requires it.
