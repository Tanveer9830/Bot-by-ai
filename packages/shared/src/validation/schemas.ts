/**
 * Zod contracts shared by the bot slash commands and the dashboard API routes.
 *
 * The dashboard NEVER writes settings that this module has not validated, and the
 * bot reads the same shapes back out of PostgreSQL, so both runtimes agree on the
 * exact schema of every guild setting.
 */
import { z } from 'zod';
import { SNOWFLAKE_REGEX } from '../config/env.js';
import { DEFAULT_ESCALATION } from '../automod/rules.js';

export const snowflakeSchema = z.string().regex(SNOWFLAKE_REGEX, 'must be a Discord snowflake');
export const snowflakeListSchema = z.array(snowflakeSchema).max(250);
export const hexColorSchema = z
  .union([z.string().regex(/^#?[0-9a-fA-F]{6}$/, 'must be a hex colour'), z.number().int().min(0).max(0xffffff)])
  .transform((value) => {
    if (typeof value === 'number') return value;
    return Number.parseInt(value.replace('#', ''), 16);
  });

export const escalationStepSchema = z.object({
  threshold: z.number().int().min(1).max(1000),
  action: z.enum(['none', 'delete', 'warn', 'timeout', 'kick', 'ban']),
  durationMs: z
    .number()
    .int()
    .min(0)
    .max(28 * 24 * 60 * 60 * 1000)
    .optional(),
});

export const escalationSchema = z.array(escalationStepSchema).max(20);
export const defaultEscalation = DEFAULT_ESCALATION;

/* ------------------------------------------------------------------ modules */

export const generalSettingsSchema = z.object({
  prefix: z.string().min(1).max(5).default('!'),
  locale: z.enum(['en']).default('en'),
  timezoneOffsetMinutes: z.number().int().min(-720).max(840).default(0),
  /** Command names disabled by server admins (both slash and prefix). */
  disabledCommandNames: z.array(z.string().max(32)).max(200).default([]),
  disabledModules: z.array(z.string().max(32)).max(50).default([]),
  /** Roles granted to every bot that joins the server. */
  botRoleIds: snowflakeListSchema.default([]),
  deleteCommandMessages: z.boolean().default(false),
  /** Send unexpected errors to the owners' DM (disabled by default). */
  dmErrorsToOwners: z.boolean().default(false),
});

export const welcomeSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  channelId: snowflakeSchema.nullish(),
  message: z.string().max(2000).default('Welcome {user} to **{server}**! You are member #{membercount}.'),
  /** Optional embed title; falls back to "Welcome to {server}". */
  title: z.string().max(256).nullish(),
  useEmbed: z.boolean().default(true),
  embedColor: hexColorSchema.default(0x5865f2),
  imageUrl: z.string().url().nullish(),
  thumbnail: z.boolean().default(true),
  dmEnabled: z.boolean().default(false),
  dmMessage: z.string().max(2000).nullish(),
  autoRoleIds: snowflakeListSchema.default([]),
  /** Minimum account age (days) required before the auto-role is applied. */
  minAccountAgeDays: z.number().int().min(0).max(365).default(0),
});

export const leaveSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  channelId: snowflakeSchema.nullish(),
  message: z.string().max(2000).default('**{username}** left the server.'),
  useEmbed: z.boolean().default(true),
  embedColor: hexColorSchema.default(0xed4245),
});

export const loggingSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  channels: z
    .object({
      moderation: snowflakeSchema.nullish(),
      messages: snowflakeSchema.nullish(),
      members: snowflakeSchema.nullish(),
      roles: snowflakeSchema.nullish(),
      channels: snowflakeSchema.nullish(),
      voice: snowflakeSchema.nullish(),
      security: snowflakeSchema.nullish(),
      economy: snowflakeSchema.nullish(),
      tickets: snowflakeSchema.nullish(),
      automod: snowflakeSchema.nullish(),
      giveaways: snowflakeSchema.nullish(),
      errors: snowflakeSchema.nullish(),
      audit: snowflakeSchema.nullish(),
    })
    .default({}),
  events: z.record(z.string(), z.boolean()).default({}),
  ignoreChannelIds: snowflakeListSchema.default([]),
  ignoreUserIds: snowflakeListSchema.default([]),
  /** Days to retain log rows; 0 disables automatic cleanup. */
  retentionDays: z.number().int().min(0).max(3650).default(90),
});

export const automodSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  spamMessageLimit: z.number().int().min(0).max(100).default(5),
  spamWindowMs: z.number().int().min(1000).max(300_000).default(5000),
  duplicateWindowMs: z.number().int().min(1000).max(600_000).default(30_000),
  duplicateLimit: z.number().int().min(0).max(50).default(3),
  maxMentions: z.number().int().min(0).max(100).default(6),
  capsPercent: z.number().int().min(0).max(100).default(70),
  capsMinLength: z.number().int().min(1).max(2000).default(10),
  blockedWords: z.array(z.string().min(1).max(100)).max(1000).default([]),
  blockedWordsAsRegex: z.boolean().default(false),
  blockInvites: z.boolean().default(true),
  blockLinks: z.boolean().default(false),
  allowedDomains: z.array(z.string().min(3).max(200)).max(200).default([]),
  suspiciousDomains: z.array(z.string().min(3).max(200)).max(200).default([]),
  maxEmojis: z.number().int().min(0).max(100).default(12),
  blockZalgo: z.boolean().default(true),
  mentionSpamThreshold: z.number().int().min(0).max(50).default(4),
  exemptRoleIds: snowflakeListSchema.default([]),
  exemptChannelIds: snowflakeListSchema.default([]),
  exemptUserIds: snowflakeListSchema.default([]),
  escalation: escalationSchema.default([]),
  warnOnViolation: z.boolean().default(true),
});

export const securitySettingsSchema = z.object({
  enabled: z.boolean().default(false),
  /** Anti-nuke */
  antiNuke: z
    .object({
      enabled: z.boolean().default(true),
      windowMs: z.number().int().min(5000).max(300_000).default(60_000),
      thresholds: z
        .object({
          bans: z.number().int().min(1).max(100).default(3),
          kicks: z.number().int().min(1).max(100).default(3),
          channelDeletes: z.number().int().min(1).max(100).default(3),
          roleDeletes: z.number().int().min(1).max(100).default(3),
          channelCreates: z.number().int().min(1).max(100).default(5),
          roleCreates: z.number().int().min(1).max(100).default(5),
          webhookCreates: z.number().int().min(1).max(100).default(3),
          permissionChanges: z.number().int().min(1).max(100).default(3),
          memberRoleUpdates: z.number().int().min(1).max(1000).default(10),
        })
        .default({}),
      /** What to do with a nuke: 'alert' | 'remove_roles' | 'ban' */
      response: z.enum(['alert', 'remove_roles', 'ban']).default('alert'),
      /** Automatically lock the guild down when a nuke threshold is crossed. */
      autoLockdown: z.boolean().default(true),
      lockdownMinutes: z.number().int().min(1).max(1440).default(15),
    })
    .default({}),
  antiRaid: z
    .object({
      enabled: z.boolean().default(true),
      joinsThreshold: z.number().int().min(2).max(500).default(10),
      joinsWindowMs: z.number().int().min(5000).max(600_000).default(20_000),
      minAccountAgeDays: z.number().int().min(0).max(365).default(7),
      blockNewAccounts: z.boolean().default(false),
      response: z.enum(['alert', 'lockdown', 'kick_new', 'ban_new']).default('lockdown'),
      lockdownMinutes: z.number().int().min(1).max(1440).default(10),
    })
    .default({}),
  antiSpam: z
    .object({
      enabled: z.boolean().default(false),
      messagesPerWindow: z.number().int().min(2).max(100).default(7),
      windowMs: z.number().int().min(1000).max(120_000).default(6000),
      timeoutMs: z.number().int().min(0).max(28 * 24 * 3600 * 1000).default(600_000),
    })
    .default({}),
  trustedUserIds: snowflakeListSchema.default([]),
  trustedRoleIds: snowflakeListSchema.default([]),
  whitelistChannelIds: snowflakeListSchema.default([]),
  /** Sensitive permission bits that must not be granted outside these roles/users. */
  alertChannelId: snowflakeSchema.nullish(),
  lockdown: z
    .object({
      active: z.boolean().default(false),
      until: z.number().int().nullish(),
      /** Channel ids that keep working during a lockdown. */
      allowedChannelIds: snowflakeListSchema.default([]),
      /** Role ids that keep permissions during a lockdown. */
      allowedRoleIds: snowflakeListSchema.default([]),
      reason: z.string().max(500).nullish(),
    })
    .default({}),
});

export const moderationSettingsSchema = z.object({
  dmOnAction: z.boolean().default(true),
  logChannelId: snowflakeSchema.nullish(),
  appealInstructions: z.string().max(1000).nullish(),
  escalation: escalationSchema.default([]),
  warnThresholds: z
    .object({
      timeoutAt: z.number().int().min(0).max(100).default(3),
      kickAt: z.number().int().min(0).max(100).default(5),
      banAt: z.number().int().min(0).max(100).default(7),
      timeoutMs: z.number().int().min(0).max(28 * 24 * 3600 * 1000).default(600_000),
    })
    .default({}),
  /** Warning retention in days; 0 keeps them forever. */
  caseRetentionDays: z.number().int().min(0).max(3650).default(0),
  requireReason: z.boolean().default(true),
});

export const ticketSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  categoryId: snowflakeSchema.nullish(),
  archiveCategoryId: snowflakeSchema.nullish(),
  transcriptsChannelId: snowflakeSchema.nullish(),
  supportRoleIds: snowflakeListSchema.default([]),
  logChannelId: snowflakeSchema.nullish(),
  /** Maximum concurrently open tickets per user. */
  maxOpenPerUser: z.number().int().min(1).max(10).default(1),
  /** Automatically close tickets after this many hours of inactivity (0 = never). */
  autoCloseHours: z.number().int().min(0).max(8760).default(72),
  transcriptsEnabled: z.boolean().default(true),
  ratingEnabled: z.boolean().default(true),
  welcomeMessage: z
    .string()
    .max(2000)
    .default('Thanks for opening a ticket, {user}. A member of the support team will be with you shortly.'),
  panels: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        channelId: snowflakeSchema,
        messageId: snowflakeSchema.nullish(),
        title: z.string().min(1).max(256),
        description: z.string().max(2000),
        categories: z
          .array(
            z.object({
              key: z.string().min(1).max(32),
              label: z.string().min(1).max(80),
              emoji: z.string().max(64).nullish(),
              description: z.string().max(200).nullish(),
            }),
          )
          .min(1)
          .max(5),
      }),
    )
    .max(10)
    .default([]),
});

export const economySettingsSchema = z.object({
  enabled: z.boolean().default(true),
  currencyName: z.string().min(1).max(32).default('coins'),
  currencySymbol: z.string().min(1).max(8).default('🪙'),
  dailyAmount: z.number().int().min(1).max(1_000_000).default(250),
  weeklyAmount: z.number().int().min(1).max(1_000_000).default(1500),
  workMin: z.number().int().min(1).max(1_000_000).default(50),
  workMax: z.number().int().min(1).max(1_000_000).default(200),
  workCooldownMs: z.number().int().min(60_000).max(86_400_000).default(3_600_000),
  dailyCooldownMs: z.number().int().min(3_600_000).max(604_800_000).default(86_400_000),
  weeklyCooldownMs: z.number().int().min(86_400_000).max(2_419_200_000).default(604_800_000),
  transferFeePercent: z.number().min(0).max(25).default(0),
  transferMin: z.number().int().min(1).max(1_000_000).default(1),
  transferMax: z.number().int().min(1).max(1_000_000_000).default(1_000_000),
  levelScalingPercent: z.number().min(0).max(100).default(2),
  shopEnabled: z.boolean().default(true),
  starterBalance: z.number().int().min(0).max(1_000_000).default(100),
  logTransactions: z.boolean().default(true),
});

export const levelSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  minXp: z.number().int().min(1).max(1000).default(15),
  maxXp: z.number().int().min(1).max(1000).default(25),
  cooldownMs: z.number().int().min(1000).max(600_000).default(60_000),
  stackCooldown: z.boolean().default(false),
  announceChannelId: snowflakeSchema.nullish(),
  announceDm: z.boolean().default(false),
  message: z.string().max(1000).default('🎉 {user} reached level **{level}**!'),
  multiplier: z.number().min(0.1).max(10).default(1),
  xpPerVoiceMinute: z.number().int().min(0).max(500).default(5),
  ignoredChannelIds: snowflakeListSchema.default([]),
  ignoredRoleIds: snowflakeListSchema.default([]),
  noXpRoleIds: snowflakeListSchema.default([]),
  /** Role rewards: level -> roleId (highest eligible role wins). */
  roleRewards: z
    .array(z.object({ level: z.number().int().min(1).max(500), roleId: snowflakeSchema }))
    .max(50)
    .default([]),
  levelMultiplierRoleIds: z
    .array(z.object({ roleId: snowflakeSchema, multiplier: z.number().min(1).max(5) }))
    .max(25)
    .default([]),
  maxLevel: z.number().int().min(1).max(500).default(200),
});

export const musicSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  defaultVolume: z.number().int().min(1).max(200).default(80),
  maxVolume: z.number().int().min(1).max(200).default(150),
  djRoleIds: snowflakeListSchema.default([]),
  djOnly: z.boolean().default(false),
  maxQueueSize: z.number().int().min(1).max(1000).default(100),
  announceNowPlaying: z.boolean().default(true),
  /** User ids or role names allowed to control the player. */
  allowSpotifyLinks: z.boolean().default(true),
  twentyFourSeven: z.boolean().default(false),
});

export const noTagSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  protectedUserIds: snowflakeListSchema.default([]),
  action: z.enum(['log', 'warn', 'delete', 'timeout', 'kick']).default('warn'),
  timeoutMs: z.number().int().min(0).max(28 * 24 * 3600 * 1000).default(600_000),
  notifyAuthor: z.boolean().default(true),
  deleteMessage: z.boolean().default(true),
  escalationThreshold: z.number().int().min(2).max(20).default(3),
  exemptUserIds: snowflakeListSchema.default([]),
  exemptRoleIds: snowflakeListSchema.default([]),
  exemptChannelIds: snowflakeListSchema.default([]),
  allowReplies: z.boolean().default(true),
  allowSelfMention: z.boolean().default(true),
  logChannelId: snowflakeSchema.nullish(),
});

export const noPinSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  protectedUserIds: snowflakeListSchema.default([]),
  alertChannelId: snowflakeSchema.nullish(),
  action: z.enum(['log', 'alert', 'revert', 'timeout']).default('alert'),
  trustedRoleIds: snowflakeListSchema.default([]),
  trustedUserIds: snowflakeListSchema.default([]),
  exemptChannelIds: snowflakeListSchema.default([]),
  allowSelfPin: z.boolean().default(true),
  allowModerators: z.boolean().default(true),
  timeoutMs: z.number().int().min(0).max(28 * 24 * 3600 * 1000).default(0),
});

export const giveawaySettingsSchema = z.object({
  enabled: z.boolean().default(true),
  defaultDurationMs: z.number().int().min(60_000).max(30 * 86_400_000).default(86_400_000),
  maxWinners: z.number().int().min(1).max(100).default(10),
  winnerDmEnabled: z.boolean().default(true),
  requireRoleId: snowflakeSchema.nullish(),
  minAccountAgeDays: z.number().int().min(0).max(365).default(0),
  bonusRoleIds: snowflakeListSchema.default([]),
  logChannelId: snowflakeSchema.nullish(),
});

export const suggestionSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  channelId: snowflakeSchema.nullish(),
  logChannelId: snowflakeSchema.nullish(),
  anonymous: z.boolean().default(false),
  upvoteEmoji: z.string().max(64).default('👍'),
  downvoteEmoji: z.string().max(64).default('👎'),
  threadEnabled: z.boolean().default(true),
  staffRoleIds: snowflakeListSchema.default([]),
});

export const reactionRoleSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  panels: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        channelId: snowflakeSchema,
        messageId: snowflakeSchema.nullish(),
        /** 'reaction' | 'button' | 'select' */
        mode: z.enum(['reaction', 'button', 'select']).default('button'),
        title: z.string().min(1).max(256),
        description: z.string().max(2000).nullish(),
        options: z
          .array(
            z.object({
              label: z.string().min(1).max(80),
              roleId: snowflakeSchema,
              emoji: z.string().max(64).nullish(),
              description: z.string().max(100).nullish(),
            }),
          )
          .min(1)
          .max(25),
        /** Only one role from this panel may be held at a time. */
        exclusive: z.boolean().default(false),
      }),
    )
    .max(25)
    .default([]),
});

export const starboardSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  channelId: snowflakeSchema.nullish(),
  emoji: z.string().max(64).default('⭐'),
  threshold: z.number().int().min(1).max(100).default(3),
  selfStar: z.boolean().default(false),
  ignoreChannelIds: snowflakeListSchema.default([]),
});

export const birthdaySettingsSchema = z.object({
  enabled: z.boolean().default(false),
  channelId: snowflakeSchema.nullish(),
  message: z.string().max(1000).default('🎂 Happy birthday {user}!'),
  timezoneOffsetMinutes: z.number().int().min(-720).max(840).default(0),
  roleId: snowflakeSchema.nullish(),
});

export const brandingSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  /** Conservative by default: the bot never reacts to every message unless enabled. */
  reactToEveryMessage: z.boolean().default(false),
  everyMessageChance: z.number().min(0).max(1).default(0.05),
  everyMessageTemplates: z.array(z.string().max(500)).max(25).default([]),
  channelTemplates: z
    .array(
      z.object({
        channelId: snowflakeSchema,
        templates: z.array(z.string().max(500)).min(1).max(25),
        /** Minimum seconds between responses in that channel. */
        cooldownSeconds: z.number().int().min(5).max(3600).default(60),
      }),
    )
    .max(50)
    .default([]),
  exemptChannelIds: snowflakeListSchema.default([]),
  exemptUserIds: snowflakeListSchema.default([]),
  embedColor: hexColorSchema.default(0x5865f2),
  footerText: z.string().max(200).nullish(),
  /** Daily cap per channel to hard-stop any runaway loop. */
  dailyCapPerChannel: z.number().int().min(1).max(10_000).default(50),
});

export const welcomeBrandingSchema = z.object({
  welcomeFooter: z.string().max(200).nullish(),
  announcementColor: hexColorSchema.default(0x5865f2),
  announcementFooter: z.string().max(200).nullish(),
});

/* --------------------------------------------------------- custom commands */

export const customCommandActionSchema = z.object({
  type: z.enum(['add_role', 'remove_role', 'send_dm', 'reply_ephemeral']),
  roleId: snowflakeSchema.optional(),
  message: z.string().max(1500).optional(),
});

export const customCommandEmbedSchema = z.object({
  title: z.string().max(256).nullish(),
  description: z.string().max(4000).nullish(),
  color: hexColorSchema.nullish(),
  footer: z.string().max(200).nullish(),
  thumbnailUrl: z.string().url().nullish(),
  imageUrl: z.string().url().nullish(),
  fields: z
    .array(
      z.object({
        name: z.string().min(1).max(256),
        value: z.string().min(1).max(1024),
        inline: z.boolean().default(false),
      }),
    )
    .max(25)
    .default([]),
});

/** Server-scoped custom command payload (server admins). */
export const customCommandSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9][a-z0-9-_]*$/, 'use lowercase letters, numbers, dashes and underscores only'),
  description: z.string().min(1).max(100),
  response: z.string().max(4000).default(''),
  embed: customCommandEmbedSchema.nullish(),
  actions: z.array(customCommandActionSchema).max(5).default([]),
  enabled: z.boolean().default(true),
  ephemeral: z.boolean().default(false),
  requiredRoleIds: snowflakeListSchema.default([]),
  allowedChannelIds: snowflakeListSchema.default([]),
  allowedUserIds: snowflakeListSchema.default([]),
  cooldownSeconds: z.number().int().min(0).max(86_400).default(3),
  deleteTrigger: z.boolean().default(false),
});

export type CustomCommandInput = z.infer<typeof customCommandSchema>;

/** Global custom commands are owner-only and follow the same safe shape. */
export const globalCommandSchema = customCommandSchema.extend({
  published: z.boolean().default(false),
});

export type GlobalCommandInput = z.infer<typeof globalCommandSchema>;

/* ------------------------------------------------------------------ exports */

export const boostSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  channelId: snowflakeSchema.nullish(),
  message: z.string().max(2000).default('🚀 {user} just boosted **{server}** — thank you!'),
  useEmbed: z.boolean().default(true),
  embedColor: hexColorSchema.default(0xf47fff),
  /** Temporary role granted while the boost is active. */
  roleId: snowflakeSchema.nullish(),
  dmEnabled: z.boolean().default(false),
  dmMessage: z.string().max(2000).nullish(),
});

export const MODULE_SCHEMAS = {
  general: generalSettingsSchema,
  welcome: welcomeSettingsSchema,
  leave: leaveSettingsSchema,
  boost: boostSettingsSchema,
  logging: loggingSettingsSchema,
  automod: automodSettingsSchema,
  security: securitySettingsSchema,
  moderation: moderationSettingsSchema,
  tickets: ticketSettingsSchema,
  economy: economySettingsSchema,
  levels: levelSettingsSchema,
  music: musicSettingsSchema,
  notag: noTagSettingsSchema,
  nopin: noPinSettingsSchema,
  giveaways: giveawaySettingsSchema,
  suggestions: suggestionSettingsSchema,
  reactionRoles: reactionRoleSettingsSchema,
  starboard: starboardSettingsSchema,
  birthday: birthdaySettingsSchema,
  branding: brandingSettingsSchema,
  welcomeBranding: welcomeBrandingSchema,
} as const;

export type ModuleName = keyof typeof MODULE_SCHEMAS;

export const MODULE_NAMES = Object.keys(MODULE_SCHEMAS) as ModuleName[];

export const moduleSettingsSchema = z.object({
  module: z.enum(MODULE_NAMES as [ModuleName, ...ModuleName[]]),
  values: z.record(z.string(), z.unknown()),
});

export function validateModuleSettings(
  module: string,
  values: Record<string, unknown>,
):
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; errors: { path: string; message: string }[] } {
  if (!(module in MODULE_SCHEMAS)) {
    return { ok: false, errors: [{ path: 'module', message: `unknown settings module "${module}"` }] };
  }
  const schema = MODULE_SCHEMAS[module as ModuleName];
  const parsed = schema.partial().safeParse(values);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    };
  }
  return { ok: true, data: parsed.data as Record<string, unknown> };
}

/** Defaults for a module, used when a guild has no row yet. */
export function moduleDefaults(module: ModuleName): Record<string, unknown> {
  const parsed = MODULE_SCHEMAS[module].safeParse({});
  return parsed.success ? (parsed.data as Record<string, unknown>) : {};
}
