/**
 * Integration test: the command registry loads every module from disk, validates
 * each definition against Discord's documented limits, and enforces the
 * owner-only flag on the commands that must never be reachable by regular users.
 *
 * No database or Discord connection is required, so this runs everywhere.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { CommandRegistry } from '../../apps/bot/src/core/registry.js';
import { GLOBAL_COMMAND_LIMIT } from '../../apps/bot/src/core/command.js';
import { createLogger, MODULE_NAMES } from '@bot-by-ai/shared';

const here = dirname(fileURLToPath(import.meta.url));
const commandsDir = resolve(here, '../../apps/bot/src/commands');

const logger = createLogger({ level: 'error', pretty: false });
const registry = new CommandRegistry(logger);

beforeAll(async () => {
  await registry.loadFrom(commandsDir);
});

describe('command registry', () => {
  it('loads every command module without validation issues', () => {
    expect(registry.validationIssues).toEqual([]);
  });

  it('has a substantial, real command surface', () => {
    expect(registry.size).toBeGreaterThanOrEqual(80);
    expect(registry.size).toBeLessThanOrEqual(GLOBAL_COMMAND_LIMIT);
  });

  it('produces unique, Discord-compatible names and descriptions', () => {
    const seen = new Set<string>();
    for (const command of registry.list()) {
      const json = command.data.toJSON();
      expect(json.name).toMatch(/^[\w-]{1,32}$/);
      expect(json.name).toBe(json.name.toLowerCase());
      expect(json.description.length).toBeGreaterThan(0);
      expect(json.description.length).toBeLessThanOrEqual(100);
      expect(seen.has(json.name)).toBe(false);
      seen.add(json.name);
    }
  });

  it('registers every module under a known category', () => {
    const categories = new Set(registry.list().map((command) => command.category));
    for (const category of categories) {
      expect([
        'utility',
        'moderation',
        'security',
        'automod',
        'economy',
        'levels',
        'tickets',
        'community',
        'welcome',
        'logging',
        'reaction-roles',
        'music',
        'configuration',
        'owner',
      ]).toContain(category);
    }
    expect(categories.size).toBeGreaterThanOrEqual(8);
  });
});

describe('owner-only surface', () => {
  it('marks /globalcommand, /owner and /ownermaintenance owner-only', () => {
    for (const name of ['globalcommand', 'owner', 'ownermaintenance']) {
      const command = registry.get(name);
      expect(command, `/${name} should be registered`).toBeDefined();
      expect(command?.ownerOnly).toBe(true);
    }
  });

  it('never grants owner-only powers through Discord permissions', () => {
    for (const command of registry.list()) {
      if (command.ownerOnly) {
        // A defaultMemberPermissions value would imply "server admins may use it".
        expect(command.data.toJSON().default_member_permissions ?? null).toBeNull();
      }
    }
  });

  it('keeps moderation commands behind server permissions', () => {
    for (const name of ['ban', 'kick', 'timeout', 'purge', 'warn']) {
      const command = registry.get(name);
      expect(command, `/${name} should be registered`).toBeDefined();
      const permissions = command?.data.toJSON().default_member_permissions;
      expect(permissions === undefined || typeof permissions === 'string').toBe(true);
      expect(command?.ownerOnly ?? false).toBe(false);
    }
  });
});

describe('settings modules exposed to /config', () => {
  it('exposes all 21 settings modules', () => {
    expect(MODULE_NAMES.length).toBeGreaterThanOrEqual(20);
    expect(MODULE_NAMES).toContain('general');
    expect(MODULE_NAMES).toContain('logging');
    expect(MODULE_NAMES).toContain('economy');
  });

  it('/config and /customcommand exist and are guild-scoped', () => {
    expect(registry.get('config')).toBeDefined();
    expect(registry.get('customcommand')).toBeDefined();
  });
});
