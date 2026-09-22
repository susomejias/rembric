import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * The data package's own test project — the co-located suite in this package.
 * `@rembric/db` and `@rembric/core` resolve from SOURCE, exactly as
 * `apps/web`'s config resolves them, so a test can exercise the barrel without
 * `dist/` existing.
 *
 * `@rembric/core` is needed because some repository and migration tests drive
 * the domain services that sit above the data layer (`MemoryService`,
 * `AgentSessionsService`, `deriveTitle`). `packages/db/package.json` cannot
 * declare it — `@rembric/core` already depends on `@rembric/db`, and a declared
 * back-edge would close a cycle in Turborepo's build graph — so the same
 * source-level alias `apps/web` uses keeps the test-only dependency resolvable.
 *
 * `fileParallelism: false`: the fixture opens a real migrated SQLite file.
 */
const rembricDb = fileURLToPath(new URL('./src/index.ts', import.meta.url));
const rembricCore = fileURLToPath(new URL('../core/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
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
