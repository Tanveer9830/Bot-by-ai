/**
 * `/no-pin` monitoring logic.
 *
 * HONEST SCOPE: Discord fires `ChannelPinsUpdate` *after* a pin/unpin has already
 * happened, and the audit-log entry that identifies the actor arrives
 * asynchronously. A bot therefore cannot block a pin before it occurs. This
 * module models what is genuinely possible: detect the event, resolve the actor
 * from the audit log when available, log it, alert, and (when permitted) undo
 * the pin by unpinning the message again.
 */

export type NoPinAction = 'log' | 'alert' | 'revert' | 'timeout';

export interface NoPinSettings {
  enabled: boolean;
  /** Users whose messages must not be pinned/unpinned by others. */
  protectedUserIds: string[];
  /** Alert channel id for pin security events. */
  alertChannelId?: string;
  action: NoPinAction;
  /** Roles allowed to pin freely. */
  trustedRoleIds: string[];
  /** Users allowed to pin freely. */
  trustedUserIds: string[];
  exemptChannelIds: string[];
  /** Allow the message author to pin their own message. */
  allowSelfPin: boolean;
  /** Allow moderators (Manage Messages) to pin without an alert. */
  allowModerators: boolean;
  timeoutMs: number;
}

export const DEFAULT_NO_PIN_SETTINGS: NoPinSettings = {
  enabled: false,
  protectedUserIds: [],
  action: 'alert',
  trustedRoleIds: [],
  trustedUserIds: [],
  exemptChannelIds: [],
  allowSelfPin: true,
  allowModerators: true,
  timeoutMs: 0,
};

export interface NoPinEventInput {
  /** 'pin' | 'unpin' — derived by diffing the pins cache. */
  action: 'pin' | 'unpin';
  channelId: string;
  messageId: string;
  /** Author of the pinned message, when the message is still cached/available. */
  messageAuthorId?: string;
  /** Actor resolved from the audit log; undefined when Discord did not expose it in time. */
  actorId?: string;
  actorRoleIds?: string[];
  /** Channel owner / staff context. */
  actorIsBot?: boolean;
  actorIsModerator?: boolean;
  now: number;
}

export interface NoPinDecision {
  violation: boolean;
  /** Undefined when the actor could not be resolved. */
  actorId?: string;
  reason: string;
  shouldAlert: boolean;
  shouldRevert: boolean;
  shouldTimeout: boolean;
  timeoutMs: number;
  severity: 1 | 2 | 3;
}

export function evaluateNoPin(
  input: NoPinEventInput,
  settings: NoPinSettings = DEFAULT_NO_PIN_SETTINGS,
): NoPinDecision {
  const base: NoPinDecision = {
    violation: false,
    actorId: input.actorId,
    reason: '',
    shouldAlert: false,
    shouldRevert: false,
    shouldTimeout: false,
    timeoutMs: 0,
    severity: 1,
  };

  if (!settings.enabled) return { ...base, reason: 'no-pin disabled' };
  if (settings.exemptChannelIds.includes(input.channelId)) {
    return { ...base, reason: 'channel exempt' };
  }

  const protectedTarget =
    input.messageAuthorId !== undefined &&
    settings.protectedUserIds.includes(input.messageAuthorId);

  if (!protectedTarget) {
    return { ...base, reason: 'message author is not protected' };
  }

  if (input.actorIsBot) {
    return { ...base, reason: 'actor is a bot' };
  }

  if (input.actorId === undefined) {
    // Honest handling of the audit-log race: we alert, we cannot attribute.
    return {
      ...base,
      violation: true,
      reason:
        'pin event on a protected message; the acting user could not be resolved from the audit log',
      shouldAlert: true,
      severity: settings.action === 'log' ? 1 : 2,
    };
  }

  if (settings.trustedUserIds.includes(input.actorId)) {
    return { ...base, reason: 'actor is trusted' };
  }
  if (
    input.actorRoleIds &&
    settings.trustedRoleIds.length > 0 &&
    input.actorRoleIds.some((roleId) => settings.trustedRoleIds.includes(roleId))
  ) {
    return { ...base, reason: 'actor holds a trusted role' };
  }
  if (settings.allowSelfPin && input.actorId === input.messageAuthorId) {
    return { ...base, reason: 'author pinned their own message' };
  }
  if (settings.allowModerators && input.actorIsModerator) {
    return { ...base, reason: 'actor is a moderator' };
  }

  return {
    violation: true,
    actorId: input.actorId,
    reason: `${input.actorId} ${input.action === 'pin' ? 'pinned' : 'unpinned'} a protected user's message in this channel`,
    shouldAlert: settings.action !== 'log',
    shouldRevert: settings.action === 'revert',
    shouldTimeout: settings.action === 'timeout' && settings.timeoutMs > 0,
    timeoutMs: settings.action === 'timeout' ? settings.timeoutMs : 0,
    severity: input.action === 'pin' ? 2 : 1,
  };
}

/**
 * Computes the actual change between two pin snapshots, which is what the bot
 * observes from `ChannelPinsUpdate` (Discord does not tell us which message a
 * pin event refers to, so we diff the cached pin set).
 */
export function diffPins(
  previous: readonly string[],
  next: readonly string[],
): { pinned: string[]; unpinned: string[] } {
  const before = new Set(previous);
  const after = new Set(next);
  const pinned = next.filter((id) => !before.has(id));
  const unpinned = previous.filter((id) => !after.has(id));
  if (pinned.length === 0 && unpinned.length === 0 && next.length > 0) {
    // Unknown direction (e.g. cache was cold): report both lists as empty.
    return { pinned: [], unpinned: [] };
  }
  return { pinned: [...new Set(pinned)], unpinned: [...new Set(unpinned)] };
}
