import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { Logger } from '@bot-by-ai/shared';
import { type BotCommand, type CommandValidationIssue, validateCommand } from './command.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Command discovery + validation.
 *
 * Commands live in `src/commands/*.ts`, each module exporting `commands`.
 * The registry loads them via dynamic import (works for both tsx and compiled
 * dist), validates each definition against Discord's documented limits, and
 * refuses to start with duplicate names rather than silently dropping commands.
 */
export class CommandRegistry {
  private readonly commands = new Map<string, BotCommand>();
  private readonly issues: CommandValidationIssue[] = [];

  constructor(private readonly logger: Logger) {}

  get size(): number {
    return this.commands.size;
  }

  list(): BotCommand[] {
    return [...this.commands.values()].sort((a, b) => a.data.toJSON().name.localeCompare(b.data.toJSON().name));
  }

  get(name: string): BotCommand | undefined {
    return this.commands.get(name);
  }

  get validationIssues(): CommandValidationIssue[] {
    return [...this.issues];
  }

  register(command: BotCommand): void {
    const name = command.data.toJSON().name;
    if (this.commands.has(name)) {
      throw new Error(`duplicate command name "${name}" — command names must be unique`);
    }
    this.commands.set(name, command);
  }

  async loadFrom(directory?: string): Promise<{ loaded: number; issues: CommandValidationIssue[] }> {
    const base = directory ?? resolve(here, '../commands');
    const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
    const files = entries
      .filter((entry) => entry.isFile() && /\.(ts|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts'))
      .map((entry) => entry.name)
      .sort();

    for (const file of files) {
      const modulePath = pathToFileURL(join(base, file)).href;
      try {
        const mod = (await import(modulePath)) as { commands?: BotCommand[]; default?: BotCommand[] };
        const exported = mod.commands ?? mod.default ?? [];
        if (!Array.isArray(exported) || exported.length === 0) {
          this.logger.warn('command module exported no commands', { file });
          continue;
        }
        for (const command of exported) {
          const issues = validateCommand(command);
          if (issues.length > 0) {
            this.issues.push(...issues);
            this.logger.error('command failed validation and was skipped', { file, issues });
            continue;
          }
          this.register(command);
        }
      } catch (error) {
        this.issues.push({ command: file, issue: error instanceof Error ? error.message : String(error) });
        this.logger.error('failed to load command module', {
          file,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { loaded: this.commands.size, issues: this.validationIssues };
  }

  /** Raw payloads for Discord's command registration endpoint. */
  toJSON(): unknown[] {
    return this.list().map((command) => command.data.toJSON());
  }
}
