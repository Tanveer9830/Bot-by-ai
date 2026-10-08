import { Permissions } from '@bot-by-ai/shared';

export const COLORS = {
  primary: 0x5865f2,
  success: 0x57f287,
  warning: 0xfee75c,
  danger: 0xed4245,
  neutral: 0x2b2d31,
  security: 0xeb459e,
  economy: 0xf1c40f,
  music: 0x9b59b6,
} as const;

export const CATEGORIES = [
  'utility',
  'moderation',
  'security',
  'automod',
  'economy',
  'levels',
  'tickets',
  'community',
  'welcome',
  'logging',
  'reaction-roles',
  'music',
  'configuration',
  'owner',
] as const;

export type CommandCategory = (typeof CATEGORIES)[number];

/**
 * Permissions the bot requires, documented so the dashboard/README can show the
 * exact invite-scope it needs (see docs/DEPLOYMENT.md).
 */
export const REQUIRED_BOT_PERMISSIONS: { name: string; bit: bigint; reason: string }[] = [
  { name: 'View Channels', bit: Permissions.ViewChannel, reason: 'read messages and channels' },
  { name: 'Send Messages', bit: Permissions.SendMessages, reason: 'respond to commands' },
  { name: 'Embed Links', bit: Permissions.EmbedLinks, reason: 'rich embeds' },
  {
    name: 'Read Message History',
    bit: Permissions.ReadMessageHistory,
    reason: 'transcripts, starboard, purge',
  },
  {
    name: 'Manage Messages',
    bit: Permissions.ManageMessages,
    reason: 'automod deletion, no-tag/no-pin mitigation',
  },
  {
    name: 'Manage Channels',
    bit: Permissions.ManageChannels,
    reason: 'ticket channels, lockdown, slowmode',
  },
  {
    name: 'Manage Roles',
    bit: Permissions.ManageRoles,
    reason: 'autoroles, role rewards, reaction roles',
  },
  { name: 'Manage Nicknames', bit: Permissions.ManageNicknames, reason: '/nickname' },
  { name: 'Kick Members', bit: Permissions.KickMembers, reason: '/kick, raid response' },
  { name: 'Ban Members', bit: Permissions.BanMembers, reason: '/ban, anti-nuke response' },
  { name: 'Moderate Members', bit: Permissions.ModerateMembers, reason: '/timeout and escalation' },
  {
    name: 'View Audit Log',
    bit: Permissions.ViewAuditLog,
    reason: 'anti-nuke attribution, pin actor resolution',
  },
  { name: 'Manage Webhooks', bit: Permissions.ManageWebhooks, reason: 'webhook monitoring' },
  { name: 'Attach Files', bit: Permissions.AttachFiles, reason: 'transcript export' },
  { name: 'Add Reactions', bit: Permissions.AddReactions, reason: 'reaction roles' },
  { name: 'Use External Emojis', bit: Permissions.UseExternalEmojis, reason: 'UI buttons' },
];

export const RECOMMENDED_PERMISSIONS_INTEGER = REQUIRED_BOT_PERMISSIONS.reduce(
  (acc, perm) => acc | perm.bit,
  0n,
);

/** Feature flags surfaced to the dashboard so it never renders dead toggles. */
export interface FeatureFlags {
  music: boolean;
  redis: boolean;
  dashboard: boolean;
  metrics: boolean;
}

/**
 * Placeholders documented for member-facing message templates.
 * Kept in sync with packages/shared/src/validation/template.ts — the renderer
 * only substitutes these, everything else is left untouched.
 */
/**
 * Log routing categories. Kept in sync with loggingSettingsSchema.channels in
 * packages/shared — every key here can be routed to its own channel.
 */
export const LOG_CATEGORIES = [
  'moderation',
  'messages',
  'members',
  'roles',
  'channels',
  'voice',
  'security',
  'economy',
  'tickets',
  'automod',
  'giveaways',
  'errors',
  'audit',
] as const;

export type LogCategory = (typeof LOG_CATEGORIES)[number];

export const WELCOME_VARIABLES: { name: string; description: string }[] = [
  { name: '{user}', description: 'Username of the member' },
  { name: '{usermention}', description: 'Mentions the member' },
  { name: '{userid}', description: 'Discord id of the member' },
  { name: '{username}', description: 'Username without discriminator' },
  { name: '{server}', description: 'Server name' },
  { name: '{serverid}', description: 'Server id' },
  { name: '{membercount}', description: 'Current member count' },
  { name: '{accountage}', description: 'Account age in days (welcome messages only)' },
  { name: '{date}', description: 'Current UTC date (YYYY-MM-DD)' },
  { name: '{time}', description: 'Current UTC time (HH:MM:SS)' },
  { name: '{timestamp}', description: 'Unix timestamp for Discord time formatting' },
];

export const INTERACTION_PREFIXES = {
  pagination: 'pag',
  confirm: 'cfm',
  ticket: 'tkt',
  giveaway: 'gw',
  reactionRole: 'rr',
  suggestion: 'sgt',
  help: 'hlp',
  rank: 'rnk',
  poll: 'pol',
  settings: 'set',
} as const;
