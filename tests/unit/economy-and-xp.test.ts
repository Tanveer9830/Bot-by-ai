/**
 * Economy and XP maths. These pure functions back the database transactions, so
 * an error here would silently produce wrong balances or levels.
 */
import { describe, expect, it } from 'vitest';
import {
  assertSufficientFunds,
  assertValidAmount,
  computeDailyReward,
  computeMessageXp,
  computeTransfer,
  computeWorkReward,
  idempotencyKey,
  isLowQualityMessage,
  levelFromXp,
  MAX_CURRENCY_AMOUNT,
  MAX_LEVEL,
  nextStreak,
  progressFromXp,
  totalXpForLevel,
  BusinessError,
  xpForNextLevel,
} from '@bot-by-ai/shared';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('amount guards', () => {
  it('rejects zero, negative, fractional and absurd amounts', () => {
    for (const bad of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_CURRENCY_AMOUNT + 1]) {
      expect(() => assertValidAmount(bad)).toThrow();
    }
  });

  it('accepts a normal amount', () => {
    expect(assertValidAmount(250)).toBe(250);
  });

  it('blocks overdrafts with a user-facing error', () => {
    expect(() => assertSufficientFunds(10, 25)).toThrow(BusinessError);
    expect(() => assertSufficientFunds(25, 25)).not.toThrow();
  });
});

describe('daily reward', () => {
  it('scales with the streak and caps the multiplier', () => {
    const day1 = computeDailyReward({ base: 100, streak: 0 });
    const day5 = computeDailyReward({ base: 100, streak: 4 });
    expect(day1.amount).toBe(100);
    expect(day5.amount).toBeGreaterThan(day1.amount);
    const capped = computeDailyReward({ base: 100, streak: 500 });
    expect(capped.amount).toBeLessThanOrEqual(100 * 5);
  });

  it('never exceeds the currency ceiling', () => {
    const huge = computeDailyReward({ base: MAX_CURRENCY_AMOUNT, streak: 100 });
    expect(huge.amount).toBeLessThanOrEqual(MAX_CURRENCY_AMOUNT);
  });

  it('is deterministic for identical inputs', () => {
    expect(computeDailyReward({ base: 50, streak: 3 })).toEqual(
      computeDailyReward({ base: 50, streak: 3 }),
    );
  });
});

describe('work reward', () => {
  it('stays inside [min, max * level scaling]', () => {
    for (const roll of [0, 0.25, 0.5, 0.75, 0.999]) {
      const reward = computeWorkReward({ min: 20, max: 40, level: 0, roll });
      expect(reward).toBeGreaterThanOrEqual(20);
      expect(reward).toBeLessThanOrEqual(40);
    }
  });

  it('grows with level', () => {
    const low = computeWorkReward({ min: 20, max: 40, level: 0, roll: 1 });
    const high = computeWorkReward({ min: 20, max: 40, level: 10, roll: 1 });
    expect(high).toBeGreaterThan(low);
  });

  it('clamps out-of-range rolls instead of producing NaN', () => {
    expect(Number.isFinite(computeWorkReward({ min: 10, max: 20, level: 3, roll: -5 }))).toBe(true);
    expect(Number.isFinite(computeWorkReward({ min: 10, max: 20, level: 3, roll: 5 }))).toBe(true);
  });
});

describe('transfers', () => {
  it('burns the fee instead of crediting it', () => {
    const transfer = computeTransfer({ amount: 1000, feePercent: 5 });
    expect(transfer.fee).toBe(50);
    expect(transfer.credited).toBe(1000);
    expect(transfer.total).toBe(1050);
  });

  it('caps the fee when maxFee is given', () => {
    const transfer = computeTransfer({ amount: 10_000, feePercent: 10, maxFee: 100 });
    expect(transfer.fee).toBe(100);
  });

  it('is fee-free by default', () => {
    expect(computeTransfer({ amount: 500 }).fee).toBe(0);
  });
});

describe('streaks', () => {
  const now = 1_700_000_000_000;

  it('starts at 1 for a first claim', () => {
    const result = nextStreak({ lastClaimAt: null, now, periodMs: DAY });
    expect(result.streak).toBe(1);
    expect(result.claimable).toBe(true);
  });

  it('blocks a second claim inside the period', () => {
    const result = nextStreak({ lastClaimAt: now - HOUR, now, periodMs: DAY, currentStreak: 3 });
    expect(result.claimable).toBe(false);
    expect(result.streak).toBe(3);
  });

  it('increments inside the grace window and resets outside it', () => {
    const continued = nextStreak({
      lastClaimAt: now - DAY - HOUR,
      now,
      periodMs: DAY,
      currentStreak: 3,
    });
    expect(continued.streak).toBe(4);
    expect(continued.reset).toBe(false);

    const reset = nextStreak({ lastClaimAt: now - 10 * DAY, now, periodMs: DAY, currentStreak: 9 });
    expect(reset.streak).toBe(1);
    expect(reset.reset).toBe(true);
  });
});

describe('idempotency keys', () => {
  it('are stable for the same parts and differ otherwise', () => {
    const a = idempotencyKey(['daily', 'guild', 'user', 1]);
    const b = idempotencyKey(['daily', 'guild', 'user', 1]);
    const c = idempotencyKey(['daily', 'guild', 'user', 2]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('xp curve', () => {
  it('requires more xp for each successive level', () => {
    const levels = [0, 1, 2, 5, 10, 50].map((level) => xpForNextLevel(level));
    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i]!).toBeGreaterThan(levels[i - 1]!);
    }
  });

  it('levelFromXp inverts totalXpForLevel', () => {
    for (const level of [0, 1, 2, 7, 25, 100]) {
      const total = totalXpForLevel(level);
      expect(levelFromXp(total)).toBe(level);
      if (level > 0) expect(levelFromXp(total - 1)).toBe(level - 1);
    }
  });

  it('never exceeds MAX_LEVEL', () => {
    expect(levelFromXp(Number.MAX_SAFE_INTEGER)).toBe(MAX_LEVEL);
  });

  it('progressFromXp returns a bounded ratio', () => {
    const progress = progressFromXp(1234);
    expect(progress.ratio).toBeGreaterThanOrEqual(0);
    expect(progress.ratio).toBeLessThanOrEqual(1);
    expect(progress.level).toBeGreaterThanOrEqual(0);
    expect(progress.xpIntoLevel).toBeLessThanOrEqual(progress.xpForLevel);
  });

  it('message xp respects the configured band and multiplier', () => {
    expect(computeMessageXp({ min: 15, max: 25, roll: 0 })).toBe(15);
    expect(computeMessageXp({ min: 15, max: 25, roll: 0.999999 })).toBe(25);
    expect(computeMessageXp({ min: 15, max: 25, roll: 0.5, multiplier: 2 })).toBe(40);
  });

  it('flags low quality messages so spam earns nothing', () => {
    expect(isLowQualityMessage('a')).toBe(true);
    expect(isLowQualityMessage('........')).toBe(true);
    expect(isLowQualityMessage('hello there', ['hello there', 'HELLO THERE'])).toBe(true);
    expect(isLowQualityMessage('a genuinely useful sentence')).toBe(false);
  });
});
