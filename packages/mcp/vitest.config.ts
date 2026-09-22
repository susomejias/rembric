import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * The protocol package's own test project — the co-located suite in this package.
 * `@rembric/mcp`, `@rembric/db` and `@rembric/core` resolve from SOURCE, exactly
 * as `apps/server`'s config resolves them, so a test can exercise the barrel
 * without `dist/` existing. Mirrors `packages/db`'s and `packages/core`'s own
 * test projects.
 *
 * `fileParallelism: false`: the fixture opens a real migrated SQLite file.
 */
const rembricMcp = fileURLToPath(new URL('./src/index.ts', import.meta.url));
const rembricDb = fileURLToPath(new URL('../db/src/index.ts', import.meta.url));
const rembricCore = fileURLToPath(new URL('../core/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@rembric/mcp': rembricMcp,
      '@rembric/db': rembricDb,
      '@rembric/core': rembricCore,
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
