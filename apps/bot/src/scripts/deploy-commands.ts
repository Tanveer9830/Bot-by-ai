#!/usr/bin/env node
/**
 * Slash-command deployment.
 *
 *   npm run deploy:commands            # development: guild-scoped (instant)
 *   npm run deploy:commands -- --global  # production: global (up to 1h to propagate)
 *   npm run deploy:commands -- --clear --global
 *
 * Guild registration is used in development because global command updates are
 * rate-limited and slow to propagate. Registration is never run implicitly on
 * every bot start (that would be wasteful and hit rate limits).
 */
import { REST, Routes } from 'discord.js';
import { createLogger, loadConfig } from '@bot-by-ai/shared';
import { CommandRegistry } from '../core/registry.js';
import { GLOBAL_COMMAND_LIMIT } from '../core/command.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const useGlobal = args.includes('--global');
  const clear = args.includes('--clear');
  const dryRun = args.includes('--dry-run');

  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, pretty: !config.isProduction });
  const registry = new CommandRegistry(logger);
  const { loaded, issues } = await registry.loadFrom();

  logger.info('commands loaded', { loaded, validationIssues: issues.length });
  for (const issue of issues) logger.warn('validation issue', { ...issue });

  const payload = registry.toJSON() as { name: string; description: string }[];
  if (useGlobal && payload.length > GLOBAL_COMMAND_LIMIT) {
    logger.error('refusing to register: exceeds Discord global command limit', {
      count: payload.length,
      limit: GLOBAL_COMMAND_LIMIT,
    });
    process.exit(1);
  }

  const target = useGlobal ? 'global' : `guild ${config.devGuildId ?? '(DEV_GUILD_ID not set)'}`;
  if (!useGlobal && !config.devGuildId) {
    logger.error('DEV_GUILD_ID is required for guild-scoped registration; use --global for production');
    process.exit(1);
  }

  logger.info('deployment target', { target, commandCount: payload.length });
  for (const command of payload) logger.debug(`  • /${command.name} — ${command.description}`);

  if (dryRun) {
    logger.info('dry run complete — nothing was sent to Discord');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(config.discord.token);
  const route = useGlobal
    ? Routes.applicationCommands(config.discord.clientId)
    : Routes.applicationGuildCommands(config.discord.clientId, config.devGuildId as string);

  if (clear) {
    await rest.put(route, { body: [] });
    logger.info('cleared registered commands', { target });
    return;
  }

  const result = (await rest.put(route, { body: payload })) as unknown[];
  logger.info('commands registered', { target, count: result.length });
}

main().catch((error) => {
  console.error(`command deployment failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
