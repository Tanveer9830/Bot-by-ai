/**
 * Bot-side view of the settings modules.
 *
 * These mirror the zod schemas in @bot-by-ai/shared/validation/schemas.ts —
 * the shared package owns validation, this file only derives the types so the
 * bot never re-declares settings shapes.
 */
import type { z } from 'zod';
import {
  automodSettingsSchema,
  birthdaySettingsSchema,
  boostSettingsSchema,
  brandingSettingsSchema,
  economySettingsSchema,
  generalSettingsSchema,
  giveawaySettingsSchema,
  leaveSettingsSchema,
  levelSettingsSchema,
  loggingSettingsSchema,
  moderationSettingsSchema,
  musicSettingsSchema,
  noPinSettingsSchema,
  noTagSettingsSchema,
  reactionRoleSettingsSchema,
  securitySettingsSchema,
  starboardSettingsSchema,
  suggestionSettingsSchema,
  ticketSettingsSchema,
  welcomeSettingsSchema,
} from '@bot-by-ai/shared';

export type GeneralSettings = z.infer<typeof generalSettingsSchema>;
export type WelcomeSettings = z.infer<typeof welcomeSettingsSchema>;
export type LeaveSettings = z.infer<typeof leaveSettingsSchema>;
export type BoostSettings = z.infer<typeof boostSettingsSchema>;
export type LoggingSettings = z.infer<typeof loggingSettingsSchema>;
export type AutomodSettings = z.infer<typeof automodSettingsSchema>;
export type SecuritySettings = z.infer<typeof securitySettingsSchema>;
export type ModerationSettings = z.infer<typeof moderationSettingsSchema>;
export type TicketSettings = z.infer<typeof ticketSettingsSchema>;
export type EconomySettings = z.infer<typeof economySettingsSchema>;
export type LevelSettings = z.infer<typeof levelSettingsSchema>;
export type MusicSettings = z.infer<typeof musicSettingsSchema>;
export type NoTagSettings = z.infer<typeof noTagSettingsSchema>;
export type NoPinSettings = z.infer<typeof noPinSettingsSchema>;
export type GiveawaySettings = z.infer<typeof giveawaySettingsSchema>;
export type SuggestionSettings = z.infer<typeof suggestionSettingsSchema>;
export type ReactionRoleSettings = z.infer<typeof reactionRoleSettingsSchema>;
export type StarboardSettings = z.infer<typeof starboardSettingsSchema>;
export type BirthdaySettings = z.infer<typeof birthdaySettingsSchema>;
export type BrandingSettings = z.infer<typeof brandingSettingsSchema>;
