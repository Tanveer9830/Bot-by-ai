import pg from 'pg';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

const { Pool: PgPool, types } = pg;

// Return BIGINT (int8) as JS number when safe — economy values stay below 2^53.
types.setTypeParser(20, (value: string) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
});
// NUMERIC -> number keeps balance arithmetic consistent in application code.
types.setTypeParser(1700, (value: string) => Number(value));

export interface DatabaseOptions {
  url: string;
  ssl?: boolean;
  max?: number;
  applicationName?: string;
  /** Connection + statement timeouts in ms. */
  connectionTimeoutMs?: number;
  statementTimeoutMs?: number;
}

/** Anything that can run a parameterised query: the pool wrapper or a transaction client. */
export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>>;
}

export interface Database {
  pool: Pool;
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>>;
  /** Run `fn` inside a transaction; rolls back on throw, always releases the client. */
  transaction<T>(
    fn: (client: PoolClient) => Promise<T>,
    options?: { isolation?: string },
  ): Promise<T>;
  health(): Promise<{
    ok: boolean;
    latencyMs: number;
    error?: string;
    poolTotal: number;
    poolIdle: number;
    poolWaiting: number;
  }>;
  close(): Promise<void>;
}

export function createDatabase(options: DatabaseOptions): Database {
  const pool = new PgPool({
    connectionString: options.url,
    max: options.max ?? 10,
    ssl: options.ssl ? { rejectUnauthorized: false } : undefined,
    application_name: options.applicationName ?? 'bot-by-ai',
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 10_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: options.statementTimeoutMs ?? 15_000,
    query_timeout: options.statementTimeoutMs ?? 15_000,
  });

  // Transient network failures must not crash the process (pg emits 'error').
  pool.on('error', () => {
    /* surfaced through health() + the caller's own logging */
  });

  return {
    pool,
    query: (text, params) => pool.query(text, params as unknown[] | undefined),
    async transaction(fn, opts) {
      const client = await pool.connect();
      try {
        await client.query(opts?.isolation ? `BEGIN ISOLATION LEVEL ${opts.isolation}` : 'BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* connection may already be dead; the pool will discard it */
        }
        throw error;
      } finally {
        client.release();
      }
    },
    async health() {
      const started = Date.now();
      try {
        await pool.query('SELECT 1');
        return {
          ok: true,
          latencyMs: Date.now() - started,
          poolTotal: pool.totalCount,
          poolIdle: pool.idleCount,
          poolWaiting: pool.waitingCount,
        };
      } catch (error) {
        return {
          ok: false,
          latencyMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
          poolTotal: pool.totalCount,
          poolIdle: pool.idleCount,
          poolWaiting: pool.waitingCount,
        };
      }
    },
    async close() {
      await pool.end();
    },
  };
}

/** Retry helper for transient database failures (connection resets, deadlocks). */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const base = options.baseDelayMs ?? 100;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const code = (error as { code?: string }).code;
      const retryable =
        code === undefined ||
        ['40001', '40P01', '08000', '08003', '08006', '57P03', 'ECONNRESET', 'ETIMEDOUT'].includes(
          code,
        );
      if (!retryable || attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, base * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}
