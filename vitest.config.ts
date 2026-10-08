import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] })],
  test: {
    globals: false,
    environment: 'node',
    include: [
      'tests/**/*.test.ts',
      'packages/**/tests/**/*.test.ts',
      'apps/**/tests/**/*.test.ts',
      'apps/dashboard/lib/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts', 'apps/bot/src/**/*.ts', 'apps/dashboard/lib/**/*.ts'],
      exclude: ['**/*.d.ts', '**/*.test.ts'],
    },
    testTimeout: 20_000,
  },
});
