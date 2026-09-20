## 1. packages/ui and packages/config scaffolding (no dependents)

- [ ] 1.1 Create `packages/config` as a development-only workspace member with `tsconfig.base.json` and `eslint.config.js`; it emits no build output and has no runtime entry point.
- [ ] 1.2 Resolve the design open question on the config split: run a scratch `pnpm create turbo` and record in `design.md` whether `packages/config` stays single or becomes `packages/eslint-config` + `packages/typescript-config`.
- [ ] 1.3 Create `packages/ui` (`@rembric/ui`) with `package.json`, a `tsconfig.json` extending `packages/config`, an `exports` map and an empty `src/index.ts`; it has no dependents in this change.
- [ ] 1.4 Add `packages/*` to `pnpm-workspace.yaml`, run the install, and confirm `pnpm run typecheck` and `pnpm test` are still green (this proves the package toolchain before any code moves).
- [ ] 1.5 Commit `packages/config` + `packages/ui` as one work unit; `git ls-files packages/` shows exactly the scaffolding files.

## 2. packages/db extraction

- [ ] 2.1 `git mv apps/server/src/db packages/db/src` for `schema/`, `migrations/`, `repositories/`, `diagnostics.ts`, `client.ts`, `migrate.ts`, `query-tokenizer.ts` and `index.ts`; confirm `git status --porcelain -M` reports renames only and that no migration filename changed.
- [ ] 2.2 `git mv apps/server/drizzle.config.ts packages/db/drizzle.config.ts` and re-point its `schema` and `out` settings at the package-relative layout.
- [ ] 2.3 Add `packages/db/{package.json,tsconfig.json,tsconfig.build.json}` with a public `exports` map resolving to built `dist`; verify a throwaway consumer in `apps/server` resolves `@rembric/db` through that map.
- [ ] 2.4 Rewrite the 265 inbound import sites (110 non-test, 155 test) across the 8 import shapes to import `@rembric/db` through its public entry point; confirm no file imports a `packages/db/src/**` internals path.
- [ ] 2.5 Re-anchor `apps/server/src/test/invariants.test.ts`: the SQL-confinement root becomes `packages/db/src/`, and the three purge allow-list anchors point at `packages/db/src/repositories/` plus `apps/server/src/scripts/seed-dev.ts`, keeping the positive `DELETE` anchors.
- [ ] 2.6 Re-point `apps/server/scripts/copy-assets.mjs` and the migration-directory resolution so both still read the same `migrations/` directory after the move (design R6); confirm the app's focused db suites are green.
- [ ] 2.7 Add the DS2 migration-discovery equivalence test asserting that the discovered `*.sql` set — count, filenames and content hashes — is identical before and after the move.
- [ ] 2.8 Add `@rembric/db` to `apps/server/package.json` and confirm `pnpm test` (focused db + invariants suites first, then the full suite) is green.
- [ ] 2.9 Mutation-check the guard: inject `DELETE FROM memory` into a non-test file outside `packages/db/`, confirm the invariants suite goes red, revert the injection, and record both the command and the observed outcomes.
- [ ] 2.10 Commit `packages/db` extraction as one work unit with the full suite green.

## 3. packages/core extraction

- [ ] 3.1 `git mv apps/server/src/services apps/server/src/consolidation apps/server/src/embeddings packages/core/src/`; confirm `git status --porcelain -M` reports renames only.
- [ ] 3.2 Add `packages/core/{package.json,tsconfig.json,tsconfig.build.json}` with a public `exports` map resolving to built `dist`.
- [ ] 3.3 Rewrite the inbound import sites for the moved services, consolidation and embeddings modules to import `@rembric/core` through its public entry point.
- [ ] 3.4 Confirm the SQL-confinement guard still passes with the new files in place (no SQL was carried into `packages/core`), then run the focused core suites.
- [ ] 3.5 Commit `packages/core` extraction as one work unit with the full suite green.

## 4. packages/mcp extraction — DEFERRED TO THE PORTING CHANGE (see design D6)

The tasks below SHALL NOT be executed by this change. The measured app↔package dependency cycle (20 non-test import sites in 11 files reaching five app-side modules, 7 × TS6059 under `--rootDir src/mcp`, and 17 co-located test files that import app-side fixtures) is recorded in `design.md` D6 together with the rejected alternatives. The package is extracted in the porting change, alongside the `mcp-handler` integration. Checkboxes are retained as the carried-over work list; none is completable inside this change.

- [ ] 4.1 `git mv apps/server/src/mcp packages/mcp/src`; confirm `git status --porcelain -M` reports renames only.
- [ ] 4.2 Add `packages/mcp/{package.json,tsconfig.json,tsconfig.build.json}` with a public `exports` map resolving to built `dist`.
- [ ] 4.3 Rewrite the inbound import sites for the moved tools, server factory and transport manager to import `@rembric/mcp` through its public entry point.
- [ ] 4.4 Confirm the invariants suite and the MCP tool suites are green, and that `packages/mcp` contains no SQL execution.
- [ ] 4.5 Commit `packages/mcp` extraction as one work unit with the full suite green.
- [ ] 4.6 (carried to the porting change) Resolve the `AsyncLocalStorage` binding for `request-context.ts` and `tool-call-context.ts` so exactly one instance exists per process, and re-point `version.ts` at the injected application version rather than a self-relative `package.json` read.

## 4b. Amendment record

- [x] 4b.1 Recorded that the phase-4 extraction is deferred to the porting change: the decision and its measured evidence live in `design.md` D6, the package-inventory requirement in `specs/workspace-layout/spec.md` names the inventory this change actually delivers (`packages/{db,core,ui}` plus the `packages/config` tooling package), and `proposal.md` marks the MCP extraction as deferred. Verifiable by inspecting `design.md` D6.

## 5. Turborepo

- [ ] 5.1 Add `turbo.json` using the top-level `tasks` key (not the 1.x `pipeline` spelling), declaring `build`, `typecheck`, `test` and `lint`, with `dependsOn: ["^build"]` on `build` and `outputs` for build output.
- [ ] 5.2 Before editing `package.json`, consult `.agents/skills/npm-security-best-practices/`; record the decision on `allowBuilds` and `minimumReleaseAge` for the new dependency.
- [ ] 5.3 Update `apps/server/src/test/supply-chain-inventory.ts::ALLOWED_BUILD_SCRIPTS` only if a lifecycle entry is required, and confirm the supply-chain suite stays green.
- [ ] 5.4 Switch the root scripts to the Turborepo task graph and confirm affected-only execution builds `packages/db` before `apps/server`.
- [ ] 5.5 Measure cold `build` and `typecheck` and record the deltas against the 2.36 s build and 2.92 s typecheck baselines, naming the exact commands and the before/after figures in `design.md`.

## 6. Docker

- [ ] 6.1 Extend `apps/server/Dockerfile` so the runtime stage carries the four packages' build output and workspace links, using `turbo prune <app> --docker` output for the install and source layers.
- [ ] 6.2 Preserve `ENV REMBRIC_DATA_DIR=/data`, `VOLUME ["/data"]` and the runtime user's read/write access to `/data` (DS3).
- [ ] 6.3 Build the image and confirm the container starts and logs the resolved absolute database path with its file-provenance flag (DS1), and does not create an empty `data.db` in its ephemeral layer.
- [ ] 6.4 (operator-only) Run the DS3 seeded-volume smoke: mount a volume seeded with a known row, read that row back through the running container, and record the transcript with hostnames and paths redacted.
- [ ] 6.5 Commit the Docker change as one work unit, recording the image build output and the container startup log.

## 7. Data safety

- [ ] 7.1 (operator-only against a real data directory) Take a DS5 `VACUUM INTO` snapshot before the new code applies any migration to a real data directory; record the snapshot path and size. Local drills run against a copy, never the live volume (DS4).
- [ ] 7.2 Add the DS1 startup log of the resolved absolute database path and whether the file pre-existed, with a test asserting both the fresh and pre-existing cases.
- [ ] 7.3 Produce DS6 evidence that no migration file was added, removed, edited, renumbered or renamed: list the migration directory before and after and record the filenames-unchanged plus byte-identity confirmation.
- [ ] 7.4 Confirm `readdirSync(migrationsDir)` still throws loudly when the migrations directory is missing; a silent skip is not acceptable.
- [ ] 7.5 Confirm DS4 explicitly: `apps/web` and `apps/server` use separate `REMBRIC_DATA_DIR` values and separate ports, and every local smoke points at a copy.

## 8. Close-out

- [ ] 8.1 Skills audit: commit the three untracked skill directories `.agents/skills/next-best-practices/`, `.agents/skills/next-cache-components-adoption/` and `.agents/skills/next-dev-loop/` together with their `.claude/skills/` symlinks; the owner confirmed he authored them.
- [ ] 8.2 Skills audit: review `.agents/skills/rembric-dashboard-ui/` and `.agents/skills/rembric-smoke-tests/` for references invalidated by the package move and update them; record which references were stale.
- [ ] 8.3 Documentation audit: replace `AGENTS.md` with a symlink to `CLAUDE.md` and update the 13 `apps/server/src` references it carries.
- [ ] 8.4 Documentation audit: update the 2 `apps/server/src` references each in `README.md` and `CONTRIBUTING.md`.
- [ ] 8.5 Documentation audit: update `docs/agents.md`, `docs/backup.md`, `docs/docker.md`, `docs/embeddings.md`, `docs/relations.md`, `docs/troubleshooting.md` and `docs/updates.md`.
- [ ] 8.6 Documentation audit: update the `openspec/config.yaml` context block, which still states Hono + HTMX and "no SPA, no build pipeline for JS", so it matches the extracted package layout.

## 9. Verification

- [ ] 9.1 `pnpm run typecheck` exits successfully from the repository root.
- [ ] 9.2 `pnpm test` is green across the full suite, excluding only the pre-existing macOS failures named in `odd/tasks/migrate-to-nextjs.md`.
- [ ] 9.3 `pnpm run lint` exits successfully.
- [ ] 9.4 The production image builds from the monorepo root and starts with the volume mounted at `/data`.
- [ ] 9.5 (operator-only) The installer e2e passes per the `rembric-tui-installer-e2e` playbook.
- [ ] 9.6 `openspec validate extract-workspace-packages --strict` passes.

## 10. Recurring maintenance

- [ ] 10.1 Recurring: merge `main` into `migrate/nextjs` and rerun the suite after each merge, since release-please keeps moving `main` while this branch lives.

## 11. Deferred isolated phase — MCP SDK v2 + zod 4 (B2)

- [ ] 11.1 Record the decided upgrade path as an isolated phase, not executed by this change: **B2 — `mcp-handler@2` on MCP SDK v2 with `zod` 3→4 across 399 schema declarations** — so that a B2 failure is attributable to B2 alone and never entangled with the package extraction.
