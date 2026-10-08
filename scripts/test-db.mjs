#!/usr/bin/env node
/**
 * Runs the PostgreSQL integration suite without a PostgreSQL installation.
 *
 * PGlite is PostgreSQL compiled to WebAssembly; this script exposes it over the
 * real wire protocol on a loopback port, points TEST_DATABASE_URL at it and runs
 * vitest, then shuts the server down. It is a convenience for contributors and
 * for sandboxes where Docker/Postgres is unavailable — CI uses a proper
 * postgres:16 service container instead (see .github/workflows/ci.yml).
 *
 *   npm run test:db
 *
 * Limitations of the WASM engine (documented, not hidden): it is a single-user
 * server, so it is unsuitable for load testing or replication behaviour.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** Ask the OS for a free loopback port so parallel runs never collide. */
async function freePort() {
  if (process.env.PGLITE_PORT) return Number(process.env.PGLITE_PORT);
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const chosen = typeof address === 'object' && address ? address.port : 54329;
      probe.close(() => resolve(chosen));
    });
  });
}

const port = await freePort();
const dataDir = process.env.PGLITE_DIR ?? join(tmpdir(), `bot-by-ai-pglite-${process.pid}`);

const serverEntry = resolvePath(
  repoRoot,
  'node_modules/@electric-sql/pglite-socket/dist/scripts/server.js',
);

const server = spawn(
  process.execPath,
  [serverEntry, `--db=${dataDir}`, `--port=${port}`, '--host=127.0.0.1', '--max-connections=8'],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);

let ready = false;
await new Promise((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error('PGlite server did not start within 30s')),
    30_000,
  );
  const onData = (chunk) => {
    const text = String(chunk);
    if (text.includes('listening on')) {
      ready = true;
      clearTimeout(timer);
      resolve();
    }
  };
  server.stdout.on('data', onData);
  server.stderr.on('data', onData);
  server.on('exit', (code) => {
    if (!ready) {
      clearTimeout(timer);
      reject(new Error(`PGlite server exited early with code ${code}`));
    }
  });
});

console.log(`PGlite listening on 127.0.0.1:${port} (data: ${dataDir})`);

const vitest = spawn(
  process.execPath,
  [resolvePath(repoRoot, 'node_modules/vitest/vitest.mjs'), 'run', 'tests/integration'],
  {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      TEST_DATABASE_URL: `postgres://postgres@127.0.0.1:${port}/postgres`,
      MIGRATIONS_DIR: resolvePath(repoRoot, 'database/migrations'),
    },
  },
);

const exitCode = await new Promise((resolve) => vitest.on('exit', (code) => resolve(code ?? 1)));

server.kill('SIGTERM');
await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
process.exit(exitCode);
