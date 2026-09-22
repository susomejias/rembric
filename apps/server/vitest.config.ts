import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const piHostStub = fileURLToPath(new URL('./src/test/pi-host-stub.ts', import.meta.url));

// The extracted data layer lives in its own workspace package. Tests resolve it
// from SOURCE (the package's `dist/` does not exist before the build step, and
// CI runs the suite before it builds), which is also the layout the package's
// own type-check uses via `paths` in tsconfig.json.
const rembricDb = fileURLToPath(new URL('../../packages/db/src/index.ts', import.meta.url));

// `apps/plugin/.pi-plugin/plugin.test.ts` reaches into the data layer by
// relative path (`../../server/src/db/...`). That file is outside this task's
// edit surfaces, so the two specifiers it uses are aliased onto the package
// rather than edited there; whichever change owns that file should switch it to
// `@rembric/db` and delete these two entries. Its 80 tests are part of this
// suite's count, so dropping them is not an option.
const rembricDbRepositories = fileURLToPath(
  new URL('../../packages/db/src/repositories/index.ts', import.meta.url),
);
const rembricDbSchemaProjects = fileURLToPath(
  new URL('../../packages/db/src/schema/projects.ts', import.meta.url),
);

// The domain layer, same rule as the data layer above: tests resolve it from
// SOURCE, because CI runs the suite BEFORE it builds anything.
const rembricCore = fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url));

// `apps/plugin/.pi-plugin/plugin.test.ts` reaches into the domain layer by
// relative path (`../../server/src/services/...`). That file is outside this
// task's edit surfaces, so the three specifiers it uses are aliased onto the
// package rather than edited there; whichever change owns that file should
// switch them to `@rembric/core` and delete these three entries. Its 80 tests
// are part of this suite's count, so dropping them is not an option.
const rembricCoreAgentSessions = fileURLToPath(
  new URL('../../packages/core/src/services/agent-sessions.ts', import.meta.url),
);
const rembricCoreProjects = fileURLToPath(
  new URL('../../packages/core/src/services/projects.ts', import.meta.url),
);
const rembricCoreTokens = fileURLToPath(
  new URL('../../packages/core/src/services/tokens.ts', import.meta.url),
);

// The protocol layer, same rule again: tests resolve it from SOURCE, because CI
// runs the suite BEFORE it builds anything. Its co-located tests moved to
// `src/test/mcp/` (they import app-side fixtures), so every one of them reaches
// the package through this alias — and so does the application's own suite.
const rembricMcp = fileURLToPath(new URL('../../packages/mcp/src/index.ts', import.meta.url));

// `apps/plugin/.pi-plugin/plugin.test.ts` reaches into the protocol layer by
// relative path (`../../server/src/mcp/instructions.js`). Same rule as the two
// blocks above: that file is outside this task's edit surfaces, so the one
// specifier it uses is aliased onto the package rather than edited there;
// whichever change owns that file should switch it to `@rembric/mcp` and delete
// this entry.
const rembricMcpInstructions = fileURLToPath(
  new URL('../../packages/mcp/src/instructions.ts', import.meta.url),
);

// `apps/plugin/test/command-arguments.test.ts` reaches into the protocol layer
// the same way, for the command-facing tool schemas. Same rule again: aliased
// rather than edited, because that tree belongs to another change.
const rembricMcpMemoryTools = fileURLToPath(
  new URL('../../packages/mcp/src/memory-tools.ts', import.meta.url),
);
const rembricMcpSessionTools = fileURLToPath(
  new URL('../../packages/mcp/src/session-tools.ts', import.meta.url),
);

// `mkdtemp` does not create parent directories, so pointing TMPDIR at a path
// that does not exist yet fails every fixture instead of relocating it. This
// config is evaluated in the main process before any worker spawns, which is
// why the directory is created here rather than in a per-suite hook: the
// backup/restore tests reach `os.tmpdir()` directly, not through `src/test/db.ts`.
const fixtureTmpDir = '/var/tmp/rembric-tests';
mkdirSync(fixtureTmpDir, { recursive: true });

export default defineConfig({
  // These resolve only inside the Pi harness, so `.pi-plugin/index.ts`'s static
  // imports would fail its whole test file to load.
  resolve: {
    alias: {
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
    // install.test.ts stays here so `vitest run ../../install.test.ts` (the
    // e2e:installer step) can find it — a positional filter can only narrow
    // an already-included file, not add one. The default `test`/
    // `test:coverage` scripts pass `--exclude '../../install.test.ts'` so it
    // runs exactly once per CI run, via e2e:installer only.
    include: [
      'src/**/*.test.ts',
      // install.test.ts stays included so the e2e:installer positional filter
      // can narrow it; the plugin suites now run under apps/web's vitest
      // project (their boot harness lives there).
      '../../install.test.ts',
      '../../scripts/*.test.ts',
    ],
    exclude: ['**/node_modules/**', 'dist/**'],
    testTimeout: 15_000,
    // Run test files sequentially. The real-server integration tests
    // (mcp-integration) drive an MCP roots-discovery `listRoots` round trip on
    // a bounded budget (2500 ms); running ~75 files across parallel workers
    // starves that server's event loop under CPU pressure, so the round trip
    // can exceed the budget and discovery falls back to the default project —
    // a flaky failure unrelated to product behavior. Serial execution removes
    // the starvation. The server suite is small, so the cost is modest.
    fileParallelism: false,
    // Every fixture DB is a `mkdtempSync(join(tmpdir(), …))` (`src/test/db.ts`)
    // holding ~44 MB of migrated SQLite. On a host where `/tmp` is tmpfs that is
    // RAM, and a killed run never reaches its `cleanup()`: 479 orphaned dirs
    // measured on 2026-08-11, 2.8 GB of RAM, which OOM-killed the box. Pointing
    // `TMPDIR` at a disk-backed directory makes an aborted run cost disk instead.
    // `os.tmpdir()` reads the variable per call, so this covers every fixture.
    env: { TMPDIR: fixtureTmpDir },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      // The db, core and mcp packages are measured through these patterns once
      // vitest can reach outside the project root; today it cannot (measured: 0
      // files), so the thresholds below are computed over the app tree alone.
      // They still hold — see the phase-3 report — and are never lowered for
      // that.
      include: [
        'src/**/*.ts',
        '../../packages/db/src/**/*.ts',
        '../../packages/core/src/**/*.ts',
        '../../packages/mcp/src/**/*.ts',
      ],
      exclude: [
        'src/server-entrypoint.ts',
        'src/test/**',
        'src/**/*.test.ts',
        '../../packages/db/src/migrations/**',
        '../../packages/db/src/schema/index.ts',
        'src/server/index.ts',
        'src/llm/index.ts',
        '../../packages/core/src/consolidation/index.ts',
        '../../packages/core/src/services/index.ts',
        '../../packages/db/src/index.ts',
        '../../packages/core/src/index.ts',
        '../../packages/mcp/src/index.ts',
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
