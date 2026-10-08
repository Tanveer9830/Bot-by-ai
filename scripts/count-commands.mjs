// Counts top-level slash commands exactly as Discord would see them.
//
//   npm run commands:count
//
// Requires a build first (`npm run build:packages && npm run build -w @bot-by-ai/bot`).
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const { CommandRegistry } = await import(join(repoRoot, 'apps/bot/dist/core/registry.js'));
const { createLogger } = await import(join(repoRoot, 'packages/shared/dist/index.js'));

const registry = new CommandRegistry(createLogger({ level: 'error', pretty: false }));
const { loaded, issues } = await registry.loadFrom();
const byCategory = new Map();
for (const command of registry.list()) {
  byCategory.set(command.category, (byCategory.get(command.category) ?? 0) + 1);
}

console.log(
  JSON.stringify(
    {
      loaded,
      validationIssues: issues.length,
      topLevel: registry.toJSON().length,
      discordGlobalLimit: 100,
      byCategory: Object.fromEntries([...byCategory].sort()),
    },
    null,
    2,
  ),
);

if (issues.length > 0) {
  console.error('Validation issues:', issues);
  process.exitCode = 1;
}
