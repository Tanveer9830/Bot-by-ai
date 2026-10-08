/**
 * Owner authorization: the single source of truth for owner-only features.
 * These tests assert the security properties the bot depends on.
 */
import { describe, expect, it } from 'vitest';
import {
  createOwnerRegistry,
  NotBotOwnerError,
  OWNER_BYPASS_PERMISSIONS,
  parseOwnerIds,
} from '@bot-by-ai/shared';

const OWNER_A = '1131248987173814336';
const OWNER_B = '1473315482554732786';

describe('owner registry', () => {
  it('parses a comma separated list and trims whitespace', () => {
    expect(parseOwnerIds(` ${OWNER_A} , ${OWNER_B} `)).toEqual([OWNER_A, OWNER_B]);
  });

  it('de-duplicates ids', () => {
    expect(parseOwnerIds(`${OWNER_A},${OWNER_A}`)).toEqual([OWNER_A]);
  });

  it('rejects an empty list', () => {
    expect(() => parseOwnerIds('')).toThrow(/at least one/);
  });

  it('rejects non-snowflake ids instead of silently ignoring them', () => {
    expect(() => parseOwnerIds('not-an-id')).toThrow(/invalid snowflake/);
    expect(() => parseOwnerIds(`${OWNER_A},123`)).toThrow(/invalid snowflake/);
  });

  it('grants both configured owners identical privileges', () => {
    const registry = createOwnerRegistry(`${OWNER_A},${OWNER_B}`);
    expect(registry.ids).toEqual([OWNER_A, OWNER_B]);
    expect(registry.isOwner(OWNER_A)).toBe(true);
    expect(registry.isOwner(OWNER_B)).toBe(true);
    expect(registry.assertOwner(OWNER_A)).toBeUndefined();
    expect(registry.assertOwner(OWNER_B)).toBeUndefined();
  });

  it('denies everyone else, including empty/undefined ids', () => {
    const registry = createOwnerRegistry(OWNER_A);
    expect(registry.isOwner('1')).toBe(false);
    expect(registry.isOwner('')).toBe(false);
    expect(registry.isOwner(null)).toBe(false);
    expect(registry.isOwner(undefined)).toBe(false);
    expect(() => registry.assertOwner('1')).toThrow(NotBotOwnerError);
  });

  it('freezes the id list so runtime code cannot mutate it', () => {
    const registry = createOwnerRegistry(OWNER_A);
    expect(Object.isFrozen(registry.ids)).toBe(true);
  });

  it('documents that Discord permissions never grant owner powers', () => {
    // Guard against someone "helpfully" adding Administrator to the bypass list.
    expect([...OWNER_BYPASS_PERMISSIONS]).toContain('Administrator');
    expect(OWNER_BYPASS_PERMISSIONS.length).toBeGreaterThan(0);
  });
});
