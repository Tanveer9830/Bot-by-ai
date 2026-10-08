/**
 * Safe variable templating for custom commands and branding.
 *
 * There is deliberately NO eval, no Function(), no shell, and no dynamic import.
 * Only allow-listed placeholders are substituted; everything else is escaped.
 */
import { escapeMarkdown, sanitizeMentions } from '../utils/format.js';

export interface TemplateContext {
  user?: { id: string; tag: string; username: string; mention?: string };
  server?: { name: string; memberCount: number; id: string };
  channel?: { name: string; mention?: string };
  command?: { name: string; args: string };
  date?: Date;
  /** Extra variables contributed by trusted server-side code only. */
  extras?: Record<string, string | number>;
}

const ALLOWED_VARIABLES = new Set([
  'user',
  'userid',
  'username',
  'usermention',
  'server',
  'serverid',
  'membercount',
  'channel',
  'channelmention',
  'command',
  'args',
  'date',
  'time',
  'timestamp',
]);

export interface RenderResult {
  output: string;
  unknownVariables: string[];
}

export function renderTemplate(template: string, context: TemplateContext): RenderResult {
  const unknown: string[] = [];
  const now = context.date ?? new Date();

  const values: Record<string, string> = {
    user: escapeMarkdown(context.user?.username ?? 'unknown'),
    userid: context.user?.id ?? '',
    username: escapeMarkdown(context.user?.username ?? 'unknown'),
    usermention: context.user?.mention ?? (context.user ? `<@${context.user.id}>` : ''),
    server: escapeMarkdown(context.server?.name ?? 'this server'),
    serverid: context.server?.id ?? '',
    membercount: String(context.server?.memberCount ?? 0),
    channel: escapeMarkdown(context.channel?.name ?? 'this channel'),
    channelmention: context.channel?.mention ?? '',
    command: context.command?.name ?? '',
    args: sanitizeMentions(context.command?.args ?? ''),
    date: now.toISOString().slice(0, 10),
    time: now.toISOString().slice(11, 19),
    timestamp: String(Math.floor(now.getTime() / 1000)),
  };

  for (const [key, value] of Object.entries(context.extras ?? {})) {
    const normalized = key.toLowerCase();
    if (!/^[a-z][a-z0-9_]{0,24}$/.test(normalized)) continue; // never allow arbitrary keys
    values[normalized] = sanitizeMentions(String(value));
  }

  const output = template.replace(
    /\{\{?\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}?\}/g,
    (full, name: string) => {
      const key = name.toLowerCase();
      if (!ALLOWED_VARIABLES.has(key) && !(key in values)) {
        unknown.push(name);
        return full;
      }
      return values[key] ?? full;
    },
  );

  return { output, unknownVariables: [...new Set(unknown)] };
}

/** Returns the list of placeholders a template uses (for the dashboard preview UI). */
export function listTemplateVariables(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(/\{\{?\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}?\}/g)) {
    const name = match[1];
    if (name) found.add(name.toLowerCase());
  }
  return [...found];
}

export function validateTemplate(
  template: string,
  maxLength = 4000,
): { valid: boolean; error?: string; unknown: string[] } {
  if (template.length > maxLength) {
    return { valid: false, error: `template exceeds ${maxLength} characters`, unknown: [] };
  }
  const unknown = listTemplateVariables(template).filter((name) => !ALLOWED_VARIABLES.has(name));
  return { valid: true, unknown };
}
