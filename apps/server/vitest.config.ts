import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // install.test.ts stays here so `vitest run ../../install.test.ts` (the
    // e2e:installer step) can find it — a positional filter can only narrow
    // an already-included file, not add one. The default `test`/
    // `test:coverage` scripts pass `--exclude '../../install.test.ts'` so it
    // runs exactly once per CI run, via e2e:installer only.
    include: ['src/**/*.test.ts', '../plugin/.opencode-plugin/*.test.ts', '../../install.test.ts'],
    exclude: ['**/node_modules/**', 'dist/**'],
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/server-entrypoint.ts',
        'src/test/**',
        'src/**/*.test.ts',
        'src/db/migrations/**',
        'src/db/schema/index.ts',
        'src/server/index.ts',
        'src/llm/index.ts',
        'src/mcp/index.ts',
        'src/consolidation/index.ts',
        'src/services/index.ts',
        'src/db/index.ts',
      ],
      // Enforced floor, rounded down from measured coverage. Up-only
      // ratchet: raise as the suite grows, never lower to pass a PR.
      thresholds: {
        lines: 85,
        functions: 91,
        branches: 78,
        statements: 85,
      },
    },
  },
});
