-- 0001_init.sql — core schema for bot-by-ai
-- Discord IDs are stored as TEXT (snowflakes exceed JS safe integer range).

BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL DEFAULT 'unknown',
  global_name   TEXT,
  discriminator TEXT,
  avatar        TEXT,
  is_bot        BOOLEAN NOT NULL DEFAULT FALSE,
  locale        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guilds (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL DEFAULT 'unknown',
  icon          TEXT,
  owner_id      TEXT,
  member_count  INTEGER NOT NULL DEFAULT 0,
  features      TEXT[] NOT NULL DEFAULT '{}',
  joined_at     TIMESTAMPTZ,
  left_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS guilds_left_at_idx ON guilds (left_at);

CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id   TEXT PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,
  modules    JSONB NOT NULL DEFAULT '{}'::jsonb,
  version    INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guild_settings_history (
  id         BIGSERIAL PRIMARY KEY,
  guild_id   TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  module     TEXT NOT NULL,
  changed_by TEXT,
  source     TEXT NOT NULL DEFAULT 'dashboard',
  old_values JSONB,
  new_values JSONB,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS guild_settings_history_guild_idx
  ON guild_settings_history (guild_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS counters (
  guild_id TEXT NOT NULL,
  name     TEXT NOT NULL,
  value    BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, name)
);

-- ---------------------------------------------------------------- moderation

CREATE TABLE IF NOT EXISTS moderation_cases (
  id            BIGSERIAL PRIMARY KEY,
  guild_id      TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  case_number   INTEGER NOT NULL,
  user_id       TEXT NOT NULL,
  moderator_id  TEXT NOT NULL,
  action        TEXT NOT NULL,
  reason        TEXT,
  duration_ms   BIGINT,
  expires_at    TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'active',
  evidence      JSONB,
  source        TEXT NOT NULL DEFAULT 'command',
  appeal_status TEXT NOT NULL DEFAULT 'none',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ,
  revoked_by    TEXT,
  UNIQUE (guild_id, case_number)
);
CREATE INDEX IF NOT EXISTS moderation_cases_user_idx ON moderation_cases (guild_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS moderation_cases_mod_idx ON moderation_cases (guild_id, moderator_id, created_at DESC);
CREATE INDEX IF NOT EXISTS moderation_cases_action_idx ON moderation_cases (guild_id, action, created_at DESC);

CREATE TABLE IF NOT EXISTS warnings (
  id           BIGSERIAL PRIMARY KEY,
  guild_id     TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  case_id      BIGINT REFERENCES moderation_cases(id) ON DELETE SET NULL,
  user_id      TEXT NOT NULL,
  moderator_id TEXT NOT NULL,
  reason       TEXT NOT NULL,
  weight       INTEGER NOT NULL DEFAULT 1,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS warnings_user_idx ON warnings (guild_id, user_id, active, created_at DESC);

CREATE TABLE IF NOT EXISTS moderation_appeals (
  id          BIGSERIAL PRIMARY KEY,
  guild_id    TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  case_id     BIGINT REFERENCES moderation_cases(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  message     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS moderation_appeals_status_idx ON moderation_appeals (guild_id, status, created_at DESC);

-- ------------------------------------------------------------------ security

CREATE TABLE IF NOT EXISTS security_events (
  id          BIGSERIAL PRIMARY KEY,
  guild_id    TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  severity    SMALLINT NOT NULL DEFAULT 1,
  actor_id    TEXT,
  target_id   TEXT,
  description TEXT NOT NULL,
  metadata    JSONB,
  handled     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS security_events_guild_idx ON security_events (guild_id, created_at DESC);
CREATE INDEX IF NOT EXISTS security_events_kind_idx ON security_events (guild_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS security_events_severity_idx ON security_events (guild_id, severity, created_at DESC);

CREATE TABLE IF NOT EXISTS trusted_entities (
  id          BIGSERIAL PRIMARY KEY,
  guild_id    TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('user', 'role', 'channel')),
  entity_id   TEXT NOT NULL,
  note        TEXT,
  added_by    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (guild_id, entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS automod_violations (
  id           BIGSERIAL PRIMARY KEY,
  guild_id     TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL,
  channel_id   TEXT,
  message_id   TEXT,
  kinds        TEXT[] NOT NULL DEFAULT '{}',
  details      JSONB,
  action_taken TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS automod_violations_user_idx
  ON automod_violations (guild_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notag_violations (
  id                 BIGSERIAL PRIMARY KEY,
  guild_id           TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id            TEXT NOT NULL,
  channel_id         TEXT,
  message_id         TEXT,
  protected_user_ids TEXT[] NOT NULL DEFAULT '{}',
  action             TEXT NOT NULL DEFAULT 'log',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notag_violations_idx ON notag_violations (guild_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS nopin_events (
  id                BIGSERIAL PRIMARY KEY,
  guild_id          TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id        TEXT NOT NULL,
  message_id        TEXT,
  action            TEXT NOT NULL,
  actor_id          TEXT,
  message_author_id TEXT,
  outcome           TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nopin_events_idx ON nopin_events (guild_id, created_at DESC);

-- ------------------------------------------------------------------- tickets

CREATE TABLE IF NOT EXISTS tickets (
  id               BIGSERIAL PRIMARY KEY,
  guild_id         TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  ticket_number    INTEGER NOT NULL,
  channel_id       TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  category_key     TEXT NOT NULL DEFAULT 'general',
  subject          TEXT,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'claimed', 'closed')),
  priority         TEXT NOT NULL DEFAULT 'normal',
  claimed_by       TEXT,
  closed_by        TEXT,
  close_reason     TEXT,
  transcript       JSONB,
  rating           SMALLINT,
  rating_comment   TEXT,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at        TIMESTAMPTZ,
  UNIQUE (guild_id, ticket_number)
);
CREATE INDEX IF NOT EXISTS tickets_status_idx ON tickets (guild_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS tickets_user_idx ON tickets (guild_id, user_id, status);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id         BIGSERIAL PRIMARY KEY,
  ticket_id  BIGINT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_id  TEXT NOT NULL,
  author_tag TEXT,
  content    TEXT,
  attachments JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ticket_messages_ticket_idx ON ticket_messages (ticket_id, created_at);

-- ----------------------------------------------------------- custom commands

CREATE TABLE IF NOT EXISTS custom_commands (
  id          BIGSERIAL PRIMARY KEY,
  scope       TEXT NOT NULL CHECK (scope IN ('global', 'guild')),
  guild_id    TEXT REFERENCES guilds(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  published   BOOLEAN NOT NULL DEFAULT FALSE,
  uses        BIGINT NOT NULL DEFAULT 0,
  created_by  TEXT,
  updated_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((scope = 'global' AND guild_id IS NULL) OR (scope = 'guild' AND guild_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS custom_commands_global_name_idx
  ON custom_commands (lower(name)) WHERE scope = 'global';
CREATE UNIQUE INDEX IF NOT EXISTS custom_commands_guild_name_idx
  ON custom_commands (guild_id, lower(name)) WHERE scope = 'guild';

-- ------------------------------------------------------------------- economy

CREATE TABLE IF NOT EXISTS economy_accounts (
  guild_id     TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL,
  wallet       BIGINT NOT NULL DEFAULT 0 CHECK (wallet >= 0),
  bank         BIGINT NOT NULL DEFAULT 0 CHECK (bank >= 0),
  total_earned BIGINT NOT NULL DEFAULT 0,
  total_spent  BIGINT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS economy_accounts_wallet_idx ON economy_accounts (guild_id, wallet DESC);

CREATE TABLE IF NOT EXISTS economy_transactions (
  id              BIGSERIAL PRIMARY KEY,
  guild_id        TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL,
  counterparty_id TEXT,
  actor_id        TEXT,
  type            TEXT NOT NULL,
  amount          BIGINT NOT NULL,
  fee             BIGINT NOT NULL DEFAULT 0,
  balance_after   BIGINT,
  idempotency_key TEXT,
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS economy_transactions_idem_idx
  ON economy_transactions (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS economy_transactions_user_idx
  ON economy_transactions (guild_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS economy_cooldowns (
  guild_id     TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL,
  action       TEXT NOT NULL,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  streak       INTEGER NOT NULL DEFAULT 0,
  uses         BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id, action)
);

CREATE TABLE IF NOT EXISTS shop_items (
  id          BIGSERIAL PRIMARY KEY,
  guild_id    TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  price       BIGINT NOT NULL CHECK (price >= 0),
  role_id     TEXT,
  stock       INTEGER,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- PostgreSQL does not allow expressions inside a table-level UNIQUE constraint,
-- so case-insensitive uniqueness is enforced with a unique index. This is also
-- what `INSERT ... ON CONFLICT (guild_id, lower(name))` requires.
CREATE UNIQUE INDEX IF NOT EXISTS shop_items_guild_name_idx
  ON shop_items (guild_id, lower(name));

CREATE TABLE IF NOT EXISTS inventory (
  id          BIGSERIAL PRIMARY KEY,
  guild_id    TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  item_id     BIGINT NOT NULL REFERENCES shop_items(id) ON DELETE CASCADE,
  quantity    INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (guild_id, user_id, item_id)
);

CREATE TABLE IF NOT EXISTS achievements (
  id          BIGSERIAL PRIMARY KEY,
  guild_id    TEXT REFERENCES guilds(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  requirement JSONB,
  reward      BIGINT NOT NULL DEFAULT 0,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (guild_id, key)
);

CREATE TABLE IF NOT EXISTS user_achievements (
  guild_id       TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL,
  achievement_id BIGINT NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
  progress       BIGINT NOT NULL DEFAULT 0,
  completed_at   TIMESTAMPTZ,
  PRIMARY KEY (guild_id, user_id, achievement_id)
);

-- ------------------------------------------------------------------ levels

CREATE TABLE IF NOT EXISTS member_levels (
  guild_id      TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL,
  xp            BIGINT NOT NULL DEFAULT 0 CHECK (xp >= 0),
  level         INTEGER NOT NULL DEFAULT 0 CHECK (level >= 0),
  messages      BIGINT NOT NULL DEFAULT 0,
  voice_minutes BIGINT NOT NULL DEFAULT 0,
  daily_xp      BIGINT NOT NULL DEFAULT 0,
  last_xp_at    TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS member_levels_xp_idx ON member_levels (guild_id, xp DESC);

-- --------------------------------------------------------------- community

CREATE TABLE IF NOT EXISTS giveaways (
  id               BIGSERIAL PRIMARY KEY,
  guild_id         TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id       TEXT NOT NULL,
  message_id       TEXT,
  host_id          TEXT NOT NULL,
  prize            TEXT NOT NULL,
  winners_count    INTEGER NOT NULL DEFAULT 1,
  required_role_id TEXT,
  bonus_role_ids   TEXT[] NOT NULL DEFAULT '{}',
  winner_ids       TEXT[] NOT NULL DEFAULT '{}',
  ends_at          TIMESTAMPTZ NOT NULL,
  ended            BOOLEAN NOT NULL DEFAULT FALSE,
  cancelled        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS giveaways_active_idx ON giveaways (ended, ends_at);
CREATE INDEX IF NOT EXISTS giveaways_guild_idx ON giveaways (guild_id, created_at DESC);

CREATE TABLE IF NOT EXISTS giveaway_entries (
  giveaway_id BIGINT NOT NULL REFERENCES giveaways(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  weight      INTEGER NOT NULL DEFAULT 1,
  entries     INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (giveaway_id, user_id)
);

CREATE TABLE IF NOT EXISTS suggestions (
  id            BIGSERIAL PRIMARY KEY,
  guild_id      TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id    TEXT NOT NULL,
  message_id    TEXT,
  thread_id     TEXT,
  user_id       TEXT NOT NULL,
  content       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',
  staff_response TEXT,
  upvotes       INTEGER NOT NULL DEFAULT 0,
  downvotes     INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS suggestions_guild_idx ON suggestions (guild_id, created_at DESC);

CREATE TABLE IF NOT EXISTS suggestion_votes (
  suggestion_id BIGINT NOT NULL REFERENCES suggestions(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL,
  vote          SMALLINT NOT NULL CHECK (vote IN (-1, 1)),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (suggestion_id, user_id)
);

CREATE TABLE IF NOT EXISTS reaction_role_panels (
  id         BIGSERIAL PRIMARY KEY,
  guild_id   TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  panel_key  TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  mode       TEXT NOT NULL DEFAULT 'button' CHECK (mode IN ('reaction', 'button', 'select')),
  options    JSONB NOT NULL DEFAULT '[]'::jsonb,
  exclusive  BOOLEAN NOT NULL DEFAULT FALSE,
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (guild_id, panel_key)
);
CREATE INDEX IF NOT EXISTS reaction_role_panels_message_idx ON reaction_role_panels (message_id);

CREATE TABLE IF NOT EXISTS starboard_entries (
  id                  BIGSERIAL PRIMARY KEY,
  guild_id            TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  source_message_id   TEXT NOT NULL,
  source_channel_id   TEXT NOT NULL,
  starboard_message_id TEXT,
  starboard_channel_id TEXT NOT NULL,
  star_count          INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (guild_id, source_message_id)
);

CREATE TABLE IF NOT EXISTS birthdays (
  guild_id            TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id             TEXT NOT NULL,
  month               SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
  day                 SMALLINT NOT NULL CHECK (day BETWEEN 1 AND 31),
  year                SMALLINT,
  last_announced_year INTEGER,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS birthdays_date_idx ON birthdays (month, day);

CREATE TABLE IF NOT EXISTS reminders (
  id          BIGSERIAL PRIMARY KEY,
  guild_id    TEXT REFERENCES guilds(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  channel_id  TEXT NOT NULL,
  content     TEXT NOT NULL,
  remind_at   TIMESTAMPTZ NOT NULL,
  delivered_at TIMESTAMPTZ,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders (status, remind_at);

-- ------------------------------------------------------- automation + audit

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id         BIGSERIAL PRIMARY KEY,
  guild_id   TEXT REFERENCES guilds(id) ON DELETE CASCADE,
  task_type  TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  run_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  locked_at  TIMESTAMPTZ,
  locked_by  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scheduled_tasks_due_idx ON scheduled_tasks (status, run_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  guild_id    TEXT,
  actor_id    TEXT,
  actor_type  TEXT NOT NULL DEFAULT 'user',
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  metadata    JSONB,
  ip_hash     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_guild_idx ON audit_logs (guild_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_actor_idx ON audit_logs (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON audit_logs (action, created_at DESC);

CREATE TABLE IF NOT EXISTS command_usage (
  id           BIGSERIAL PRIMARY KEY,
  guild_id     TEXT,
  user_id      TEXT,
  command_name TEXT NOT NULL,
  success      BOOLEAN NOT NULL DEFAULT TRUE,
  error_code   TEXT,
  duration_ms  INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS command_usage_guild_idx ON command_usage (guild_id, created_at DESC);
CREATE INDEX IF NOT EXISTS command_usage_name_idx ON command_usage (command_name, created_at DESC);

CREATE TABLE IF NOT EXISTS dashboard_sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  user_agent   TEXT,
  ip_hash      TEXT
);
CREATE INDEX IF NOT EXISTS dashboard_sessions_user_idx ON dashboard_sessions (user_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS dashboard_sessions_expiry_idx ON dashboard_sessions (expires_at);

CREATE TABLE IF NOT EXISTS bot_instances (
  id               TEXT PRIMARY KEY,
  shard_id         INTEGER,
  status           TEXT NOT NULL DEFAULT 'starting',
  guild_count      INTEGER NOT NULL DEFAULT 0,
  user_count       BIGINT NOT NULL DEFAULT 0,
  command_count    INTEGER NOT NULL DEFAULT 0,
  ws_ping_ms       INTEGER,
  uptime_seconds   BIGINT NOT NULL DEFAULT 0,
  memory_mb        INTEGER,
  version          TEXT,
  node_version     TEXT,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
