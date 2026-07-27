import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // install.test.ts stays here so `vitest run ../../install.test.ts` (the
    // e2e:installer step) can find it — a positional filter can only narrow
    // an already-included file, not add one. The default `test`/
    // `test:coverage` scripts pass `--exclude '../../install.test.ts'` so it
    // runs exactly once per CI run, via e2e:installer only.
    include: [
      'src/**/*.test.ts',
      '../plugin/.opencode-plugin/*.test.ts',
      '../plugin/test/*.test.ts',
      '../../install.test.ts',
      '../../scripts/*.test.ts',
    ],
    exclude: ['**/node_modules/**', 'dist/**'],
    testTimeout: 15_000,
    // Run test files sequentially. The real-server integration tests
    // (mcp-integration) drive an MCP roots-discovery `listRoots` SSE round
    // trip on a 1s budget; running ~75 files across parallel workers starves
    // that server's event loop under CPU pressure, so the round trip loses the
    // race and discovery falls back to global — a flaky failure unrelated to
    // product behavior. Serial execution removes the starvation. The server
    // suite is small, so the wall-clock cost is modest.
    fileParallelism: false,
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
