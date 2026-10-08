import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  MessageContextMenuCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
  UserContextMenuCommandInteraction,
} from 'discord.js';
import type { BotServices } from './context.js';
import type { CommandCategory } from './constants.js';
import type { Logger } from '@bot-by-ai/shared';

export type AnySlashBuilder =
  | SlashCommandBuilder
  | SlashCommandOptionsOnlyBuilder
  | SlashCommandSubcommandsOnlyBuilder;

export interface CommandContext {
  interaction: ChatInputCommandInteraction;
  services: BotServices;
  logger: Logger;
  /** Monotonic start time for latency reporting. */
  startedAt: number;
}

export interface AutocompleteContext {
  interaction: AutocompleteInteraction;
  services: BotServices;
}

export interface ContextMenuContext<T extends UserContextMenuCommandInteraction | MessageContextMenuCommandInteraction> {
  interaction: T;
  services: BotServices;
  logger: Logger;
}

export interface BotCommand {
  /** Builder used both for registration and for validation/de-duplication. */
  data: AnySlashBuilder;
  category: CommandCategory;
  /** Only the configured BOT_OWNER_IDS may run this. */
  ownerOnly?: boolean;
  /** Requires the command to be used inside a guild. */
  guildOnly?: boolean;
  /** Permissions the *invoking user* must have (Discord enforces this too). */
  defaultMemberPermissions?: bigint;
  /** Per-user cooldown in seconds (defaults to 3). */
  cooldownSeconds?: number;
  /** Extra cooldown key scope; defaults to guild+user. */
  cooldownScope?: 'user' | 'guild' | 'channel';
  /** If true the bot defers/replies ephemerally by default in the runner. */
  execute(context: CommandContext): Promise<void>;
  autocomplete?(context: AutocompleteContext): Promise<void>;
}

export function defineCommand(command: BotCommand): BotCommand {
  return command;
}

export function defineCommands(commands: BotCommand[]): BotCommand[] {
  return commands;
}

export interface BotContextMenuCommand {
  data: { name: string; type: number };
  category: CommandCategory;
  ownerOnly?: boolean;
  execute(context: ContextMenuContext<UserContextMenuCommandInteraction>): Promise<void>;
}

/**
 * Structural validation performed before any command is registered with Discord.
 * Discord itself would reject a bad payload, but a precise error here is far
 * easier to debug than a 400 from the API.
 */
export interface CommandValidationIssue {
  command: string;
  issue: string;
}

const NAME_REGEX = /^[\w-]{1,32}$/;

export function validateCommand(command: BotCommand): CommandValidationIssue[] {
  const issues: CommandValidationIssue[] = [];
  let json: ReturnType<AnySlashBuilder['toJSON']> | undefined;
  try {
    json = command.data.toJSON();
  } catch (error) {
    issues.push({
      command: 'unknown',
      issue: `builder threw while serialising: ${error instanceof Error ? error.message : String(error)}`,
    });
    return issues;
  }
  const name = json.name;
  if (!NAME_REGEX.test(name)) {
    issues.push({ command: name, issue: 'name must match ^[\\w-]{1,32}$ (Discord requirement)' });
  }
  if (name !== name.toLowerCase()) {
    issues.push({ command: name, issue: 'name must be lowercase' });
  }
  if (!json.description || json.description.length > 100) {
    issues.push({ command: name, issue: 'description must be 1-100 characters' });
  }
  const options = (json.options ?? []) as { type: number; name: string; options?: unknown[] }[];
  const names = new Set<string>();
  for (const option of options) {
    if (names.has(option.name)) {
      issues.push({ command: name, issue: `duplicate option name "${option.name}"` });
    }
    names.add(option.name);
  }
  if (options.length > 25) {
    issues.push({ command: name, issue: `Discord allows at most 25 top-level options (found ${options.length})` });
  }
  for (const option of options) {
    if (option.type === 1 || option.type === 2) {
      const subOptions = (option.options ?? []) as { type: number; name: string }[];
      if (subOptions.some((sub) => sub.type === 1 || sub.type === 2)) {
        issues.push({
          command: name,
          issue: `subcommand group nesting deeper than one level is not supported by Discord (${option.name})`,
        });
      }
      const subNames = new Set(subOptions.map((sub) => sub.name));
      if (subNames.size !== subOptions.length) {
        issues.push({ command: name, issue: `duplicate subcommand name inside "${option.name}"` });
      }
    }
  }
  if (typeof command.execute !== 'function') {
    issues.push({ command: name, issue: 'execute() is not implemented' });
  }
  return issues;
}

/** Discord's global application command limit (documented platform limit). */
export const GLOBAL_COMMAND_LIMIT = 100;
