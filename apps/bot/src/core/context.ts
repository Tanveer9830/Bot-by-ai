import type { Client } from 'discord.js';
import type { AppConfig, CooldownBucket, Logger, OwnerRegistry, RateLimiter } from '@bot-by-ai/shared';
import type { Database, Repositories } from '@bot-by-ai/database';
import type { GuildSettingsService } from '../services/settings.js';
import type { LoggingService } from '../services/logging.js';
import type { ModerationService } from '../services/moderation.js';
import type { EconomyService } from '../services/economy.js';
import type { LevelsService } from '../services/levels.js';
import type { TicketService } from '../services/tickets.js';
import type { SecurityService } from '../services/security.js';
import type { AutomodService } from '../services/automod.js';
import type { CommunityService } from '../services/community.js';
import type { WelcomeService } from '../services/welcome.js';
import type { BrandingService } from '../services/branding.js';
import type { SchedulerService } from '../services/scheduler.js';
import type { StatusService } from '../services/status.js';
import type { MusicService } from '../music/musicService.js';
import type { FeatureFlags } from './constants.js';

export interface BotServices {
  config: AppConfig;
  client: Client;
  db: Database;
  repos: Repositories;
  logger: Logger;
  owners: OwnerRegistry;
  cooldowns: CooldownBucket;
  messageCooldowns: Map<string, number>;
  rateLimiter: RateLimiter;
  settings: GuildSettingsService;
  logging: LoggingService;
  moderation: ModerationService;
  economy: EconomyService;
  levels: LevelsService;
  tickets: TicketService;
  security: SecurityService;
  automod: AutomodService;
  community: CommunityService;
  welcome: WelcomeService;
  branding: BrandingService;
  scheduler: SchedulerService;
  status: StatusService;
  /** Present only when ENABLE_MUSIC=true and Lavalink is configured. */
  music: MusicService | null;
  features: FeatureFlags;
  /** Process start time (ms). */
  startedAt: number;
  version: string;
  /** Metadata for every loaded command (used by /help and the dashboard). */
  commandCatalog: () => { name: string; category: string; description: string; ownerOnly: boolean }[];
}
