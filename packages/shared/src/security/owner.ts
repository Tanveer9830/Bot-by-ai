/**
 * Centralized bot-owner authorization.
 *
 * Every owner-only feature in the bot AND the dashboard must go through this
 * module. There is intentionally no other place in the codebase that compares a
 * user id against a hard-coded owner id.
 */
import { SNOWFLAKE_REGEX } from '../config/env.js';
import { NotBotOwnerError } from '../utils/errors.js';

export interface OwnerRegistry {
  /** All configured owner ids (deduplicated, validated). */
  readonly ids: readonly string[];
  /** True when the given user id is one of the configured bot owners. */
  isOwner(userId: string | null | undefined): boolean;
  /** Throws NotBotOwnerError when the user is not an owner. */
  assertOwner(userId: string | null | undefined): void;
}

export function parseOwnerIds(raw: string | readonly string[]): string[] {
  const parts = Array.isArray(raw) ? [...raw] : String(raw).split(',');
  const ids = parts.map((part) => part.trim()).filter((part) => part.length > 0);
  const invalid = ids.filter((id) => !SNOWFLAKE_REGEX.test(id));
  if (ids.length === 0) {
    throw new Error('BOT_OWNER_IDS must contain at least one Discord user id');
  }
  if (invalid.length > 0) {
    throw new Error(`BOT_OWNER_IDS contains invalid snowflake(s): ${invalid.join(', ')}`);
  }
  return [...new Set(ids)];
}

export function createOwnerRegistry(raw: string | readonly string[]): OwnerRegistry {
  const ids = Object.freeze(parseOwnerIds(raw));
  const idSet = new Set(ids);
  return {
    ids,
    isOwner(userId) {
      if (!userId) return false;
      return idSet.has(String(userId));
    },
    assertOwner(userId) {
      if (!userId || !idSet.has(String(userId))) {
        throw new NotBotOwnerError(String(userId ?? 'unknown'));
      }
    },
  };
}

/**
 * Discord permissions that must NEVER be enough to grant owner-only powers.
 * Kept explicit so a reviewer can see the intent, and so tests can assert it.
 */
export const OWNER_BYPASS_PERMISSIONS = [
  'Administrator',
  'ManageGuild',
  'ManageRoles',
  'ManageWebhooks',
] as const;
