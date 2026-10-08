/**
 * Pure AutoMod rule evaluation.
 *
 * The message-handling layer feeds plain text + context in, and gets a list of
 * violations out. No Discord objects are touched here, which keeps the rules
 * fully unit-testable and identical across bot + dashboard previews.
 */

export type ViolationKind =
  | 'spam'
  | 'caps'
  | 'mentions'
  | 'invite'
  | 'link'
  | 'duplicate'
  | 'flood'
  | 'blocked_word'
  | 'zalgo';

export interface AutomodRules {
  enabled: boolean;
  /** Max messages allowed inside `spamWindowMs` before it is spam. */
  spamMessageLimit: number;
  spamWindowMs: number;
  /** Duplicate-message detection window. */
  duplicateWindowMs: number;
  duplicateLimit: number;
  /** Max @mentions allowed in a single message (0 = unlimited). */
  maxMentions: number;
  /** Percentage of uppercase letters that triggers the caps rule. */
  capsPercent: number;
  /** Minimum length before the caps rule applies at all. */
  capsMinLength: number;
  blockedWords: string[];
  blockedWordsAsRegex: boolean;
  /** Block discord.gg / discord.com invite links. */
  blockInvites: boolean;
  /** Block all http(s) links. */
  blockLinks: boolean;
  /** Domains that are always allowed. */
  allowedDomains: string[];
  /** Extra suspicious TLD/domain patterns. */
  suspiciousDomains: string[];
  /** Block messages with an excessive number of emojis. */
  maxEmojis: number;
  /** Block messages containing zalgo / excessive combining marks. */
  blockZalgo: boolean;
  /** Number of mentions of *one user* that counts as mention spam. */
  mentionSpamThreshold: number;
  exemptRoleIds: string[];
  exemptChannelIds: string[];
  exemptUserIds: string[];
}

export const DEFAULT_AUTOMOD_RULES: AutomodRules = {
  enabled: false,
  spamMessageLimit: 5,
  spamWindowMs: 5000,
  duplicateWindowMs: 30_000,
  duplicateLimit: 3,
  maxMentions: 6,
  capsPercent: 70,
  capsMinLength: 10,
  blockedWords: [],
  blockedWordsAsRegex: false,
  blockInvites: true,
  blockLinks: false,
  allowedDomains: [],
  suspiciousDomains: [],
  maxEmojis: 12,
  blockZalgo: true,
  mentionSpamThreshold: 4,
  exemptRoleIds: [],
  exemptChannelIds: [],
  exemptUserIds: [],
};

export interface AutomodMessageInput {
  content: string;
  /** Messages from the same author in the recent window, oldest first (excluding this one). */
  recentMessages?: { content: string; timestamp: number }[];
  mentionCounts?: {
    total: number;
    uniqueUsers: number;
    maxForSingleUser: number;
    mentionsEveryone: boolean;
  };
  now: number;
  authorId: string;
  channelId: string;
  memberRoleIds?: string[];
  isStaff?: boolean;
}

export interface Violation {
  kind: ViolationKind;
  detail: string;
  /** 1 = low, 2 = medium, 3 = high. */
  severity: 1 | 2 | 3;
}

const URL_REGEX = /\bhttps?:\/\/[^\s<>"')]+/gi;
const INVITE_REGEX =
  /\b(?:discord\.(?:gg|io|me|li)|discord(?:app)?\.com\/invite|dsc\.gg|invite\.gg)\/\S+/gi;
const ZALGO_REGEX = /[\u0300-\u036f\u0489]{4,}/;
const CUSTOM_EMOJI_REGEX = /<a?:\w+:\d+>/g;
const UNICODE_EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;

export function extractUrls(content: string): string[] {
  return content.match(URL_REGEX) ?? [];
}

export function extractDomains(content: string): string[] {
  return extractUrls(content)
    .map((url) => {
      try {
        return new URL(url).hostname.toLowerCase();
      } catch {
        return null;
      }
    })
    .filter((value): value is string => Boolean(value));
}

export function domainAllowed(domain: string, allowed: readonly string[]): boolean {
  return allowed.some((entry) => {
    const normalized = entry.toLowerCase().replace(/^\./, '');
    return domain === normalized || domain.endsWith(`.${normalized}`);
  });
}

export function countBlockedWords(content: string, rules: AutomodRules): string[] {
  if (rules.blockedWords.length === 0) return [];
  const lowered = content.toLowerCase();
  const hits: string[] = [];
  for (const word of rules.blockedWords) {
    if (!word) continue;
    if (rules.blockedWordsAsRegex) {
      try {
        const regex = new RegExp(word, 'i');
        if (regex.test(content)) hits.push(word);
      } catch {
        // Invalid admin-supplied regex: skip rather than crash the message handler.
      }
      continue;
    }
    if (lowered.includes(word.toLowerCase())) hits.push(word);
  }
  return hits;
}

export function capsRatio(content: string): number {
  const letters = content.replace(/[^a-zA-Z]/g, '');
  if (letters.length === 0) return 0;
  const uppercase = letters.replace(/[^A-Z]/g, '').length;
  return uppercase / letters.length;
}

export function countEmojis(content: string): number {
  const custom = content.match(CUSTOM_EMOJI_REGEX)?.length ?? 0;
  const unicode = content.match(UNICODE_EMOJI_REGEX)?.length ?? 0;
  return custom + unicode;
}

export function isExempt(input: AutomodMessageInput, rules: AutomodRules): boolean {
  if (rules.exemptUserIds.includes(input.authorId)) return true;
  if (rules.exemptChannelIds.includes(input.channelId)) return true;
  if (input.memberRoleIds?.some((roleId) => rules.exemptRoleIds.includes(roleId))) return true;
  return false;
}

export function evaluateAutomodMessage(
  input: AutomodMessageInput,
  rules: AutomodRules = DEFAULT_AUTOMOD_RULES,
): Violation[] {
  if (!rules.enabled) return [];
  if (isExempt(input, rules)) return [];

  const violations: Violation[] = [];
  const content = input.content ?? '';

  const blocked = countBlockedWords(content, rules);
  if (blocked.length > 0) {
    violations.push({
      kind: 'blocked_word',
      detail: `matched blocked term(s): ${blocked.join(', ')}`,
      severity: 2,
    });
  }

  if (INVITE_REGEX.test(content) && rules.blockInvites) {
    INVITE_REGEX.lastIndex = 0;
    violations.push({ kind: 'invite', detail: 'contains a Discord invite link', severity: 2 });
  }
  INVITE_REGEX.lastIndex = 0;

  if (rules.blockLinks) {
    const offending = extractDomains(content).filter(
      (domain) => !domainAllowed(domain, rules.allowedDomains),
    );
    if (offending.length > 0) {
      violations.push({
        kind: 'link',
        detail: `contains disallowed link(s): ${offending.slice(0, 3).join(', ')}`,
        severity: 1,
      });
    }
  } else if (rules.suspiciousDomains.length > 0) {
    const suspicious = extractDomains(content).filter(
      (domain) =>
        !domainAllowed(domain, rules.allowedDomains) && domainAllowed(domain, rules.suspiciousDomains),
    );
    if (suspicious.length > 0) {
      violations.push({
        kind: 'link',
        detail: `contains suspicious link(s): ${suspicious.slice(0, 3).join(', ')}`,
        severity: 2,
      });
    }
  }

  if (
    rules.capsPercent > 0 &&
    content.length >= rules.capsMinLength &&
    capsRatio(content) * 100 >= rules.capsPercent
  ) {
    violations.push({
      kind: 'caps',
      detail: `${Math.round(capsRatio(content) * 100)}% uppercase`,
      severity: 1,
    });
  }

  if (rules.maxEmojis > 0 && countEmojis(content) > rules.maxEmojis) {
    violations.push({
      kind: 'spam',
      detail: `contains ${countEmojis(content)} emojis (limit ${rules.maxEmojis})`,
      severity: 1,
    });
  }

  if (rules.blockZalgo && ZALGO_REGEX.test(content)) {
    violations.push({ kind: 'zalgo', detail: 'contains combining-character spam', severity: 2 });
  }

  const mentions = input.mentionCounts;
  if (mentions) {
    if (mentions.mentionsEveryone && rules.mentionSpamThreshold > 0) {
      violations.push({
        kind: 'mentions',
        detail: 'mentions @everyone/@here',
        severity: 3,
      });
    }
    if (rules.maxMentions > 0 && mentions.total > rules.maxMentions) {
      violations.push({
        kind: 'mentions',
        detail: `mentions ${mentions.total} users (limit ${rules.maxMentions})`,
        severity: 2,
      });
    }
    if (
      rules.mentionSpamThreshold > 0 &&
      mentions.maxForSingleUser >= rules.mentionSpamThreshold &&
      mentions.total >= rules.mentionSpamThreshold
    ) {
      violations.push({
        kind: 'mentions',
        detail: `mentions one user ${mentions.maxForSingleUser} times`,
        severity: 3,
      });
    }
  }

  const recent = input.recentMessages ?? [];
  if (rules.spamMessageLimit > 0 && recent.length + 1 > rules.spamMessageLimit) {
    const inWindow = recent.filter((msg) => input.now - msg.timestamp <= rules.spamWindowMs);
    if (inWindow.length + 1 > rules.spamMessageLimit) {
      violations.push({
        kind: 'spam',
        detail: `${inWindow.length + 1} messages in ${Math.round(rules.spamWindowMs / 1000)}s`,
        severity: 3,
      });
    }
  }

  if (rules.duplicateLimit > 0 && content.trim().length > 0) {
    const duplicates = recent.filter(
      (msg) =>
        input.now - msg.timestamp <= rules.duplicateWindowMs &&
        msg.content.trim().toLowerCase() === content.trim().toLowerCase(),
    );
    if (duplicates.length + 1 >= rules.duplicateLimit) {
      violations.push({
        kind: 'duplicate',
        detail: `repeated message ${duplicates.length + 1} times`,
        severity: 2,
      });
    }
  }

  return violations;
}

export function highestSeverity(violations: readonly Violation[]): 0 | 1 | 2 | 3 {
  return violations.reduce<0 | 1 | 2 | 3>((max, violation) => {
    return violation.severity > max ? violation.severity : max;
  }, 0);
}

/** Escalating punishment ladder used by the security + automod subsystems. */
export type PunishmentAction = 'none' | 'delete' | 'warn' | 'timeout' | 'kick' | 'ban';

export interface EscalationStep {
  /** Violation count (within the escalation window) at which this applies. */
  threshold: number;
  action: PunishmentAction;
  /** Timeout duration in ms (timeout action only). */
  durationMs?: number;
}

export const DEFAULT_ESCALATION: EscalationStep[] = [
  { threshold: 1, action: 'delete' },
  { threshold: 3, action: 'warn' },
  { threshold: 5, action: 'timeout', durationMs: 10 * 60 * 1000 },
  { threshold: 8, action: 'timeout', durationMs: 60 * 60 * 1000 },
  { threshold: 12, action: 'kick' },
  { threshold: 20, action: 'ban' },
];

export function resolveEscalation(
  violationCount: number,
  steps: readonly EscalationStep[] = DEFAULT_ESCALATION,
): EscalationStep {
  const sorted = [...steps].sort((a, b) => a.threshold - b.threshold);
  let current: EscalationStep = { threshold: 0, action: 'none' };
  for (const step of sorted) {
    if (violationCount >= step.threshold) current = step;
    else break;
  }
  return current;
}
