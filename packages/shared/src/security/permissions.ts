/**
 * Permission math and moderation hierarchy rules.
 *
 * Implemented without importing discord.js so that the dashboard (a separate
 * runtime) can reuse the exact same authorization logic that the bot applies.
 */

export const Permissions = {
  CreateInstantInvite: 1n << 0n,
  KickMembers: 1n << 1n,
  BanMembers: 1n << 2n,
  Administrator: 1n << 3n,
  ManageChannels: 1n << 4n,
  ManageGuild: 1n << 5n,
  AddReactions: 1n << 6n,
  ViewAuditLog: 1n << 7n,
  PrioritySpeaker: 1n << 8n,
  Stream: 1n << 9n,
  ViewChannel: 1n << 10n,
  SendMessages: 1n << 11n,
  SendTtsMessages: 1n << 12n,
  ManageMessages: 1n << 13n,
  EmbedLinks: 1n << 14n,
  AttachFiles: 1n << 15n,
  ReadMessageHistory: 1n << 16n,
  MentionEveryone: 1n << 17n,
  UseExternalEmojis: 1n << 18n,
  ViewGuildInsights: 1n << 19n,
  Connect: 1n << 20n,
  Speak: 1n << 21n,
  MuteMembers: 1n << 22n,
  DeafenMembers: 1n << 23n,
  MoveMembers: 1n << 24n,
  UseVad: 1n << 25n,
  ChangeNickname: 1n << 26n,
  ManageNicknames: 1n << 27n,
  ManageRoles: 1n << 28n,
  ManageWebhooks: 1n << 29n,
  ManageGuildExpressions: 1n << 30n,
  UseApplicationCommands: 1n << 31n,
  RequestToSpeak: 1n << 32n,
  ManageEvents: 1n << 33n,
  ManageThreads: 1n << 34n,
  CreatePublicThreads: 1n << 35n,
  CreatePrivateThreads: 1n << 36n,
  UseExternalStickers: 1n << 37n,
  SendMessagesInThreads: 1n << 38n,
  UseEmbeddedActivities: 1n << 39n,
  ModerateMembers: 1n << 40n,
  ViewCreatorMonetizationAnalytics: 1n << 41n,
  UseSoundboard: 1n << 42n,
  CreateGuildExpressions: 1n << 43n,
  CreateEvents: 1n << 44n,
  UseExternalSounds: 1n << 45n,
  SendVoiceMessages: 1n << 46n,
} as const;

export type PermissionName = keyof typeof Permissions;

export function permissionNamesToBits(names: readonly PermissionName[]): bigint {
  return names.reduce((acc, name) => acc | Permissions[name], 0n);
}

/** Discord's `Administrator` implies every other permission. */
export function hasPermission(bits: bigint, required: bigint | readonly PermissionName[]): boolean {
  const need = Array.isArray(required) ? permissionNamesToBits(required) : (required as bigint);
  if ((bits & Permissions.Administrator) !== 0n) return true;
  return (bits & need) === need;
}

export function missingPermissions(
  bits: bigint,
  required: readonly PermissionName[],
): PermissionName[] {
  if ((bits & Permissions.Administrator) !== 0n) return [];
  return required.filter((name) => (bits & Permissions[name]) === 0n);
}

export interface HierarchyInput {
  /** The user or bot performing the action. */
  actor: {
    id: string;
    /** Highest role position owned by the actor (0 for @everyone only). */
    highestRolePosition: number;
    isGuildOwner?: boolean;
    isBotOwner?: boolean;
  };
  /** The member being acted upon. */
  target: {
    id: string;
    highestRolePosition: number;
    isGuildOwner?: boolean;
    isBot?: boolean;
  };
  /** The bot performing the action (for role/hierarchy checks). */
  bot?: {
    id: string;
    highestRolePosition: number;
    isGuildOwner?: boolean;
  };
  guildOwnerId?: string;
}

export interface HierarchyDecision {
  allowed: boolean;
  reason?: string;
  code?: 'SELF_TARGET' | 'TARGET_IS_ACTOR_SUPERIOR' | 'BOT_HIERARCHY' | 'GUILD_OWNER' | 'TARGET_IS_BOT';
}

/**
 * Universal safeguard for destructive moderation actions
 * (ban, kick, timeout, role changes, nickname changes).
 */
export function checkModerationHierarchy(input: HierarchyInput): HierarchyDecision {
  const { actor, target, bot } = input;

  if (actor.id === target.id) {
    return { allowed: false, code: 'SELF_TARGET', reason: 'You cannot perform this action on yourself.' };
  }

  if (bot) {
    if (bot.id === target.id) {
      return { allowed: false, code: 'TARGET_IS_BOT', reason: 'I cannot perform this action on myself.' };
    }
    // A bot can never act on a member whose top role is >= its own top role.
    if (!bot.isGuildOwner && target.highestRolePosition >= bot.highestRolePosition) {
      return {
        allowed: false,
        code: 'BOT_HIERARCHY',
        reason:
          'That member has a role equal to or higher than my highest role, so Discord will reject the action.',
      };
    }
  }

  // Guild owner can act on anyone except themselves (handled above).
  if (actor.isGuildOwner) return { allowed: true };

  if (target.isGuildOwner) {
    return { allowed: false, code: 'GUILD_OWNER', reason: 'The server owner cannot be moderated by the bot.' };
  }

  if (target.highestRolePosition >= actor.highestRolePosition) {
    return {
      allowed: false,
      code: 'TARGET_IS_ACTOR_SUPERIOR',
      reason: 'That member has a role equal to or higher than your highest role.',
    };
  }

  return { allowed: true };
}

/** A target is "protected" when it is a role/id in the trusted or exempt list. */
export function isTrustedOrExempt(
  id: string,
  exempt: { userIds?: readonly string[]; roleIds?: readonly string[]; memberRoleIds?: readonly string[] },
): boolean {
  if (exempt.userIds?.includes(id)) return true;
  if (exempt.roleIds && exempt.memberRoleIds) {
    return exempt.memberRoleIds.some((roleId) => exempt.roleIds?.includes(roleId));
  }
  return false;
}
