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

// The Pi harness packages resolve only inside the Pi runtime, so `.pi-plugin`'s
// static imports would fail its whole test file to load. There is no other
// consumer of these specifiers in this workspace.
const piHostStub = fileURLToPath(new URL('./src/test-support/pi-host-stub.ts', import.meta.url));

// `apps/plugin`'s suite reaches into the extracted packages by the relative
// paths it has always used (`../../server/src/db/...`, `-services/...`,
// `-mcp/...`). Those files no longer live in `apps/server`, so the specifiers
// are aliased onto the packages rather than edited at every call site — the
// same aliases `apps/server/vitest.config.ts` carries for the same importers.
const rembricDbRepositories = fileURLToPath(
  new URL('../../packages/db/src/repositories/index.ts', import.meta.url),
);
const rembricDbSchemaProjects = fileURLToPath(
  new URL('../../packages/db/src/schema/projects.ts', import.meta.url),
);
const rembricCoreAgentSessions = fileURLToPath(
  new URL('../../packages/core/src/services/agent-sessions.ts', import.meta.url),
);
const rembricCoreProjects = fileURLToPath(
  new URL('../../packages/core/src/services/projects.ts', import.meta.url),
);
const rembricCoreTokens = fileURLToPath(
  new URL('../../packages/core/src/services/tokens.ts', import.meta.url),
);
const rembricMcpInstructions = fileURLToPath(
  new URL('../../packages/mcp/src/instructions.ts', import.meta.url),
);
const rembricMcpMemoryTools = fileURLToPath(
  new URL('../../packages/mcp/src/memory-tools.ts', import.meta.url),
);
const rembricMcpSessionTools = fileURLToPath(
  new URL('../../packages/mcp/src/session-tools.ts', import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: {
      // Lets unmocked '@/*' imports resolve in the node environment.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@earendil-works/pi-tui': piHostStub,
      '@earendil-works/pi-coding-agent': piHostStub,
      '@rembric/db': rembricDb,
      '@rembric/core': rembricCore,
      '@rembric/mcp': rembricMcp,
      '../../server/src/db/repositories/index.js': rembricDbRepositories,
      '../../server/src/db/schema/projects.js': rembricDbSchemaProjects,
      '../../server/src/services/agent-sessions.js': rembricCoreAgentSessions,
      '../../server/src/services/projects.js': rembricCoreProjects,
      '../../server/src/services/tokens.js': rembricCoreTokens,
      '../../server/src/mcp/instructions.js': rembricMcpInstructions,
      '../../server/src/mcp/memory-tools.js': rembricMcpMemoryTools,
      '../../server/src/mcp/session-tools.js': rembricMcpSessionTools,
    },
  },
  test: {
    environment: 'node',
    // The plugin suite boots a real `next start` (see `src/test-support/`), so
    // its files sit beside `apps/web` rather than in `apps/server`: the web app
    // is the HTTP surface they exercise.
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      '../plugin/.pi-plugin/*.test.ts',
      '../plugin/mcp-bridge/*.test.ts',
      '../plugin/test/*.test.ts',
      '../../install.test.ts',
      '../../scripts/*.test.ts',
    ],
    // `install.test.ts` and the history replay are the two the server's `test`
    // script excludes from its default run (`apps/server/package.json`); the web
    // suite runs `vitest run` with no script-level excludes, so the same pair is
    // excluded here. The history test needs a full clone and runs in its own CI
    // job; `install.test.ts` runs via `pnpm run e2e:installer`.
    exclude: [
      '**/node_modules/**',
      'dist/**',
      '../../install.test.ts',
      '../../scripts/*.history.test.ts',
    ],
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
