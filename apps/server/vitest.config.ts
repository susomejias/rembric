import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', '../plugin/.opencode-plugin/*.test.ts'],
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
      // Targets per design.md (≥ 85% / ≥ 90% statements). For v0 we
      // start lower and raise these as the suite grows so the gate moves
      // with us rather than blocking the first PRs.
      thresholds: {
        lines: 50,
        functions: 50,
        branches: 50,
        statements: 50,
      },
    },
  },
});
