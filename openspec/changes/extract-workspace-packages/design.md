## Context

The owner mandated a full migration of the server to Next.js, with Turborepo adopted if — and only if — real workspace packages need extracting. Phases 1–2 extract `packages/*`. The phase-1 blocker is not mechanical: the `data-access` capability freezes SQL execution to the literal path `apps/server/src/db/`, and `apps/server/tsconfig.json` sets `rootDir: "./src"`, so no package may live outside that directory. The confinement boundary therefore has to move from a path inside one app to a package boundary, which is a spec-level change.

The owner also set two constraints that outrank the rest:

1. **No data loss, ever.** Existing installations must keep working. UI defects are recoverable; database loss is not. This is expanded in D5 and enforced by requirements DS1–DS6.
2. **Maximally exploit the framework.** The later porting phases must delete hand-rolled machinery rather than transliterate it. That does not change phases 1–2 (code moves, behaviour does not), but it decides the port's shape, so it is recorded in D4 as the design authority the port inherits.

## Goals / Non-goals

### Goals

- Extract `packages/{db,core,ui}` and the `packages/config` tooling package as real pnpm workspace packages with independent builds; the `packages/mcp` extraction is deferred to the porting change (D6).
- Re-anchor the data-access confinement guard from an app-internal path to a package boundary.
- Adopt Turborepo, which becomes meaningful only once a real dependency graph exists.
- Preserve observable behaviour exactly: same HTTP surface, same MCP tools, same SQL, same migrations, same database file.
- Record the data-safety contract and the deletion-first principle for the phases that follow.

### Non-goals

- No Next.js application in this change. `apps/server` keeps serving every surface.
- No `packages/mcp` extraction and no `mcp-handler` integration in this change. `apps/server/src/mcp/**` SHALL remain inside the application until the porting change relocates it (D6).
- No dependency major upgrades. `zod` stays 3.x and `@modelcontextprotocol/sdk` stays 1.x; the `mcp-handler@2` prerequisite is a separate, isolated phase with its own change.
- No change to append-only memory, scope-at-service, `topic_key` convergence, or judgment freshness.
- No destructive migration, and no edit, renumbering or rename of any migration file.

## Decisions

### D1 — The confinement boundary moves from a path to a package

**Chosen.** `packages/db` becomes the home of every SQL-executing file, and the invariant test's root becomes that package.

**Alternative A — keep `db` inside `apps/server/src` and extract only the other packages.** Rejected: the one package every other package depends on would be the only one that is not a package, inverting the dependency graph against the directory layout.

**Alternative B — loosen the invariant to "SQL lives in any `db/` directory".** Rejected: it weakens a load-bearing guard to accommodate a directory move. The guard's strength is that it names exactly one location.

**Alternative C — extract `db` but leave the invariant test in `apps/server/src/test/`, scanning an absolute path into the package.** Rejected: the test would police code it does not sit beside, and its allow-list anchors would become cross-package reads.

### D2 — Packages build independently, so build order matters

**Chosen.** Each package owns a `tsconfig.build.json` and emits `dist`; consumers import the built output through the package's `exports` map.

**Alternative — consume package sources via TypeScript project references or `paths`.** Rejected as the primary mechanism: the distroless production image copies built output only (`/prod-out/dist`, `/prod-out/node_modules`), so source-only packages would force the image assembly to change anyway, and every typecheck would load every package's source.

**[Trade-off]** A `dist`-based package adds a build step before the app typechecks, so a cold `pnpm -r run typecheck` will exceed the measured 2.92 s baseline. → Accepted because it is the only shape that survives the production image.

### D3 — Turborepo lands in this change, not later

**Chosen.** Add `turbo.json` once packages exist.

**Alternative — keep `pnpm -r`.** Rejected: the measured task graph currently has **zero edges between workspaces**, so `pnpm -r` is already sufficient today. Extraction creates the edges; that is precisely why Turborepo arrives now and not before.

Verified configuration facts: `turbo.json` uses a top-level **`tasks`** key (not `pipeline`, which was the 1.x spelling); the Docker flow is `turbo prune <app> --docker`, which splits output into `out/json` (the install layer) and `out/full` (source), with the build run from the monorepo root.

### D4 — Deletion-first governs the porting phases

Recorded here so it survives into the later port. The port SHALL delete hand-rolled machinery, not transliterate it. Measured surface available for deletion:

| Current file                                 | Lines | Replaced by                                        |
| -------------------------------------------- | ----- | -------------------------------------------------- |
| `apps/server/src/server/dashboard-router.ts` | 877   | file-based routing + nested layouts                |
| `apps/server/src/dashboard/components.ts`    | 737   | React components with typed props                  |
| `apps/server/src/dashboard/templates.ts`     | 550   | root layout, `generateMetadata`, JSX escaping      |
| `apps/server/scripts/build-css.mjs`          | 128   | Next's CSS bundling, hashing and immutable caching |
| `apps/server/src/dashboard/page-shell.ts`    | 78    | nested layout composition                          |
| `apps/server/src/dashboard/csrf.ts`          | 58    | Server Actions origin/host verification (see R3)   |

Mechanisms that SHALL NOT be ported:

- `minifyHtml()` and its `<pre>`/`<textarea>`/`<script>` carve-outs — JSX emits no inter-tag whitespace.
- The `html` tagged template, `SafeHtml`, `raw()` and `escape()` — React escapes text children by default.
- The manifest lookup, content-hashing and `Cache-Control` wiring in `build-css.mjs` — Next does this.
- The six inline scripts in `templates.ts`: `TS_UPGRADER`, `MOB_TOGGLE`, `SB_COLLAPSE`, `ROW_LINK`, `CONFIRM`, `MD_COPY`.

**What deletion does not cover.** `apps/server/src/dashboard/sessions-xss.test.ts` (regression #252) SHALL REMAIN. React auto-escaping protects text children, but rendered Markdown requires `dangerouslySetInnerHTML`, so the escaping surface is not eliminated — it moves. Any claim that the framework removes this class of defect outright is wrong and SHALL NOT be written into a spec.

### D5 — Data safety is a gate, not a guideline

**Chosen.** The measured silent-failure mechanism is treated as the change's primary risk and converted into enforceable requirements (DS1–DS6, in the `workspace-layout` capability).

The mechanism, measured: `apps/server/src/db/client.ts` creates the data directory if missing and then calls `new Database(join(dataDir, 'data.db'))`. `better-sqlite3` **creates an empty database file if it does not exist**. So if `REMBRIC_DATA_DIR` resolves elsewhere after the migration, the server opens a fresh empty database and starts normally. Nothing is deleted — the real database is still on disk — but the process reads and WRITES a different file. Under Docker, if the volume is not mounted where expected, those writes land in the container's ephemeral layer and vanish on recreate. The operator sees an empty dashboard and no error.

Two supporting facts: the `_migrations` table records the migration **filename** only, so renaming a file makes it **re-apply**; and WAL mode keeps committed transactions in `data.db-wal`, so a snapshot SHALL use `VACUUM INTO` (already available in `db/diagnostics.ts`) and never a plain file copy.

**Alternative — treat data safety as operational documentation.** Rejected: a silent failure mode cannot be mitigated by prose. It needs a test and a startup signal.

### D6 — The `packages/mcp` extraction is deferred to the porting change

**Chosen.** This change delivers `packages/{db,core,ui}` plus the `packages/config` tooling package. The `packages/mcp` extraction (phase 4) SHALL NOT be executed here: it moves to the porting change that also builds `apps/web`, together with the `mcp-handler` integration that is the reason the package becomes useful. `apps/server/src/mcp/**` stays where it is until then.

**The measured dependency map (stopped phase-4 run at `2c467abf`, zero writes made).** `apps/server/src/mcp/**` reaches five app-side modules through 20 non-test import sites across 11 files, and the application reaches back into `src/mcp/` through 8 import sites across 6 files (4 non-test sites in 3 files, 4 test-side sites in 3 files). That is a genuine app↔package cycle, not a one-way extraction: neither side can be moved first without the other moving too. Measured proof of the coupling: `tsc --noEmit --rootDir src/mcp` reports 7 × TS6059, one for each app-side file the MCP graph reaches — the five modules below plus `logger.ts` and `config.ts`, which `error-response.ts` drags in through `../logger.js` → `./config.js`.

| App-side module reached from `src/mcp/**`     | Size  | Kind                                                                                                                    | Why it constrains the move                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/server/request-context.ts`   | 59 L  | VALUE (`getRequestContext`, `tryGetRequestContext`); imports only `node:async_hooks`, `@rembric/core` and `@rembric/db` | Shared application infrastructure, not MCP-specific: 7 import sites and 23 call sites inside `src/mcp/`, and the application's own HTTP path depends on it too — `server/http.ts:32` imports `runWithContext`, which wraps the transport at `server/http.ts:417`. Moving it puts the app's request context inside the protocol package. |
| `apps/server/src/server/session-router.ts`    | 144 L | TYPE-ONLY; zero module imports                                                                                          | Nothing to relocate at runtime, but the types are consumed by nine MCP modules, so any reshape of the package surface touches all of them.                                                                                                                                                                                              |
| `apps/server/src/server/tool-call-context.ts` | 14 L  | VALUE (`AsyncLocalStorage`); self-contained                                                                             | The cheapest of the five to move — and the one whose duplication is silent: a second `AsyncLocalStorage` instance in the package versus the app makes the store read as empty, with no type error.                                                                                                                                      |
| `apps/server/src/server/error-response.ts`    | 33 L  | VALUE                                                                                                                   | NOT self-contained: `../logger.js` → `./config.js`, so relocating it drags two further application files along.                                                                                                                                                                                                                         |
| `apps/server/src/version.ts`                  | 18 L  | VALUE (`REMBRIC_VERSION`)                                                                                               | Reads `../package.json` by filesystem path relative to its own file. Relocated into a package it silently reports `0.0.0` — the same behaviour-trap class as the phase-3 fix, where `packages/core`'s `update-check` stopped resolving the version itself and now takes `currentVersion` injected at the boundary.                      |

Two further measured facts complete the picture. Of the 22 co-located `*.test.ts` files under `src/mcp/`, 17 import app-side `src/test/**` fixtures and 17 import `src/server/**` (16 do both), so those tests cannot move with the package; and the application-side reach-back is `server/bootstrap.ts:41` and `:42` (value), `server/http.ts:24` (type) and `server/api-router.ts:14` (`snippet`), plus the test-side imports in `server/api-router.test.ts:12`, `test/mcp-integration.test.ts:26-27` and `test/retrieval/ingest.ts:9`.

**Why deferral rather than a reshape now.** The final shape of the request/tool context is decided by the Next runtime's App Router request context. Extracting it today would place shared application-context utilities inside the protocol package, making the application depend on "mcp" for non-MCP reasons — speculative structure the port would redo. The transition value that justifies a package at all (both servers serving `/mcp` from one package) activates only when `apps/web` serves `/mcp`, which is the port. Deferral also carries this complete measured dependency map into the porting change, which is the deliverable of the stopped run.

**Options considered and rejected.**

- **Option 1 — full dependency injection**: inject all five modules into the MCP package. Rejected: the largest reshape of code the port will partially redo, and it rewrites the application's own HTTP path for a benefit this change cannot observe.
- **Option 2 — minimal injection**: move the three package-safe modules (`session-router.ts`, `tool-call-context.ts`, `request-context.ts`) and inject the remaining two. Rejected: the application would import the MCP package for its own request context — the layering inversion described above — and it leaves an `AsyncLocalStorage` duplication hazard if any importer of `request-context.ts` or `tool-call-context.ts` is missed.
- **Option 3 — a dedicated `mcp-context` package, or hosting the context modules in `core`**: rejected as either a sixth package outside this change's declared inventory (`packages/{db,core,ui}` plus `config`) or a domain/infrastructure mix inside `core`.
- **Option 4 — deferral**: CHOSEN.

**Consequence.** The `packages/mcp` extraction and the `mcp-handler` integration migrate together to the porting change. There, `apps/server/src/mcp/transport.ts` (the hand-rolled `McpTransportManager`) is expected to be deleted if `mcp-handler`'s session handling covers the per-slug scope — the deletion note the migration plan already carries (`odd/tasks/migrate-to-nextjs.md`, scope decision "MCP lives in BOTH places", unverified until that phase). A deferral is not a relaxation of any guard: the SQL-confinement invariant applies to `packages/core` exactly as it would to any package added later.

## Risks / Trade-offs

**[Risk]** Extraction produces one enormous diff across 265 import sites, 8 import shapes and 12 test-affecting files, making review ineffective. → **Mitigation:** extract one package per commit with the full suite green between commits; `packages/db` first (most inbound references), then `core`. Deferring the `mcp` extraction (D6) keeps this diff smaller still.

**[Risk]** The data-access guard silently stops guarding. A path-rewriting mistake in `invariants.test.ts` could leave the suite green while scanning nothing. → **Mitigation:** mutation-check the guard after the move — inject `DELETE FROM memory` into a file outside `packages/db` and confirm the suite goes red. A guard not observed failing is not known to work.

**[Risk]** `turbo` is a new dependency in a repository that denies lifecycle scripts by default (`ignore-scripts=true`) and pins `minimumReleaseAge: 4320`. → **Mitigation:** consult `.agents/skills/npm-security-best-practices/` before editing `package.json`, and update the `ALLOWED_BUILD_SCRIPTS` inventory in `apps/server/src/test/supply-chain-inventory.ts` if a lifecycle entry is required.

**[Risk]** R3 — replacing `csrf.ts` with Server Actions origin/host verification assumes the two are equivalent. → **Mitigation:** verify against the `http-api` CSRF requirement before making the deletion; if equivalence cannot be demonstrated, the hand-rolled CSRF token stays. **Not yet verified.**

**[Risk]** The migration branch is long-lived and `main` moves under it, because `release-please` bumps two release components on every release. → **Mitigation:** merge `main` into the migration branch periodically; tracked as a recurring task.

**[Risk]** R5 — the silent-empty-database hazard described in D5. → **Mitigation:** DS1–DS6.

**[Risk]** R6 — `packages/db`'s build output path changes both where the migrations directory resolves and where `copy-assets.mjs` copies from. If they move apart, migration discovery breaks. → **Mitigation:** they move in the same commit, and DS2's equivalence test is the guard that proves it.

**[Trade-off]** The production image must carry four packages' build output. → Accepted because it is a build-stage change confined to `apps/server/Dockerfile`, and it is a prerequisite for any package layout.

**[Trade-off]** `apps/server/tsconfig.json` must narrow `rootDir`/`include`, temporarily making the app's own configuration less uniform. → Accepted because it is transitional and disappears when the app is retired.

## Migration

Every step leaves the suite green and is independently revertible:

1. Create `packages/ui` and `packages/config` — no dependents yet, so they prove the package toolchain in isolation.
2. Move `apps/server/src/db/**` to `packages/db/`, re-anchor the invariant test, rewrite inbound imports, add the DS2 equivalence test, mutation-check the guard.
3. Move `services`, `consolidation`, `embeddings` to `packages/core`; rewrite imports.
4. **Deferred to the porting change (D6):** move `mcp/**` to `packages/mcp` and rewrite imports, together with the `mcp-handler` integration.
5. Add `turbo.json` and switch the root scripts; record the measured delta against the 2.36 s build and 2.92 s typecheck baselines.

Data safety runs in parallel, not after: DS1's startup log and DS5's snapshot land before any phase touches a real data directory, and DS3's image smoke is the gate on the Docker change.

## Open questions

- Which `exports` map shape to use for ESM-only packages under `moduleResolution: NodeNext` — resolved at implementation time by verifying `tsc` resolves the built output from a consumer in `apps/server`.
- Whether `turbo` requires a lifecycle-script allow-list entry — resolved by the supply-chain skill and the inventory test.
- Whether the `create-turbo` template's split into `packages/eslint-config` and `packages/typescript-config` (rather than a single `packages/config`) should be adopted — confirm with a scratch `pnpm create turbo` before choosing.
