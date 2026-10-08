-- 0002_dashboard.sql
-- Dashboard session metadata. OAuth2 access/refresh tokens are intentionally NOT
-- stored: the Discord access token is used once at login to read the user's
-- identity and guild list, then discarded. Every later authorization decision is
-- re-derived server-side (see apps/dashboard/src/lib/authz.ts).

ALTER TABLE dashboard_sessions
  ADD COLUMN IF NOT EXISTS username TEXT,
  ADD COLUMN IF NOT EXISTS global_name TEXT,
  ADD COLUMN IF NOT EXISTS avatar TEXT,
  ADD COLUMN IF NOT EXISTS user_guild_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS dashboard_sessions_active_idx
  ON dashboard_sessions (user_id, last_seen_at DESC)
  WHERE revoked_at IS NULL;
