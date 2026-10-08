/**
 * Typed, fail-fast configuration loader.
 *
 * Rules enforced here:
 *  - One single variable name per concept (never mix `BOT_TOKEN`/`DISCORD_TOKEN`).
 *  - Secret *values* are never included in error messages or logs.
 *  - Invalid owner configuration aborts startup instead of silently degrading to
 *    "no owners" (which would otherwise brick every owner-only command).
 */
import { z } from 'zod';

export const SNOWFLAKE_REGEX = /^\d{17,20}$/;

export class ConfigError extends Error {
  public readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

const booleanish = z.union([z.boolean(), z.string()]).transform((value) => {
  if (typeof value === 'boolean') return value;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', ''].includes(normalized)) return false;
  throw new Error(`cannot parse boolean from "${value}"`);
});

const snowflake = z
  .string()
  .trim()
  .regex(SNOWFLAKE_REGEX, 'must be a Discord snowflake (17-20 digits)');

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === '' ? undefined : value));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Discord application credentials
  DISCORD_TOKEN: z.string().min(20, 'discord bot token looks too short'),
  DISCORD_CLIENT_ID: snowflake,
  DISCORD_CLIENT_SECRET: optionalString,
  DISCORD_REDIRECT_URI: optionalString,

  // Bot owners (the ONLY accounts allowed to manage global custom commands)
  BOT_OWNER_IDS: z
    .string()
    .min(1, 'BOT_OWNER_IDS is required (comma separated Discord user IDs)')
    .transform((value, ctx) => {
      const ids = value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      const invalid = ids.filter((id) => !SNOWFLAKE_REGEX.test(id));
      if (ids.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must contain at least one ID' });
        return z.NEVER;
      }
      if (invalid.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `contains invalid snowflake(s): ${invalid.join(', ')}`,
        });
        return z.NEVER;
      }
      return [...new Set(ids)];
    }),

  // Persistence
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL: booleanish.default(false),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  REDIS_URL: optionalString,

  // Dashboard
  DASHBOARD_URL: optionalString,
  DASHBOARD_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  SESSION_SECRET: optionalString,
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(168),

  // Optional: development guild for fast guild-scoped command registration
  DEV_GUILD_ID: optionalString,

  // Music subsystem
  ENABLE_MUSIC: booleanish.default(false),
  LAVALINK_HOST: optionalString,
  LAVALINK_PORT: z.coerce.number().int().min(1).max(65535).default(2333),
  LAVALINK_PASSWORD: optionalString,
  LAVALINK_SECURE: booleanish.default(false),
  SPOTIFY_CLIENT_ID: optionalString,
  SPOTIFY_CLIENT_SECRET: optionalString,

  // Feature toggles used by the dashboard / owner panel
  ENABLE_DASHBOARD: booleanish.default(true),
  METRICS_ENABLED: booleanish.default(true),
});

export type RawEnv = Record<string, string | undefined>;

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  discord: {
    token: string;
    clientId: string;
    clientSecret?: string;
    redirectUri?: string;
  };
  owners: {
    ids: string[];
    primaryId: string;
  };
  database: {
    url: string;
    ssl: boolean;
    poolMax: number;
  };
  redisUrl?: string;
  dashboard: {
    url?: string;
    port: number;
    sessionSecret?: string;
    sessionTtlMs: number;
    enabled: boolean;
  };
  devGuildId?: string;
  music: {
    enabled: boolean;
    lavalink?: {
      host: string;
      port: number;
      password: string;
      secure: boolean;
    };
    spotify?: { clientId: string; clientSecret: string };
  };
  metricsEnabled: boolean;
}

/**
 * Turn a zod error into human readable, secret-free messages.
 * `path` is a variable NAME, never a value.
 */
function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.') || '(root)';
    return `${path}: ${issue.message}`;
  });
}

export function loadConfig(env: RawEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(formatIssues(parsed.error));
  }
  const data = parsed.data;
  const isProduction = data.NODE_ENV === 'production';
  const issues: string[] = [];

  // Cross-field validation: things that only matter in certain modes.
  const dashboardRequired = data.ENABLE_DASHBOARD || isProduction;
  if (dashboardRequired && !data.SESSION_SECRET) {
    issues.push('SESSION_SECRET: required when ENABLE_DASHBOARD=true or NODE_ENV=production');
  }
  if (data.SESSION_SECRET && data.SESSION_SECRET.length < 32) {
    issues.push('SESSION_SECRET: must be at least 32 characters');
  }
  if (dashboardRequired && !data.DISCORD_CLIENT_SECRET) {
    issues.push('DISCORD_CLIENT_SECRET: required for the dashboard OAuth2 flow');
  }
  if (dashboardRequired && !data.DISCORD_REDIRECT_URI) {
    issues.push('DISCORD_REDIRECT_URI: required for the dashboard OAuth2 flow');
  }
  if (data.DISCORD_REDIRECT_URI && !/^https?:\/\//.test(data.DISCORD_REDIRECT_URI)) {
    if (isProduction) {
      issues.push('DISCORD_REDIRECT_URI: must be an absolute http(s) URL in production');
    }
  }
  if (data.ENABLE_MUSIC) {
    if (!data.LAVALINK_HOST || !data.LAVALINK_PASSWORD) {
      issues.push('LAVALINK_HOST and LAVALINK_PASSWORD: required when ENABLE_MUSIC=true');
    }
  } else if (data.LAVALINK_HOST && data.LAVALINK_PASSWORD) {
    // Configured but disabled: allowed, we simply do not connect.
  }
  if (
    (data.SPOTIFY_CLIENT_ID && !data.SPOTIFY_CLIENT_SECRET) ||
    (!data.SPOTIFY_CLIENT_ID && data.SPOTIFY_CLIENT_SECRET)
  ) {
    issues.push('SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET: must be provided together');
  }

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  return Object.freeze({
    nodeEnv: data.NODE_ENV,
    isProduction,
    logLevel: data.LOG_LEVEL,
    discord: {
      token: data.DISCORD_TOKEN,
      clientId: data.DISCORD_CLIENT_ID,
      clientSecret: data.DISCORD_CLIENT_SECRET,
      redirectUri: data.DISCORD_REDIRECT_URI,
    },
    owners: {
      ids: data.BOT_OWNER_IDS,
      primaryId: data.BOT_OWNER_IDS[0] as string,
    },
    database: {
      url: data.DATABASE_URL,
      ssl: data.DATABASE_SSL,
      poolMax: data.DATABASE_POOL_MAX,
    },
    redisUrl: data.REDIS_URL,
    dashboard: {
      url: data.DASHBOARD_URL,
      port: data.DASHBOARD_PORT,
      sessionSecret: data.SESSION_SECRET,
      sessionTtlMs: data.SESSION_TTL_HOURS * 60 * 60 * 1000,
      enabled: data.ENABLE_DASHBOARD,
    },
    devGuildId: data.DEV_GUILD_ID,
    music: {
      enabled: data.ENABLE_MUSIC,
      lavalink:
        data.LAVALINK_HOST && data.LAVALINK_PASSWORD
          ? {
              host: data.LAVALINK_HOST,
              port: data.LAVALINK_PORT,
              password: data.LAVALINK_PASSWORD,
              secure: data.LAVALINK_SECURE,
            }
          : undefined,
      spotify:
        data.SPOTIFY_CLIENT_ID && data.SPOTIFY_CLIENT_SECRET
          ? { clientId: data.SPOTIFY_CLIENT_ID, clientSecret: data.SPOTIFY_CLIENT_SECRET }
          : undefined,
    },
    metricsEnabled: data.METRICS_ENABLED,
  });
}

/** Names of secrets that must never be logged. Used by the redacting logger. */
export const SECRET_ENV_KEYS = [
  'DISCORD_TOKEN',
  'DISCORD_CLIENT_SECRET',
  'SESSION_SECRET',
  'DATABASE_URL',
  'REDIS_URL',
  'LAVALINK_PASSWORD',
  'SPOTIFY_CLIENT_SECRET',
] as const;
