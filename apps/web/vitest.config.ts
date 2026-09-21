import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * The web app's test project. It is deliberately minimal: everything under test
 * here (`lib/actions/guard.ts`, `lib/session.ts` and the service graph below
 * them) is plain Node, so there is no DOM environment to configure and no
 * component rendering harness.
 *
 * The three workspace packages resolve from SOURCE, exactly as
 * `apps/server/vitest.config.ts` resolves them, and for the same reason: CI runs
 * the suite before anything is built, so `dist/` may not exist yet — and when it
 * does exist it can be a build behind the working tree. `@rembric/core`'s own
 * `@rembric/db` imports go through the same alias.
 *
 * `fileParallelism: false` mirrors the server suite: the fixtures here open real
 * migrated SQLite files, and the tests inside `src/test/` share one.
 */
const rembricDb = fileURLToPath(new URL('../../packages/db/src/index.ts', import.meta.url));
const rembricCore = fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url));
const rembricMcp = fileURLToPath(new URL('../../packages/mcp/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@rembric/db': rembricDb,
      '@rembric/core': rembricCore,
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
