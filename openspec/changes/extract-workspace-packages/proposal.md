## Why

The owner has mandated a full migration of the server to Next.js, with Turborepo adopted if — and only if — real workspace packages need to be extracted. Phase 1 of that migration extracts `packages/{db,core,mcp,config}`, and two current contracts block it: the `data-access` capability freezes all SQL execution to the literal path `apps/server/src/db/`, and `apps/server/tsconfig.json` sets `rootDir: "./src"`, so no package can live outside that directory. The confinement boundary therefore has to move from a path inside one app to a package boundary, which is a spec-level change and cannot be made as an incidental refactor.

## What Changes

- Extract `packages/db` (schema, migrations, repositories, diagnostics, client), `packages/core` (services, consolidation, embeddings), `packages/mcp` (tools, server factory, transport manager), `packages/ui` (shared React components, per the create-turbo convention) and `packages/config` (shared tsconfig/eslint/prettier) as real pnpm workspace packages with their own `tsconfig` and build output.
- **BREAKING** (internal contract): the SQL-confinement boundary moves from `apps/server/src/db/` to `packages/db/`. The `data-access` requirement text that names the old path is rewritten, and every repository path it cites is re-anchored.
- The data-access invariant test keeps its semantics but changes the root it scans and the paths its allow-lists anchor on.
- Each extracted package is built independently, so **build order becomes meaningful**: consumers must build after their dependencies.
- Adopt Turborepo to own the task graph (`build`, `typecheck`, `test`, `lint`) now that a real dependency graph exists.
- **No runtime behaviour change.** The server's observable behaviour, HTTP surface, MCP tools, SQL and migrations are identical; this change relocates code and re-anchors the guards that police it.

## Capabilities

### New Capabilities

- `workspace-layout`: the monorepo's package boundaries, what each package may import, the rule that dependency builds precede consumers, and the invariant that SQL remains confined to exactly one package regardless of how many packages exist.

### Modified Capabilities

- `data-access`: the "SQL execution confined to the db layer" requirement changes its confinement boundary from `apps/server/src/db/` to `packages/db/`; the "Repositories per aggregate own all SQL for their tables" requirement changes its repository location; and the purge allow-list requirement changes the paths it pins.

## Impact

This change relocates the enforcement of the data-access confinement invariant. It does NOT alter: append-only memory (no `DELETE`, no `content` `UPDATE`), scope-at-service, `topic_key` convergence, or judgment freshness. The `Scope` parameter requirement on scoped repository reads is preserved verbatim — the packages change where the code lives, never who must pass a `Scope`.

### Files created

- `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/tsconfig.build.json`
- `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/tsconfig.build.json`
- `packages/mcp/package.json`, `packages/mcp/tsconfig.json`, `packages/mcp/tsconfig.build.json`
- `packages/ui/package.json`, `packages/ui/tsconfig.json`, `packages/ui/tsconfig.build.json`
- `packages/config/tsconfig.base.json`, `packages/config/eslint.config.js`
- `turbo.json`

### Files moved

- `apps/server/src/db/**` → `packages/db/src/**` (schema, `migrations/`, `repositories/`, `diagnostics.ts`, `client.ts`, `migrate.ts`, `query-tokenizer.ts`, `index.ts`)
- `apps/server/src/services/**`, `apps/server/src/consolidation/**`, `apps/server/src/embeddings/**` → `packages/core/src/**`
- `apps/server/src/mcp/**` → `packages/mcp/src/**`
- `apps/server/drizzle.config.ts` → `packages/db/drizzle.config.ts`

### Files edited

- `apps/server/src/**/*.ts` — 265 import sites (110 non-test, 155 test) rewritten across 8 import shapes
- `apps/server/src/test/invariants.test.ts` — the data-access confinement root, the three allow-list anchors, and the `SQL executes only under src/db/` assertion
- `apps/server/src/test/db.ts` — the per-test fixture that imports `../db/index.js`
- `apps/server/package.json` — depends on `@rembric/db`, `@rembric/core`, `@rembric/mcp`
- `apps/server/tsconfig.json`, `apps/server/tsconfig.build.json` — `rootDir`/`include` narrowed to what remains in the app
- `apps/server/scripts/copy-assets.mjs` — asset sources that moved
- `apps/server/Dockerfile` — the `prod-out` stage must carry the packages' build output and workspace links
- `pnpm-workspace.yaml`, `pnpm-lock.yaml` — new workspace members; `turbo` added under `allowBuilds` review
- `apps/server/src/test/supply-chain-inventory.ts` — the `ALLOWED_BUILD_SCRIPTS` inventory, if `turbo` requires a lifecycle entry
