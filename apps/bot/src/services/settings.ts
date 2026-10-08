import type { Logger, ModuleName } from '@bot-by-ai/shared';
import { moduleDefaults } from '@bot-by-ai/shared';
import type { Database, Repositories } from '@bot-by-ai/database';

export interface SettingsChangeContext {
  actorId: string | null;
  source: 'dashboard' | 'command' | 'system' | 'custom_command';
}

interface CacheEntry {
  values: Record<string, Record<string, unknown>>;
  expiresAt: number;
}

/**
 * Guild settings access with a short-lived in-memory cache.
 *
 * The cache exists because every message triggers automod/level lookups; it is
 * invalidated on every write (bot or dashboard) so behaviour is never stale for
 * more than the TTL when another process wrote the row.
 */
export class GuildSettingsService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly db: Database,
    private readonly repos: Repositories,
    private readonly logger: Logger,
    private readonly ttlMs = 30_000,
  ) {}

  invalidate(guildId: string): void {
    this.cache.delete(guildId);
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  private async load(guildId: string): Promise<Record<string, Record<string, unknown>>> {
    const cached = this.cache.get(guildId);
    if (cached && cached.expiresAt > Date.now()) return cached.values;
    const values = await this.repos.guilds.getAllModuleSettings(guildId);
    this.cache.set(guildId, { values, expiresAt: Date.now() + this.ttlMs });
    return values;
  }

  async getAll(guildId: string): Promise<Record<string, Record<string, unknown>>> {
    return this.load(guildId);
  }

  /**
   * Typed accessor: `settings.get<AutomodSettings>(guildId, 'automod')`.
   * `fallback` fills in fields of modules the guild row predates.
   */
  async get<T>(guildId: string, module: ModuleName, fallback?: Partial<T>): Promise<T> {
    try {
      const values = await this.load(guildId);
      const stored = values[module];
      if (stored) {
        return (fallback ? { ...(moduleDefaults(module) as object), ...(fallback as object), ...stored } : stored) as T;
      }
    } catch (error) {
      this.logger.error('failed to read guild settings, using defaults', {
        guildId,
        module,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { ...(moduleDefaults(module) as object), ...((fallback ?? {}) as object) } as unknown as T;
  }

  /**
   * Validated partial update. Validation happens again inside the repository
   * (schema) so a dashboard bug cannot persist an invalid shape.
   */
  async update<T>(
    guildId: string,
    module: ModuleName,
    patch: Record<string, unknown>,
    context: SettingsChangeContext,
  ): Promise<T> {
    const updated = (await this.repos.guilds.patchModuleSettings(guildId, module, patch, context)) as T;
    this.invalidate(guildId);
    return updated;
  }

  async ensureGuild(input: {
    id: string;
    name?: string;
    icon?: string | null;
    ownerId?: string | null;
    memberCount?: number;
  }): Promise<void> {
    await this.repos.guilds.ensureGuild(input);
    this.invalidate(input.id);
  }

  async history(guildId: string, limit = 50): Promise<Awaited<ReturnType<Repositories['guilds']['getSettingsHistory']>>> {
    return this.repos.guilds.getSettingsHistory(guildId, limit);
  }

  /** Used by the scheduled worker to drop caches that may have changed externally. */
  async refreshAll(): Promise<void> {
    this.cache.clear();
  }
}
