import type { AppConfig } from '../config/env.js';
import { SECRET_ENV_KEYS } from '../config/env.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogContext {
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  child(bindings: LogContext): Logger;
}

const REDACT_KEYS = new Set(
  [
    ...SECRET_ENV_KEYS.map((key) => key.toLowerCase()),
    'token',
    'password',
    'authorization',
    'apikey',
    'api_key',
    'access_token',
    'refresh_token',
    'cookie',
    'clientsecret',
    'client_secret',
    'sessionsecret',
  ].map((key) => key.replace(/[^a-z_]/g, '')),
);

/** Values that must be scrubbed even when they appear inside free-form strings. */
function collectSecretValues(): string[] {
  const values: string[] = [];
  for (const key of SECRET_ENV_KEYS) {
    const value = process.env[key];
    if (value && value.length >= 8) values.push(value);
  }
  // Also catch credentials embedded in DATABASE_URL style connection strings.
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    const match = /:\/\/([^:/@]+):([^@]+)@/.exec(dbUrl);
    if (match?.[2] && match[2].length >= 4) values.push(match[2]);
  }
  return values;
}

const SECRET_VALUES = collectSecretValues();

export function redactString(input: string): string {
  let output = input;
  for (const secret of SECRET_VALUES) {
    if (secret && output.includes(secret)) {
      output = output.split(secret).join('[redacted]');
    }
  }
  // Generic Discord bot token / bearer token shapes.
  output = output.replace(/\b[\w-]{20,}\.[\w-]{5,}\.[\w-]{20,}\b/g, '[redacted-token]');
  output = output.replace(/(Bearer\s+)[A-Za-z0-9._-]{10,}/gi, '$1[redacted]');
  const escaped = output.replace(
    /[\u0000-\u001f\u007f]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return escaped;
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 6) return '[depth-limit]';
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: redactString(value.stack ?? ''),
    };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactValue(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const normalized = key.toLowerCase().replace(/[^a-z_]/g, '');
      if (REDACT_KEYS.has(normalized)) {
        out[key] = '[redacted]';
        continue;
      }
      out[key] = redactValue(item, depth + 1);
    }
    return out;
  }
  return '[unserializable]';
}

export interface LoggerOptions {
  level?: LogLevel;
  bindings?: LogContext;
  /** Pretty, human readable line output (development) vs single-line JSON (production). */
  pretty?: boolean;
  sink?: (line: string) => void;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const pretty = options.pretty ?? false;
  const bindings = options.bindings ?? {};
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));

  const write = (logLevel: LogLevel, message: string, context?: LogContext) => {
    if (LEVEL_ORDER[logLevel] < LEVEL_ORDER[level]) return;
    const payload = {
      time: new Date().toISOString(),
      level: logLevel,
      msg: redactString(message),
      ...(redactValue({ ...bindings, ...context }) as Record<string, unknown>),
    };
    if (pretty) {
      const {
        time,
        level: lvl,
        msg,
        ...rest
      } = payload as Record<string, unknown> & {
        time: string;
        level: string;
        msg: string;
      };
      const extras = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
      sink(`${time} ${lvl.toUpperCase().padEnd(5)} ${msg}${extras}`);
      return;
    }
    sink(JSON.stringify(payload));
  };

  return {
    debug: (message, context) => write('debug', message, context),
    info: (message, context) => write('info', message, context),
    warn: (message, context) => write('warn', message, context),
    error: (message, context) => write('error', message, context),
    child: (childBindings) =>
      createLogger({ level, pretty, sink, bindings: { ...bindings, ...childBindings } }),
  };
}

export function loggerFromConfig(config: Pick<AppConfig, 'logLevel' | 'isProduction'>): Logger {
  return createLogger({ level: config.logLevel, pretty: !config.isProduction });
}

/**
 * Error-rate limiter: prevents the classic "same error logged in a hot loop"
 * failure mode by collapsing repeats into a periodic summary.
 */
export class ErrorRateLimiter {
  private readonly seen = new Map<string, { count: number; first: number; lastLogged: number }>();

  constructor(
    private readonly windowMs = 60_000,
    private readonly maxPerWindow = 3,
  ) {}

  shouldLog(key: string, now = Date.now()): { log: boolean; suppressed: number } {
    const entry = this.seen.get(key);
    if (!entry || now - entry.first > this.windowMs) {
      this.seen.set(key, { count: 1, first: now, lastLogged: now });
      return { log: true, suppressed: 0 };
    }
    entry.count += 1;
    if (entry.count <= this.maxPerWindow) {
      entry.lastLogged = now;
      return { log: true, suppressed: 0 };
    }
    if (now - entry.lastLogged > this.windowMs / 2) {
      const suppressed = entry.count - this.maxPerWindow;
      entry.lastLogged = now;
      return { log: true, suppressed };
    }
    return { log: false, suppressed: 0 };
  }

  reset(): void {
    this.seen.clear();
  }
}
