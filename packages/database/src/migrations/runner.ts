import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { Database } from '../pool.js';

const here = dirname(fileURLToPath(import.meta.url));

/** repo root = 4 levels up from packages/database/{src|dist}/migrations */
export function resolveMigrationsDir(explicit?: string): string {
  if (explicit) return resolve(explicit);
  if (process.env.MIGRATIONS_DIR) return resolve(process.env.MIGRATIONS_DIR);
  return resolve(here, '../../../..', 'database/migrations');
}

export interface MigrationFile {
  id: string;
  name: string;
  path: string;
  sql: string;
  checksum: string;
}

export async function loadMigrations(dir?: string): Promise<MigrationFile[]> {
  const directory = resolveMigrationsDir(dir);
  const entries = await readdir(directory).catch(() => [] as string[]);
  const files = entries.filter((file) => file.endsWith('.sql')).sort();
  const migrations: MigrationFile[] = [];
  for (const file of files) {
    const path = join(directory, file);
    const sql = await readFile(path, 'utf8');
    migrations.push({
      id: file.replace(/\.sql$/, '').split('_')[0] as string,
      name: file,
      path,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  return migrations;
}

export interface AppliedMigration {
  id: string;
  name: string;
  checksum: string;
  applied_at: Date;
}

async function ensureMigrationsTable(db: Database): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      execution_ms integer NOT NULL DEFAULT 0
    )
  `);
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
  drift: { name: string; expected: string; actual: string }[];
}

/**
 * Applies pending migrations inside a transaction per file. Already-applied
 * migrations whose checksum changed are reported as drift instead of silently
 * rewriting the database.
 */
export async function runMigrations(
  db: Database,
  options: { dir?: string; log?: (message: string) => void } = {},
): Promise<MigrateResult> {
  const log = options.log ?? (() => {});
  await ensureMigrationsTable(db);
  const migrations = await loadMigrations(options.dir);
  const { rows } = await db.query<AppliedMigration>(
    'SELECT id, name, checksum, applied_at FROM schema_migrations ORDER BY id',
  );
  const appliedById = new Map(rows.map((row) => [row.id, row]));

  const result: MigrateResult = { applied: [], skipped: [], drift: [] };
  const lock = await db.pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [982_451_653]);
    for (const migration of migrations) {
      const existing = appliedById.get(migration.id);
      if (existing) {
        if (existing.checksum !== migration.checksum) {
          result.drift.push({
            name: migration.name,
            expected: existing.checksum,
            actual: migration.checksum,
          });
        }
        result.skipped.push(migration.name);
        continue;
      }
      const started = Date.now();
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO schema_migrations (id, name, checksum, execution_ms) VALUES ($1, $2, $3, $4)',
          [migration.id, migration.name, migration.checksum, Date.now() - started],
        );
        await client.query('COMMIT');
        result.applied.push(migration.name);
        log(`applied ${migration.name} (${Date.now() - started}ms)`);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(
          `migration ${migration.name} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        client.release();
      }
    }
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1)', [982_451_653]).catch(() => {});
    lock.release();
  }
  return result;
}

export async function migrationStatus(
  db: Database,
  dir?: string,
): Promise<{ pending: string[]; applied: AppliedMigration[] }> {
  await ensureMigrationsTable(db);
  const migrations = await loadMigrations(dir);
  const { rows } = await db.query<AppliedMigration>(
    'SELECT id, name, checksum, applied_at FROM schema_migrations ORDER BY id',
  );
  const appliedIds = new Set(rows.map((row) => row.id));
  return {
    pending: migrations.filter((m) => !appliedIds.has(m.id)).map((m) => m.name),
    applied: rows,
  };
}
