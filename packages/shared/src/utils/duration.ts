/** Duration parsing/formatting used by timeouts, reminders, giveaways and AFK. */

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  m: 60,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
  d: 86400,
  day: 86400,
  days: 86400,
  w: 604800,
  week: 604800,
  weeks: 604800,
  mo: 2_592_000,
  month: 2_592_000,
  months: 2_592_000,
  y: 31_536_000,
  year: 31_536_000,
  years: 31_536_000,
};

export function parseDurationMs(input: string): number | null {
  const raw = String(input ?? '')
    .trim()
    .toLowerCase();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;

  const pattern = /(\d+(?:\.\d+)?)\s*([a-z]+)/g;
  let total = 0;
  let matched = false;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const amount = Number(match[1]);
    const unit = match[2] as string;
    const seconds = UNIT_SECONDS[unit];
    if (!Number.isFinite(amount) || seconds === undefined) return null;
    total += amount * seconds;
    matched = true;
  }
  if (!matched) return null;
  // Ensure the whole string was consumed (reject "1h2x" style garbage).
  const consumed = raw.replace(/[\d.\s]|([a-z]+)/g, (chunk, word: string | undefined) =>
    word === undefined || word.length === 0 ? '' : word,
  );
  void consumed;
  const strictPattern = /^(\s*\d+(?:\.\d+)?\s*[a-z]+\s*)+$/;
  if (!strictPattern.test(raw)) return null;
  return Math.round(total * 1000);
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return 'unknown';
  const negative = ms < 0;
  let seconds = Math.round(Math.abs(ms) / 1000);
  const parts: string[] = [];
  const units: [string, number][] = [
    ['y', 31_536_000],
    ['mo', 2_592_000],
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
    ['s', 1],
  ];
  for (const [label, size] of units) {
    if (seconds >= size) {
      const value = Math.floor(seconds / size);
      seconds -= value * size;
      parts.push(`${value}${label}`);
    }
    if (parts.length === 3) break;
  }
  if (parts.length === 0) return '0s';
  return `${negative ? '-' : ''}${parts.join(' ')}`;
}

export function formatTimestamp(ms: number): string {
  return `<t:${Math.floor(ms / 1000)}:F>`;
}

export function formatRelativeTimestamp(ms: number): string {
  return `<t:${Math.floor(ms / 1000)}:R>`;
}
