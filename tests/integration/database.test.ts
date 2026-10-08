/**
 * Integration tests against a REAL PostgreSQL database.
 *
 * They are skipped (not faked) unless TEST_DATABASE_URL is set, because the
 * sandbox used to develop this project has no PostgreSQL server. CI sets the
 * variable with a Postgres service container, which is where these run.
 *
 *   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/bot_test npm test
 *
 * The suite owns the database it is pointed at: it runs migrations, exercises the
 * repositories, then truncates the tables it touched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  createRepositories,
  migrationStatus,
  runMigrations,
  type Database,
  type Repositories,
} from '@bot-by-ai/database';

const TEST_URL = process.env.TEST_DATABASE_URL;

const suite = TEST_URL ? describe : describe.skip;

suite('postgres integration', () => {
  let db: Database;
  let repos: Repositories;

  const guildId = '999000000000000001';
  const userId = '999000000000000002';

  beforeAll(async () => {
    db = createDatabase({ url: TEST_URL as string, max: 4, applicationName: 'bot-by-ai-test' });
    const health = await db.health();
    if (!health.ok) throw new Error(`TEST_DATABASE_URL is not reachable: ${health.error}`);
    await runMigrations(db, { dir: process.env.MIGRATIONS_DIR });
    repos = createRepositories(db);
    await db.query(
      'TRUNCATE economy_accounts, economy_transactions, moderation_cases, warnings, dashboard_sessions, custom_commands, guilds, users CASCADE',
    );
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await db
      .query(
        'TRUNCATE economy_accounts, economy_transactions, moderation_cases, warnings, dashboard_sessions, custom_commands, guilds, users CASCADE',
      )
      .catch(() => undefined);
    await db.close();
  });

  it('applies every migration and is idempotent', async () => {
    const second = await runMigrations(db, { dir: process.env.MIGRATIONS_DIR });
    expect(second.applied).toEqual([]);
    expect(second.drift).toEqual([]);

    const status = await migrationStatus(db, process.env.MIGRATIONS_DIR);
    expect(status.pending).toEqual([]);
    expect(status.applied.length).toBeGreaterThanOrEqual(2);
  });

  it('creates the documented tables', async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const tables = new Set(rows.map((row) => row.table_name));
    for (const table of [
      'users',
      'guilds',
      'guild_settings',
      'guild_settings_history',
      'moderation_cases',
      'warnings',
      'security_events',
      'notag_violations',
      'nopin_events',
      'tickets',
      'custom_commands',
      'economy_accounts',
      'economy_transactions',
      'member_levels',
      'giveaways',
      'suggestions',
      'scheduled_tasks',
      'audit_logs',
      'command_usage',
      'dashboard_sessions',
      'bot_instances',
    ]) {
      expect(tables.has(table), `expected table ${table}`).toBe(true);
    }
  });

  it('keeps economy transactions atomic, idempotent and never negative', async () => {
    await repos.users.upsertUser({ id: userId, username: 'test-user' });
    await repos.guilds.ensureGuild({ id: guildId, name: 'Test Guild', ownerId: userId });

    const key = `test-credit-${guildId}-${userId}`;
    const credited = await repos.economy.adjustBalance({
      guildId,
      userId,
      amount: 500,
      type: 'admin_adjust',
      actorId: userId,
      idempotencyKey: key,
    });
    expect(credited.balance).toBe(500);
    expect(credited.replayed).toBe(false);

    const account = await repos.economy.getAccount(guildId, userId);
    expect(account?.wallet).toBe(500);

    // An overdraft must fail and leave the balance untouched.
    await expect(
      repos.economy.adjustBalance({
        guildId,
        userId,
        amount: -1_000,
        type: 'admin_adjust',
        actorId: userId,
        idempotencyKey: `test-overdraft-${guildId}-${userId}`,
      }),
    ).rejects.toThrow();
    expect((await repos.economy.getAccount(guildId, userId))?.wallet).toBe(500);

    // Replaying the same idempotency key must not credit twice.
    const replay = await repos.economy.adjustBalance({
      guildId,
      userId,
      amount: 500,
      type: 'admin_adjust',
      actorId: userId,
      idempotencyKey: key,
    });
    expect(replay.replayed).toBe(true);
    expect((await repos.economy.getAccount(guildId, userId))?.wallet).toBe(500);
  });

  it('moves money between two accounts with a burned fee', async () => {
    const recipient = '999000000000000003';
    await repos.users.upsertUser({ id: recipient, username: 'recipient' });
    await repos.economy.adjustBalance({
      guildId,
      userId,
      amount: 1_000,
      type: 'admin_adjust',
      actorId: userId,
    });

    const transfer = await repos.economy.transfer({
      guildId,
      fromUserId: userId,
      toUserId: recipient,
      amount: 200,
      feePercent: 5,
      idempotencyKey: `test-transfer-${guildId}-${userId}-${recipient}`,
    });
    expect(transfer.fee).toBe(10);
    expect(transfer.amount).toBe(200);
    // sender paid amount + fee, recipient received exactly the amount
    expect(transfer.senderWallet).toBe(500 + 1_000 - 210);
    expect(transfer.recipientWallet).toBe(200);
  });

  it('numbers moderation cases per guild without gaps or duplicates', async () => {
    const first = await repos.moderation.createCase({
      guildId,
      userId,
      moderatorId: userId,
      action: 'warn',
      reason: 'first',
    });
    const second = await repos.moderation.createCase({
      guildId,
      userId,
      moderatorId: userId,
      action: 'warn',
      reason: 'second',
    });
    expect(second.case_number).toBe(first.case_number + 1);

    const fetched = await repos.moderation.getCase(guildId, first.case_number);
    expect(fetched?.user_id).toBe(userId);
    expect(fetched?.action).toBe('warn');
  });

  it('stores dashboard sessions in a revocable, hashed form', async () => {
    const created = await repos.sessions.create({
      userId,
      tokenHash: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 3_600_000),
      username: 'test-user',
      globalName: 'Test User',
      userGuildIds: [guildId],
    });
    expect(created).toBeTruthy();

    const found = await repos.sessions.findActiveByTokenHash('a'.repeat(64));
    expect(found?.user_id).toBe(userId);
    expect(found?.user_guild_ids).toEqual([guildId]);

    expect(await repos.sessions.countActive()).toBeGreaterThanOrEqual(1);
    expect(await repos.sessions.revokeByTokenHash('a'.repeat(64))).toBe(true);
    expect(await repos.sessions.findActiveByTokenHash('a'.repeat(64))).toBeNull();
  });

  it('isolates guild custom commands from global ones', async () => {
    await repos.customCommands.upsertGlobal({
      name: 'global-ping',
      description: 'global test command',
      payload: { name: 'global-ping', description: 'global test command', response: 'pong' },
      published: true,
      ownerId: userId,
    });
    await repos.customCommands.upsertGuild(guildId, {
      name: 'local-ping',
      description: 'guild test command',
      payload: { name: 'local-ping', description: 'guild test command', response: 'local pong' },
      actorId: userId,
    });

    expect(
      (await repos.customCommands.listGlobal()).some((row) => row.name === 'global-ping'),
    ).toBe(true);
    expect(
      (await repos.customCommands.listGuild(guildId)).some((row) => row.name === 'local-ping'),
    ).toBe(true);
    expect(await repos.customCommands.getGuild(guildId, 'global-ping')).toBeNull();
    expect(await repos.customCommands.getGlobalPublished('global-ping')).not.toBeNull();

    await repos.customCommands.setGlobalPublished('global-ping', false, userId);
    expect(await repos.customCommands.getGlobalPublished('global-ping')).toBeNull();

    expect(await repos.customCommands.deleteGuild(guildId, 'local-ping')).toBe(true);
    expect(await repos.customCommands.deleteGlobal('global-ping')).toBe(true);
  });
});
