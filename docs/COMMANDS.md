# Slash commands

Generated from the live command registry (`npm run commands:count`) — this list is
exactly what Discord receives. `🔒` marks owner-only commands; server administrator
permissions do **not** grant them.

**Total: 97 top-level commands** (Discord's global limit is 100).
Registration: `npm run deploy:commands -- --global` (or without `--global` for the
instant guild-scoped dev registration using `DEV_GUILD_ID`).

Custom commands stored in the database are merged into the same registration payload:
published global ones (`/globalcommand`) and the guild's own (`/customcommand`).

## Contents

- [utility](#utility) — 26
- [moderation](#moderation) — 21
- [security](#security) — 8
- [automod](#automod) — 1
- [economy](#economy) — 14
- [levels](#levels) — 3
- [tickets](#tickets) — 1
- [community](#community) — 5
- [music](#music) — 6
- [configuration](#configuration) — 9
- [owner](#owner) — 3

## utility

| Command        | Description                                                       |
| -------------- | ----------------------------------------------------------------- |
| `/afk`         | Mark yourself as away (mentions get an automatic reply)           |
| `/avatar`      | Show a user avatar or server icon                                 |
| `/banner`      | Show a user banner                                                |
| `/botinfo`     | Information about the bot and this deployment                     |
| `/calc`        | Evaluate a maths expression (no code execution)                   |
| `/channelinfo` | Show information about a channel                                  |
| `/dashboard`   | Get the web dashboard link and your access status                 |
| `/embed`       | Send a custom embed                                               |
| `/emojis`      | List server emojis and stickers                                   |
| `/help`        | List every command or get help for one command                    |
| `/invite`      | Get the invite link with the required permissions                 |
| `/membercount` | Show the member count breakdown                                   |
| `/permissions` | Check which permissions the bot has, and which it is missing      |
| `/ping`        | Check latency and API round-trip time                             |
| `/poll`        | Create a poll with up to 10 options                               |
| `/prefix`      | Show or change the message-command prefix used by custom commands |
| `/remind`      | Set a reminder                                                    |
| `/roleinfo`    | Show information about a role                                     |
| `/rolelist`    | List every role with its member count                             |
| `/servericon`  | Show the server icon and banner                                   |
| `/serverinfo`  | Show information about this server                                |
| `/snowflake`   | Explain a Discord id (timestamp and type)                         |
| `/status`      | Show live bot and database status                                 |
| `/timestamp`   | Generate a Discord timestamp from a date or in X time             |
| `/uptime`      | Show how long the bot process has been running                    |
| `/userinfo`    | Show account and member information for a user                    |

**Subcommands / options**

- `/afk` → options: `reason`
- `/avatar` → options: `user`, `size`
- `/banner` → options: `user`
- `/calc` → options: `expression`
- `/channelinfo` → options: `channel`
- `/embed` → options: `title`, `description`, `channel`, `color`, `footer`, `timestamp`
- `/help` → options: `command`, `category`
- `/permissions` → options: `user`
- `/poll` → options: `question`, `options`, `multiple`, `duration`, `channel`
- `/prefix` → options: `new_prefix`
- `/remind` → options: `when`, `what`, `dm`
- `/roleinfo` → options: `role`
- `/snowflake` → options: `id`
- `/timestamp` → options: `when`, `format`
- `/userinfo` → options: `user`, `ephemeral`

## moderation

| Command          | Description                                            |
| ---------------- | ------------------------------------------------------ |
| `/appeal`        | Appeal a moderation action, or review appeals as staff |
| `/ban`           | Ban a member (optionally deleting recent messages)     |
| `/bulkban`       | Ban several users at once (max 25)                     |
| `/case`          | Inspect, revoke and analyse moderation cases           |
| `/clearwarnings` | Remove every active warning for a member               |
| `/escalation`    | Configure automatic escalation for repeated warnings   |
| `/kick`          | Kick a member                                          |
| `/lock`          | Lock a channel for @everyone                           |
| `/modlog`        | Configure the moderation log channel and policy        |
| `/nickname`      | Change or reset a member nickname                      |
| `/note`          | Add an internal note to a member’s case history        |
| `/purge`         | Bulk delete messages in this channel (last 14 days)    |
| `/role`          | Give, remove, create or delete roles                   |
| `/slowmode`      | Set the slowmode for a channel                         |
| `/timeout`       | Time out a member (Discord maximum: 28 days)           |
| `/unban`         | Unban a user by id                                     |
| `/unlock`        | Unlock a locked channel                                |
| `/untimeout`     | Remove a member timeout                                |
| `/unwarn`        | Remove a single warning by id                          |
| `/warn`          | Warn a member (may trigger escalation)                 |
| `/warnings`      | List a member’s active warnings                        |

**Subcommands / options**

- `/appeal` → subcommands: `submit`, `list`, `review`
- `/ban` → options: `user`, `reason`, `delete_days`, `duration`
- `/bulkban` → options: `users`, `reason`, `delete_days`
- `/case` → subcommands: `view`, `list`, `revoke`, `stats`
- `/clearwarnings` → options: `user`
- `/escalation` → subcommands: `status`, `thresholds`
- `/kick` → options: `user`, `reason`
- `/lock` → options: `channel`, `reason`
- `/modlog` → subcommands: `status`, `set`, `disable`, `options`
- `/nickname` → options: `user`, `nickname`
- `/note` → options: `user`, `text`
- `/purge` → options: `count`, `user`, `contains`, `bots`
- `/role` → subcommands: `add`, `remove`, `create`, `delete`, `all`, `info`
- `/slowmode` → options: `duration`, `channel`
- `/timeout` → options: `user`, `duration`, `reason`
- `/unban` → options: `reason`, `user`
- `/unlock` → options: `channel`, `reason`
- `/untimeout` → options: `user`, `reason`
- `/unwarn` → options: `id`, `reason`
- `/warn` → options: `user`, `reason`
- `/warnings` → options: `user`

## security

| Command        | Description                                                    |
| -------------- | -------------------------------------------------------------- |
| `/antinuke`    | Configure anti-nuke thresholds and response                    |
| `/antiraid`    | Configure raid protection (join velocity + account age)        |
| `/antispam`    | Configure automatic flood protection                           |
| `/nopin`       | Monitor and revert unauthorised pins on protected messages     |
| `/notag`       | Protect members from unwanted mentions                         |
| `/raidmode`    | Emergency shortcuts for raids and lockdowns                    |
| `/security`    | Server security: status, lockdown, trusted entities and alerts |
| `/securitylog` | Set a dedicated channel for security alerts                    |

**Subcommands / options**

- `/antinuke` → subcommands: `status`, `thresholds`, `window`, `response`
- `/antiraid` → subcommands: `status`, `config`
- `/antispam` → subcommands: `status`, `config`
- `/nopin` → subcommands: `setup`, `protect`, `unprotect`, `status`, `exempt`, `settings`, `logs`
- `/notag` → subcommands: `setup`, `protect`, `unprotect`, `status`, `exempt`, `settings`, `logs`
- `/raidmode` → subcommands: `on`, `off`, `status`
- `/security` → subcommands: `status`, `enable`, `disable`, `lockdown`, `trusted`, `events`, `alerts`
- `/securitylog` → subcommands: `channel`, `disable`

## automod

| Command    | Description                           |
| ---------- | ------------------------------------- |
| `/automod` | Configure automatic message filtering |

**Subcommands / options**

- `/automod` → subcommands: `status`, `enable`, `disable`, `words`, `config`, `exempt`, `escalation`, `violations`, `test`, `logs`

## economy

| Command         | Description                                                            |
| --------------- | ---------------------------------------------------------------------- |
| `/achievements` | Show your achievement progress                                         |
| `/balance`      | Show your or another member’s balance                                  |
| `/bank`         | Move currency between your wallet and your bank                        |
| `/buy`          | Buy an item from the shop                                              |
| `/daily`        | Claim your daily reward (streak bonus applies)                         |
| `/econ`         | Economy administration                                                 |
| `/econfiscate`  | Confiscate currency from a member (moderator action, logged as a case) |
| `/inventory`    | Show your purchased items                                              |
| `/shop`         | Browse the server shop                                                 |
| `/shopmanage`   | Manage shop items                                                      |
| `/top`          | Leaderboards for currency and levels                                   |
| `/transfer`     | Send currency to another member                                        |
| `/weekly`       | Claim your weekly reward                                               |
| `/work`         | Work for some currency (cooldown applies)                              |

**Subcommands / options**

- `/balance` → options: `user`
- `/bank` → subcommands: `deposit`, `withdraw`
- `/buy` → options: `item`, `quantity`
- `/econ` → subcommands: `add`, `remove`, `set`, `stats`, `reset`
- `/econfiscate` → options: `target`, `amount`, `reason`
- `/shopmanage` → subcommands: `add`, `remove`, `list`
- `/top` → subcommands: `currency`, `levels`, `messages`, `voice`
- `/transfer` → options: `user`, `amount`

## levels

| Command        | Description                        |
| -------------- | ---------------------------------- |
| `/levelconfig` | Configure leveling for this server |
| `/rank`        | Show your level, XP and rank       |
| `/xp`          | Adjust member XP (administrator)   |

**Subcommands / options**

- `/levelconfig` → subcommands: `status`, `toggle`, `xp`, `announce`, `ignored`, `reward`, `roleboost`
- `/rank` → options: `user`
- `/xp` → subcommands: `add`, `remove`, `set`, `reset`

## tickets

| Command   | Description                                                       |
| --------- | ----------------------------------------------------------------- |
| `/ticket` | Ticket system: setup, panels, claim, close, transcripts and stats |

**Subcommands / options**

- `/ticket` → subcommands: `setup`, `panel`, `open`, `close`, `claim`, `reopen`, `add`, `remove`, `transcript`, `rate`, `list`, `stats`, `autoclose`, `support`

## community

| Command       | Description                                  |
| ------------- | -------------------------------------------- |
| `/birthday`   | Birthday announcements                       |
| `/giveaway`   | Create and manage giveaways                  |
| `/reminder`   | Manage your scheduled reminders              |
| `/starboard`  | Pin the best messages to a starboard channel |
| `/suggestion` | Suggestions with staff decisions             |

**Subcommands / options**

- `/birthday` → subcommands: `set`, `remove`, `list`, `setup`
- `/giveaway` → subcommands: `start`, `end`, `reroll`, `cancel`, `list`, `settings`
- `/reminder` → subcommands: `list`, `cancel`
- `/starboard` → subcommands: `setup`, `ignore`, `status`
- `/suggestion` → subcommands: `setup`, `submit`, `resolve`, `list`

## music

| Command       | Description                                          |
| ------------- | ---------------------------------------------------- |
| `/music`      | Player controls, queue management and music settings |
| `/nowplaying` | Show the track that is playing right now             |
| `/play`       | Play a track or playlist from a URL or search query  |
| `/queue`      | Show the upcoming tracks                             |
| `/skip`       | Skip the current track                               |
| `/volume`     | Set the player volume (1-200)                        |

**Subcommands / options**

- `/music` → subcommands: `join`, `leave`, `pause`, `resume`, `seek`, `loop`, `shuffle`, `remove`, `clear`, `stop`, `settings`, `dj`, `limit`
- `/play` → options: `query`
- `/queue` → options: `page`
- `/skip` → options: `amount`
- `/volume` → options: `percent`

## configuration

| Command          | Description                                                       |
| ---------------- | ----------------------------------------------------------------- |
| `/auditlog`      | Browse the audit trail the bot keeps in the database              |
| `/autorole`      | Automatic roles: join roles, bot roles and backfilling            |
| `/boost`         | Boost messages and the temporary booster role                     |
| `/config`        | View, change, export or reset this server’s settings              |
| `/customcommand` | Server-scoped custom commands (text responses, no code execution) |
| `/goodbye`       | Goodbye messages for members that leave                           |
| `/logs`          | Configure which events are logged and where                       |
| `/reactionrole`  | Self-assignable roles through buttons, select menus or reactions  |
| `/welcome`       | Welcome messages, join cards and join auto-roles                  |

**Subcommands / options**

- `/auditlog` → subcommands: `view`, `stats`, `export`
- `/autorole` → subcommands: `status`, `human`, `bot`, `sync`
- `/boost` → subcommands: `status`, `channel`, `message`, `role`, `toggle`, `test`
- `/config` → subcommands: `view`, `set`, `reset`, `history`, `export`, `import`
- `/customcommand` → subcommands: `create`, `delete`, `list`, `info`, `toggle`
- `/goodbye` → subcommands: `status`, `channel`, `message`, `toggle`, `test`
- `/logs` → subcommands: `status`, `channel`, `events`, `ignore`, `disable`
- `/reactionrole` → subcommands: `create`, `edit`, `add`, `remove`, `list`, `resend`, `delete`
- `/welcome` → subcommands: `status`, `variables`, `channel`, `message`, `dm`, `style`, `autorole`, `toggle`, `test`

## owner

| Command                | Description                                                           |
| ---------------------- | --------------------------------------------------------------------- |
| `/globalcommand` 🔒    | Owner-only: manage bot-wide custom commands available in every server |
| `/owner` 🔒            | Owner-only: runtime status, diagnostics and maintenance               |
| `/ownermaintenance` 🔒 | Owner-only: database housekeeping and audit inspection                |

**Subcommands / options**

- `/globalcommand` → subcommands: `create`, `edit`, `delete`, `list`, `info`, `publish`, `disable`
- `/owner` → subcommands: `status`, `instances`, `guilds`, `commands`, `lookup`, `cache`, `announce`
- `/ownermaintenance` → subcommands: `audit`, `prune`, `expire-cases`, `dbstats`

## Owner-only commands in detail

### `/globalcommand`

Bot-wide custom commands, stored in `custom_commands` with `scope='global'`.

| Subcommand | What it does                                                                                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create`   | Creates or fully replaces a global command (`name`, `response`, `description`, `publish`, `ephemeral`, `dm`, `cooldown`). Names that collide with built-in commands are rejected. |
| `edit`     | Updates response/description/ephemeral/dm/cooldown, keeping the published state.                                                                                                  |
| `delete`   | Two-step confirmation, then removes it everywhere.                                                                                                                                |
| `list`     | Paginated list with publish state and usage counts.                                                                                                                               |
| `info`     | Dumps the stored payload JSON plus metadata.                                                                                                                                      |
| `publish`  | Makes it respond in every server.                                                                                                                                                 |
| `disable`  | Takes it offline everywhere without deleting it.                                                                                                                                  |

Everything is validated with the shared `customCommandSchema` (zod) before it is
written; templates only substitute allow-listed variables and never execute code.

### `/owner`

`status` (live metrics + uptime + error count), `instances` (heartbeats from
`bot_instances`), `guilds` (servers with DB tracking state), `commands` (loaded
commands and validation issues), `lookup` (stored user record), `cache` (clears the
in-process settings cache), `announce` (one channel, or a confirmed broadcast to
every server's system channel, capped at 50).

### `/ownermaintenance`

`audit` (filterable audit log), `prune` (dry-run by default), `expire-cases`
(runs the punishment expiry sweep), `dbstats` (row counts for the main tables).
