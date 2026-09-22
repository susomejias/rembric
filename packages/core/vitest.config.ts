import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * The domain package's own test project — the co-located suite in this package.
 * `@rembric/core`, `@rembric/db` and `@rembric/mcp` resolve from SOURCE, exactly
 * as `apps/server`'s config resolves them, so a test can exercise the barrel
 * without `dist/` existing.
 *
 * `fileParallelism: false`: the fixture opens a real migrated SQLite file, and
 * several suites are heavy (fast-check property arms, hybrid-search embedder
 * runs).
 */
const rembricCore = fileURLToPath(new URL('./src/index.ts', import.meta.url));
const rembricDb = fileURLToPath(new URL('../db/src/index.ts', import.meta.url));
const rembricMcp = fileURLToPath(new URL('../mcp/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@rembric/core': rembricCore,
      '@rembric/db': rembricDb,
      '@rembric/mcp': rembricMcp,
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
