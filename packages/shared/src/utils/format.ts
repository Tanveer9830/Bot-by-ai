/** Small formatting helpers shared by bot embeds and dashboard UI. */

export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(index === 0 ? 0 : decimals)} ${units[index]}`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

export function truncate(input: string, max = 1024, suffix = '…'): string {
  const text = String(input ?? '');
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - suffix.length)) + suffix;
}

/** Escape user input that will be rendered inside Discord markdown/code blocks. */
export function escapeMarkdown(input: string): string {
  return String(input ?? '').replace(/([\\*_~`|>])/g, '\\$1');
}

export function escapeCodeBlock(input: string): string {
  return String(input ?? '').replace(/```/g, '``\u200b`');
}

/** Strip characters Discord would interpret as mentions, for safe echoes. */
export function sanitizeMentions(input: string): string {
  return String(input ?? '')
    .replace(/@everyone/g, '@\u200beveryone')
    .replace(/@here/g, '@\u200bhere')
    .replace(/<@!?(\d+)>/g, (_m, id: string) => `@user(${id})`)
    .replace(/<@&(\d+)>/g, (_m, id: string) => `@role(${id})`);
}

export function titleCase(input: string): string {
  return String(input ?? '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural ?? `${singular}s`);
}

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunk size must be > 0');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size) as T[]);
  return out;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

export function paginate<T>(items: readonly T[], page = 1, pageSize = 10): Page<T> {
  const size = Math.max(1, pageSize);
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const current = clamp(Math.floor(page), 1, pageCount);
  const start = (current - 1) * size;
  return {
    items: items.slice(start, start + size),
    page: current,
    pageCount,
    total,
    pageSize: size,
    hasNext: current < pageCount,
    hasPrevious: current > 1,
  };
}

/** Progress bar used by rank cards / economy embeds. */
export function progressBar(current: number, total: number, length = 12): string {
  if (total <= 0) return '▱'.repeat(length);
  const ratio = clamp(current / total, 0, 1);
  const filled = Math.round(ratio * length);
  return `${'▰'.repeat(filled)}${'▱'.repeat(length - filled)}`;
}
