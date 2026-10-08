import { createServer } from 'node:http';
import process from 'node:process';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import {
  ConfigError,
  CooldownBucket,
  RateLimiter,
  createLogger,
  createOwnerRegistry,
  errorForLog,
  loadConfig,
  type AppConfig,
} from '@bot-by-ai/shared';
import { openDatabase } from '@bot-by-ai/database';
import { createBotClient } from './core/client.js';
import { CommandRegistry } from './core/registry.js';
import type { BotServices } from './core/context.js';
import { GuildSettingsService } from './services/settings.js';
import { LoggingService } from './services/logging.js';
import { ModerationService } from './services/moderation.js';
import { EconomyService } from './services/economy.js';
import { LevelsService } from './services/levels.js';
import { TicketService } from './services/tickets.js';
import { SecurityService } from './services/security.js';
import { AutomodService } from './services/automod.js';
import { CommunityService } from './services/community.js';
import { WelcomeService } from './services/welcome.js';
import { BrandingService } from './services/branding.js';
import { SchedulerService } from './services/scheduler.js';
import { StatusService } from './services/status.js';
import { MusicService } from './music/musicService.js';
import { registerEvents } from './events/index.js';
import { startHealthServer } from './healthServer.js';

const VERSION = process.env.APP_VERSION ?? '1.0.0';

async function bootstrap(): Promise<void> {
  // ---------------------------------------------------------------- config
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error('\n✖ Configuration is invalid. Fix these environment variables and restart:\n');
      for (const issue of error.issues) console.error(`   • ${issue}`);
      console.error('\nSee .env.example and docs/DEPLOYMENT.md for details.\n');
      process.exit(1);
    }
    throw error;
  }

  const logger = createLogger({ level: config.logLevel, pretty: !config.isProduction });
  const owners = createOwnerRegistry(config.owners.ids);
  logger.info('configuration loaded', {
    nodeEnv: config.nodeEnv,
    ownerCount: owners.ids.length,
    musicEnabled: config.music.enabled,
    dashboardEnabled: config.dashboard.enabled,
  });

  // ---------------------------------------------------------------- database
  const { db, repositories } = openDatabase({
    url: config.database.url,
    ssl: config.database.ssl,
    max: config.database.poolMax,
    applicationName: 'bot-by-ai',
  });

  const databaseHealth = await db.health();
  if (!databaseHealth.ok) {
    logger.error('database is unreachable — refusing to start (no insecure fallback)', {
      error: databaseHealth.error,
    });
    process.exit(1);
  }
  logger.info('database connected', { latencyMs: databaseHealth.latencyMs });

  // ---------------------------------------------------------------- services
  const client = createBotClient(config);
  const servicesRef: { current: BotServices | null } = { current: null };
  const getServices = (): BotServices => {
    if (!servicesRef.current) throw new Error('services accessed before initialisation');
    return servicesRef.current;
  };

  const settings = new GuildSettingsService(db, repositories, logger);
  const logging = new LoggingService(settings, repositories, logger);
  const moderation = new ModerationService(repositories, settings, logging, logger);
  const economy = new EconomyService(db, repositories, settings, logger);
  const levels = new LevelsService(repositories, settings, logging, logger);
  const tickets = new TicketService(repositories, settings, logging, logger);
  const security = new SecurityService(repositories, settings, logging, logger);
  const automod = new AutomodService(repositories, settings, logging, logger);
  const community = new CommunityService(repositories, settings, logging, logger);
  community.client = client;
  const welcome = new WelcomeService(settings, logging, logger);
  const branding = new BrandingService(settings, logger);
  const status = new StatusService(config, client, db, repositories, logger, VERSION);
  const scheduler = new SchedulerService(client, repositories, logger, getServices);

  let music: MusicService | null = null;
  if (config.music.enabled && config.music.lavalink) {
    try {
      music = new MusicService(config, client, settings, logger);
    } catch (error) {
      logger.error(
        'music subsystem failed to initialise; continuing without music',
        errorForLog(error),
      );
      music = null;
    }
  }

  const registry = new CommandRegistry(logger);
  const { loaded, issues } = await registry.loadFrom();
  logger.info('commands loaded', { count: loaded, validationIssues: issues.length });

  const services: BotServices = {
    config,
    client,
    db,
    repos: repositories,
    logger,
    owners,
    cooldowns: new CooldownBucket({ windowMs: 3_000, uses: 1 }),
    messageCooldowns: new Map<string, number>(),
    rateLimiter: new RateLimiter({ windowMs: 10_000, limit: 12 }),
    settings,
    logging,
    moderation,
    economy,
    levels,
    tickets,
    security,
    automod,
    community,
    welcome,
    branding,
    scheduler,
    status,
    music,
    features: {
      music: Boolean(music),
      redis: Boolean(config.redisUrl),
      dashboard: config.dashboard.enabled,
      metrics: config.metricsEnabled,
    },
    startedAt: Date.now(),
    version: VERSION,
    commandCatalog: () =>
      registry.list().map((command) => {
        const json = command.data.toJSON();
        return {
          name: json.name,
          category: command.category,
          description: json.description,
          ownerOnly: command.ownerOnly === true,
        };
      }),
  };
  servicesRef.current = services;

  registerEvents(client, registry, services);

  // ---------------------------------------------------------------- lifecycle
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    const hardExit = setTimeout(() => {
      logger.warn('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 15_000);
    hardExit.unref();
    try {
      await scheduler.stop();
      if (music) await music.disconnect().catch(() => {});
      await status.markOffline();
      client.destroy();
      await db.close();
      logger.info('shutdown complete');
    } catch (error) {
      logger.error('error during shutdown', errorForLog(error));
    } finally {
      clearTimeout(hardExit);
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    status.recordError(reason);
    logger.error('unhandled promise rejection', errorForLog(reason));
  });
  process.on('uncaughtException', (error) => {
    status.recordError(error);
    logger.error('uncaught exception', errorForLog(error));
    // Fatal: restart cleanly instead of continuing in an undefined state.
    void shutdown('uncaughtException');
  });

  // ---------------------------------------------------------------- connect
  client.once(Events.ClientReady, async (readyClient) => {
    logger.info('gateway connected', {
      user: readyClient.user.tag,
      guilds: readyClient.guilds.cache.size,
    });
    status.markReady(true);
    await scheduler.ensureRecurringTasks();
    scheduler.start();
    await status.heartbeat(registry.size);
    if (music) {
      await music.connect().catch((error) => {
        logger.error(
          'lavalink connection failed; music commands will report unavailable',
          errorForLog(error),
        );
      });
    }
  });

  if (config.metricsEnabled || !config.isProduction) {
    const healthServer = startHealthServer({
      config,
      port: Number(process.env.PORT ?? 8080),
      status,
      client,
      registrySize: () => registry.size,
      logger,
    });
    process.on('SIGTERM', () => healthServer.close());
  }

  logger.info('logging in to Discord');
  await client.login(config.discord.token);
}

bootstrap().catch((error) => {
  const logger = createLogger({ level: 'error', pretty: true });
  logger.error('fatal startup error', errorForLog(error));
  process.exit(1);
});

/** Exported for tests: ensures the client factory can be imported without login. */
export { createBotClient, GatewayIntentBits, Client };
export { createServer };
