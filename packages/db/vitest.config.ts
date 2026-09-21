import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * The data package's own test project — the first co-located suite in this
 * package. `@rembric/db` resolves from SOURCE, exactly as `apps/web`'s config
 * resolves it, so a test can exercise the barrel without `dist/` existing.
 *
 * `fileParallelism: false`: the fixture opens a real migrated SQLite file.
 */
const rembricDb = fileURLToPath(new URL('./src/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@rembric/db': rembricDb,
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
