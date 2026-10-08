import { randomInt, randomBytes } from 'node:crypto';

/** Cryptographically-random integer in [min, max] inclusive. */
export function secureRandomInt(min: number, max: number): number {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  if (hi < lo) throw new Error('max must be >= min');
  return randomInt(lo, hi + 1);
}

export function pickRandom<T>(items: readonly T[], rng: () => number = Math.random): T | undefined {
  if (items.length === 0) return undefined;
  const index = Math.min(items.length - 1, Math.floor(rng() * items.length));
  return items[index];
}

/** Fisher-Yates shuffle. `rng` is injectable so tests are deterministic. */
export function shuffle<T>(items: readonly T[], rng: () => number = Math.random): T[] {
  const output = [...items];
  for (let i = output.length - 1; i > 0; i -= 1) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)));
    const a = output[i] as T;
    const b = output[j] as T;
    output[i] = b;
    output[j] = a;
  }
  return output;
}

/** Weighted pick used for giveaways with bonus entries. */
export function weightedPick<T>(
  entries: readonly { item: T; weight: number }[],
  rng = Math.random,
): T | undefined {
  const total = entries.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0);
  if (total <= 0) return undefined;
  let roll = rng() * total;
  for (const entry of entries) {
    roll -= Math.max(0, entry.weight);
    if (roll <= 0) return entry.item;
  }
  return entries[entries.length - 1]?.item;
}

export function generateCode(length = 8): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[(bytes[i] as number) % alphabet.length];
  }
  return out;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
