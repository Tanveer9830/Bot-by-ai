/**
 * `/no-tag` detection logic.
 *
 * HONEST SCOPE: a bot cannot prevent a mention from being *sent* — Discord
 * delivers the message to the gateway and clients render the ping. What the bot
 * can do (and what this module models) is detect the mention, log it, delete the
 * offending message when it has `Manage Messages`, warn/timeout the author per
 * policy, and tell the author how to reply without pinging.
 */

export type NoTagAction = 'log' | 'warn' | 'delete' | 'timeout' | 'kick';

export interface NoTagSettings {
  enabled: boolean;
  /** Users whose mentions are protected in this guild. */
  protectedUserIds: string[];
  action: NoTagAction;
  /** Timeout duration when action = 'timeout'. */
  timeoutMs: number;
  /** Warn the author in the channel before applying the action. */
  notifyAuthor: boolean;
  /** Delete the offending message when the bot has permission. */
  deleteMessage: boolean;
  /** Escalate on repeat offences. */
  escalationThreshold: number;
  /** Users exempt from the rule (staff, bots). */
  exemptUserIds: string[];
  exemptRoleIds: string[];
  exemptChannelIds: string[];
  /** Ignore mentions that appear inside a reply to the protected user. */
  allowReplies: boolean;
  /** Ignore the protected user mentioning themselves. */
  allowSelfMention: boolean;
}

export const DEFAULT_NO_TAG_SETTINGS: NoTagSettings = {
  enabled: false,
  protectedUserIds: [],
  action: 'warn',
  timeoutMs: 10 * 60 * 1000,
  notifyAuthor: true,
  deleteMessage: true,
  escalationThreshold: 3,
  exemptUserIds: [],
  exemptRoleIds: [],
  exemptChannelIds: [],
  allowReplies: true,
  allowSelfMention: true,
};

const USER_MENTION_REGEX = /<@!?(\d{17,20})>/g;

export function extractUserMentions(content: string): string[] {
  const ids: string[] = [];
  for (const match of String(content ?? '').matchAll(USER_MENTION_REGEX)) {
    const id = match[1];
    if (id) ids.push(id);
  }
  return ids;
}

export function countMentionsOf(content: string, userId: string): number {
  return extractUserMentions(content).filter((id) => id === userId).length;
}

export interface NoTagEvaluationInput {
  content: string;
  authorId: string;
  channelId: string;
  authorRoleIds: string[];
  /** User id that owns the message being replied to, if any. */
  repliedToUserId?: string;
  /** Prior violation count for this author inside the retention window. */
  priorViolations: number;
  now: number;
  settings: NoTagSettings;
}

export interface NoTagDecision {
  violation: boolean;
  mentionedProtectedUserIds: string[];
  /** Users whose mention should be actioned after exemptions are applied. */
  actionableUserIds: string[];
  reason?: string;
  severity: 1 | 2 | 3;
  shouldDelete: boolean;
  shouldWarn: boolean;
  shouldTimeout: boolean;
  timeoutMs: number;
  escalated: boolean;
}

const NO_VIOLATION: NoTagDecision = {
  violation: false,
  mentionedProtectedUserIds: [],
  actionableUserIds: [],
  severity: 1,
  shouldDelete: false,
  shouldWarn: false,
  shouldTimeout: false,
  timeoutMs: 0,
  escalated: false,
};

export function evaluateNoTag(
  input: NoTagEvaluationInput,
  settings: NoTagSettings = DEFAULT_NO_TAG_SETTINGS,
): NoTagDecision {
  if (!settings.enabled) return NO_VIOLATION;
  if (settings.protectedUserIds.length === 0) return NO_VIOLATION;
  if (settings.exemptUserIds.includes(input.authorId)) return NO_VIOLATION;
  if (settings.exemptChannelIds.includes(input.channelId)) return NO_VIOLATION;
  if (input.authorRoleIds.some((roleId) => settings.exemptRoleIds.includes(roleId))) {
    return NO_VIOLATION;
  }

  const mentions = extractUserMentions(input.content);
  const protectedMentions = mentions.filter((id) => settings.protectedUserIds.includes(id));
  if (protectedMentions.length === 0) return NO_VIOLATION;

  const actionable = protectedMentions.filter((id) => {
    if (settings.allowSelfMention && id === input.authorId) return false;
    if (settings.allowReplies && input.repliedToUserId === id) return false;
    return true;
  });

  if (actionable.length === 0) {
    return {
      ...NO_VIOLATION,
      mentionedProtectedUserIds: protectedMentions,
      reason: 'mention allowed (self-mention or reply)',
    };
  }

  const repeated = input.priorViolations + 1 >= Math.max(2, settings.escalationThreshold);
  let effectiveAction = settings.action;
  if (repeated && settings.action !== 'kick') effectiveAction = 'timeout';

  return {
    violation: true,
    mentionedProtectedUserIds: [...new Set(protectedMentions)],
    actionableUserIds: [...new Set(actionable)],
    reason: `mentioned protected user(s) ${[...new Set(actionable)].join(', ')}`,
    severity: repeated ? 3 : 2,
    shouldDelete: settings.deleteMessage || settings.action === 'delete',
    shouldWarn: settings.notifyAuthor || effectiveAction === 'warn',
    shouldTimeout: effectiveAction === 'timeout',
    timeoutMs: effectiveAction === 'timeout' ? settings.timeoutMs : 0,
    escalated: repeated,
  };
}

/**
 * Rewrites direct user mentions into non-pinging text. Used for log previews and
 * for the "resend without ping" helper offered to authors.
 */
export function neutralizeMentions(content: string, userIds?: readonly string[]): string {
  return String(content ?? '').replace(USER_MENTION_REGEX, (full, id: string) => {
    if (userIds && !userIds.includes(id)) return full;
    return `@\u200buser(${id})`;
  });
}
