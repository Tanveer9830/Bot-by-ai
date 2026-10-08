# Dashboard

Next.js 15 (App Router) + React 19. It reads the same PostgreSQL database as the bot
and calls the Discord API with the **bot** token for authorization checks.

## 1. Create the Discord application credentials

1. https://discord.com/developers/applications → your application → **OAuth2**
2. Add a redirect URI that matches `DISCORD_REDIRECT_URI` exactly, e.g.
   - local: `http://localhost:3000/api/auth/callback`
   - production: `https://dash.example.com/api/auth/callback`
3. Copy the **Client Secret** into `DISCORD_CLIENT_SECRET`.
4. Scopes used: `identify guilds` (identity + which servers you manage). No bot
   permissions are requested through OAuth2.

`DISCORD_REDIRECT_URI` must be an absolute URL in production — the config validator
rejects relative values there.

## 2. Environment

```bash
DISCORD_TOKEN=...            # bot token, used for the live permission re-check
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
DISCORD_REDIRECT_URI=https://dash.example.com/api/auth/callback
BOT_OWNER_IDS=1131248987173814336,1473315482554732786
DATABASE_URL=postgres://...
SESSION_SECRET=...           # >= 32 chars: openssl rand -hex 32
DASHBOARD_URL=https://dash.example.com
DASHBOARD_PORT=3000
ENABLE_DASHBOARD=true
SESSION_TTL_HOURS=168
```

Run it:

```bash
npm run dev:dashboard     # http://localhost:3000
# or production
npm run build -w @bot-by-ai/dashboard && npm run start -w @bot-by-ai/dashboard
```

## 3. Routes

| Route                                   | Auth                   | Purpose                                                          |
| --------------------------------------- | ---------------------- | ---------------------------------------------------------------- |
| `GET /`                                 | public                 | sign-in screen, or the list of servers you manage                |
| `GET /guilds/[guildId]`                 | session + guild access | real per-guild metrics, settings editor, history                 |
| `GET /owner`                            | **owner only**         | runtime, heartbeats, audit log, env flags (no secret values)     |
| `GET /api/auth/login`                   | public                 | starts OAuth2 (signed state cookie)                              |
| `GET /api/auth/callback`                | —                      | exchanges the code once, creates the session, discards the token |
| `POST /api/auth/logout`                 | session                | revokes the session server-side                                  |
| `GET /api/me`                           | session                | your own identity + manageable guilds                            |
| `GET /api/guilds`                       | session                | guilds you manage, cross-referenced with bot state               |
| `GET /api/guilds/[id]`                  | session + guild access | the JSON behind the guild page                                   |
| `GET /api/guilds/[id]/settings?module=` | session + guild access | read one settings module                                         |
| `PATCH /api/guilds/[id]/settings`       | session + guild access | validated write, audited                                         |
| `GET /api/owner`                        | **owner only**         | owner panel JSON (403 for everyone else)                         |

## 4. Authorization model

Every protected request runs the same chain (see `src/lib/authz.ts`):

```
cookie session → dashboard_sessions row (valid, not revoked)
              → guild id present in the OAuth2 guild list from login
              → LIVE bot-token check: bot in guild AND user has MANAGE_GUILD or ADMINISTRATOR
```

The third step is what makes hiding UI irrelevant: even a hand-crafted request is
rejected, and a user who lost their role after signing in loses access immediately
with no re-login. Owner routes use `requireOwner()` independently of the page code.

## 5. What the dashboard shows

All values come from PostgreSQL or the Discord API:

- overview counts (moderation cases, warnings, security events, open tickets,
  giveaways, suggestions, economy accounts, members with XP) over real windows;
- moderation by action and by day, command usage by day, top commands;
- ticket statistics including average rating (or "unavailable" when no ratings);
- settings per module with a JSON editor that validates server-side via the shared
  zod schema before writing, and records history + an audit row;
- settings change history with actor and source (`command` / `dashboard`);
- runtime block from `bot_instances` heartbeats (guilds, users, ping, memory,
  uptime, versions, last heartbeat).

Deliberately **not** shown: active music players per guild (in-process state) —
the page says so instead of inventing a number.

## 6. Security posture

- The OAuth2 access token never leaves the callback handler.
- Session cookies are HttpOnly, SameSite=Lax, `Secure` in production; only an HMAC
  of the value is stored.
- Cross-origin mutating requests are rejected; responses are never cached
  (`force-dynamic`).
- Secrets are never rendered — only "configured / not configured".
- Security headers are applied to every response.

Full threat notes: [SECURITY.md](SECURITY.md).

## 7. Deploying behind a reverse proxy

```nginx
server {
  listen 443 ssl;
  server_name dash.example.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Set `DASHBOARD_URL` to the public URL (the CSRF origin check compares against it and
the request origin), and keep the redirect URI in the Discord portal in sync.
