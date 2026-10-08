// Counts top-level slash commands exactly as Discord would see them.
const { CommandRegistry } = await import('./apps/bot/dist/core/registry.js');
const { createLogger } = await import('./packages/shared/dist/index.js');
const registry = new CommandRegistry(createLogger({ level: 'error', pretty: false }));
const { loaded, issues } = await registry.loadFrom();
const json = registry.toJSON();
const byCategory = new Map();
for (const c of registry.list()) byCategory.set(c.category, (byCategory.get(c.category) ?? 0) + 1);
console.log(JSON.stringify({ loaded, validationIssues: issues.length, topLevel: json.length, byCategory: Object.fromEntries([...byCategory].sort()) }, null, 2));
