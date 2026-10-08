#!/usr/bin/env node
/**
 * Migration CLI: `npm run migrate` (up), `npm run migrate:status`.
 * Reads DATABASE_URL; never prints the connection string.
 */
import { createDatabase } from '../pool.js';
import { migrationStatus, runMigrations } from '../migrations/runner.js';

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      'DATABASE_URL is required (see .env.example). It has not been printed for safety.',
    );
    process.exit(1);
  }
  const db = createDatabase({
    url,
    ssl: ['1', 'true', 'yes'].includes(String(process.env.DATABASE_SSL ?? '').toLowerCase()),
    max: 4,
    applicationName: 'bot-by-ai-migrate',
  });

  try {
    if (command === 'status') {
      const status = await migrationStatus(db);
      console.log(`applied: ${status.applied.length}`);
      for (const row of status.applied) {
        console.log(`  ✔ ${row.name} (${row.applied_at.toISOString()})`);
      }
      console.log(`pending: ${status.pending.length}`);
      for (const name of status.pending) console.log(`  • ${name}`);
      return;
    }

    if (command === 'up') {
      const result = await runMigrations(db, { log: (message) => console.log(`  ${message}`) });
      console.log(
        `migrations: ${result.applied.length} applied, ${result.skipped.length} already up to date`,
      );
      if (result.drift.length > 0) {
        console.warn('WARNING: checksum drift detected for already-applied migrations:');
        for (const drift of result.drift) console.warn(`  ! ${drift.name}`);
      }
      return;
    }

    console.error(`unknown command "${command}" (expected "up" or "status")`);
    process.exit(1);
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(`migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
