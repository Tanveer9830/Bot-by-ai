export * from './pool.js';
export * from './migrations/runner.js';
export * from './repositories/guilds.js';
export * from './repositories/users.js';
export * from './repositories/moderation.js';
export * from './repositories/security.js';
export * from './repositories/tickets.js';
export * from './repositories/customCommands.js';
export * from './repositories/economy.js';
export * from './repositories/levels.js';
export * from './repositories/community.js';
export * from './repositories/audit.js';
export * from './repositories/tasks.js';
export * from './repositories/sessions.js';
export * from './repositories/analytics.js';

import type { Database, DatabaseOptions } from './pool.js';
import { createDatabase } from './pool.js';
import { GuildRepository } from './repositories/guilds.js';
import { UserRepository } from './repositories/users.js';
import { ModerationRepository } from './repositories/moderation.js';
import { SecurityRepository } from './repositories/security.js';
import { TicketRepository } from './repositories/tickets.js';
import { CustomCommandRepository } from './repositories/customCommands.js';
import { EconomyRepository } from './repositories/economy.js';
import { LevelRepository } from './repositories/levels.js';
import { CommunityRepository } from './repositories/community.js';
import { AuditRepository, CommandUsageRepository } from './repositories/audit.js';
import { TaskRepository } from './repositories/tasks.js';
import { SessionRepository } from './repositories/sessions.js';
import { AnalyticsRepository } from './repositories/analytics.js';

export interface Repositories {
  guilds: GuildRepository;
  users: UserRepository;
  moderation: ModerationRepository;
  security: SecurityRepository;
  tickets: TicketRepository;
  customCommands: CustomCommandRepository;
  economy: EconomyRepository;
  levels: LevelRepository;
  community: CommunityRepository;
  audit: AuditRepository;
  commandUsage: CommandUsageRepository;
  tasks: TaskRepository;
  sessions: SessionRepository;
  analytics: AnalyticsRepository;
}

export function createRepositories(db: Database): Repositories {
  return {
    guilds: new GuildRepository(db),
    users: new UserRepository(db),
    moderation: new ModerationRepository(db),
    security: new SecurityRepository(db),
    tickets: new TicketRepository(db),
    customCommands: new CustomCommandRepository(db),
    economy: new EconomyRepository(db),
    levels: new LevelRepository(db),
    community: new CommunityRepository(db),
    audit: new AuditRepository(db),
    commandUsage: new CommandUsageRepository(db),
    tasks: new TaskRepository(db),
    sessions: new SessionRepository(db),
    analytics: new AnalyticsRepository(db),
  };
}

export function openDatabase(options: DatabaseOptions): {
  db: Database;
  repositories: Repositories;
} {
  const db = createDatabase(options);
  return { db, repositories: createRepositories(db) };
}
