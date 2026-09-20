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
      '../../server/src/db/repositories/index.js': rembricDbRepositories,
      '../../server/src/db/schema/projects.js': rembricDbSchemaProjects,
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
      // One pattern for every per-client package dir, so a client's test file
      // cannot exist without being run.
      '../plugin/.*-plugin/*.test.ts',
      '../plugin/mcp-bridge/*.test.ts',
      '../plugin/test/*.test.ts',
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
      // The db package is measured through this pattern once vitest can reach
      // outside the project root; today it cannot (measured: 0 files), so the
      // thresholds below are computed over the app tree alone. They still hold —
      // see the phase-2 report — and are never lowered for that.
      include: ['src/**/*.ts', '../../packages/db/src/**/*.ts'],
      exclude: [
        'src/server-entrypoint.ts',
        'src/test/**',
        'src/**/*.test.ts',
        '../../packages/db/src/migrations/**',
        '../../packages/db/src/schema/index.ts',
        'src/server/index.ts',
        'src/llm/index.ts',
        'src/mcp/index.ts',
        'src/consolidation/index.ts',
        'src/services/index.ts',
        '../../packages/db/src/index.ts',
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
