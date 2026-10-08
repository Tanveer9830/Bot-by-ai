/** Pure XP/level math shared by the bot and the dashboard leaderboards. */

export const MAX_LEVEL = 500;

export interface XpCurve {
  /** XP required to go from level 0 to level 1. */
  base: number;
  /** Growth exponent applied per level (1.5-2.5 are sane values). */
  exponent: number;
  /** Linear growth added per level. */
  growth: number;
}

export const DEFAULT_XP_CURVE: XpCurve = { base: 100, exponent: 1.55, growth: 25 };

export function xpForNextLevel(level: number, curve: XpCurve = DEFAULT_XP_CURVE): number {
  const safeLevel = Math.max(0, Math.min(Math.floor(level), MAX_LEVEL - 1));
  const value =
    curve.base + curve.growth * safeLevel + Math.pow(safeLevel + 1, curve.exponent) * 10;
  return Math.max(1, Math.floor(value));
}

/** Total XP accumulated required to be at the start of `level`. */
export function totalXpForLevel(level: number, curve: XpCurve = DEFAULT_XP_CURVE): number {
  const target = Math.max(0, Math.min(Math.floor(level), MAX_LEVEL));
  let total = 0;
  for (let i = 0; i < target; i += 1) total += xpForNextLevel(i, curve);
  return total;
}

export function levelFromXp(totalXp: number, curve: XpCurve = DEFAULT_XP_CURVE): number {
  let remaining = Math.max(0, Math.floor(totalXp));
  let level = 0;
  while (level < MAX_LEVEL) {
    const need = xpForNextLevel(level, curve);
    if (remaining < need) break;
    remaining -= need;
    level += 1;
  }
  return level;
}

export function progressFromXp(
  totalXp: number,
  curve: XpCurve = DEFAULT_XP_CURVE,
): { level: number; xpIntoLevel: number; xpForLevel: number; ratio: number; totalXp: number } {
  const safeTotal = Math.max(0, Math.floor(totalXp));
  let remaining = safeTotal;
  let level = 0;
  while (level < MAX_LEVEL) {
    const need = xpForNextLevel(level, curve);
    if (remaining < need) break;
    remaining -= need;
    level += 1;
  }
  const xpForLevel = xpForNextLevel(level, curve);
  return {
    level,
    xpIntoLevel: remaining,
    xpForLevel,
    ratio: xpForLevel > 0 ? Math.min(1, remaining / xpForLevel) : 0,
    totalXp: safeTotal,
  };
}

export interface MessageXpInput {
  min: number;
  max: number;
  multiplier?: number;
  /** Inclusive uniform random in [0,1) — injected for deterministic tests. */
  roll?: number;
}

export function computeMessageXp(input: MessageXpInput): number {
  const min = Math.max(0, Math.floor(input.min));
  const max = Math.max(min, Math.floor(input.max));
  const roll = input.roll ?? Math.random();
  const bounded = Math.min(Math.max(roll, 0), 0.999999);
  const base = min + Math.floor(bounded * (max - min + 1));
  const multiplier = Math.max(0, input.multiplier ?? 1);
  return Math.max(0, Math.floor(base * multiplier));
}

/** Simple spam heuristic: short, repetitive, low-information messages earn nothing. */
export function isLowQualityMessage(
  content: string,
  previousMessages: readonly string[] = [],
): boolean {
  const text = content.trim();
  if (text.length < 3) return true;
  if (/^(.)\1{2,}$/.test(text)) return true;
  const normalized = text.toLowerCase();
  const repeats = previousMessages.filter(
    (prev) => prev.trim().toLowerCase() === normalized,
  ).length;
  return repeats >= 2;
}

export function computeLevelUpRoles<T extends { level: number }>(
  level: number,
  roles: readonly T[],
): { toAdd: T[]; toRemove: T[] } {
  const sorted = [...roles].sort((a, b) => a.level - b.level);
  const eligible = sorted.filter((role) => role.level <= level);
  const highest = eligible[eligible.length - 1];
  const toAdd = highest ? [highest] : [];
  const toRemove = sorted.filter((role) => role.level > level);
  return { toAdd, toRemove };
}
