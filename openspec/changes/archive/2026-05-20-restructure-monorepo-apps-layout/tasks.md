## 1. Pre-implementation spikes (gates apply)

- [x] 1.1 Spike 1 — In a clean VM or container, set `.claude-plugin/marketplace.json::plugins[0].source` to `"./apps/plugin"` on a throwaway branch with the plugin tree mirrored at `apps/plugin/`. Run `claude plugin marketplace add file:///path/to/local/repo` followed by `claude plugin install rembric@rembric`. Verify the install succeeds, `${CLAUDE_PLUGIN_ROOT}/bin/rembric-bridge.mjs` resolves at runtime, and `memory.context` returns a result. Record the exact Claude Code version tested in this task line.
- [x] 1.2 Spike 2 — In the same clean environment, set `.codex-plugin/marketplace.json::plugins[0].source.path` to `"./apps/plugin"`. Run `codex plugin marketplace add https://github.com/susomejias/rembric.git` (against a temporary fork or PR branch) followed by `codex plugin install rembric`. Verify the plugin appears under `~/.codex/plugins/cache/rembric/<version>/` with the expected file tree, and that a session POST against the bridge succeeds. Record the exact Codex CLI version tested.
- [x] 1.3 If EITHER Spike 1 or Spike 2 fails, STOP and update `design.md` Decision 1 with the fallback (e.g., keep `marketplace.json::source = "./plugin"` and add a checkout-time symlink `plugin → apps/plugin`). Re-run both spikes against the fallback.

## 2. Branch setup

- [x] 2.1 Create branch `feat/restructure-monorepo-apps-layout` from latest `main`.
- [x] 2.2 Verify clean git state (`git status` reports no uncommitted changes before starting).

## 3. Move files into `apps/server/`

- [x] 3.1 `git mv src apps/server/src` and verify `git status` shows renames (R), not delete+add.
- [x] 3.2 `git mv scripts apps/server/scripts` (root-level scripts dir → server's scripts dir).
- [x] 3.3 `git mv Dockerfile apps/server/Dockerfile`.
- [x] 3.4 `git mv drizzle.config.ts apps/server/drizzle.config.ts`.
- [x] 3.5 `git mv vitest.config.ts apps/server/vitest.config.ts`.
- [x] 3.6 `git mv tsconfig.json apps/server/tsconfig.json`.
- [x] 3.7 `git mv tsconfig.build.json apps/server/tsconfig.build.json`.
- [x] 3.8 `git mv CHANGELOG.md apps/server/CHANGELOG.md`.
- [x] 3.9 `git status` — all entries under apps/server/ SHALL show as renames; commit a `chore(server): move source to apps/server` checkpoint.

## 4. Move files into `apps/plugin/`

- [x] 4.1 `git mv plugin apps/plugin` (whole tree in one operation).
- [x] 4.2 Confirm `git status` shows ~50 renames under `apps/plugin/` and `apps/plugin/.hermes-plugin/tests/` is intact (renamed from the legacy sibling `plugin/.hermes-plugin-tests/`).
- [x] 4.3 Commit a `chore(plugin): move plugin tree to apps/plugin` checkpoint.

## 5. Create `packages/` placeholder

- [x] 5.1 `mkdir packages` at the repo root.
- [x] 5.2 Add `packages/.gitkeep` (empty file) so git tracks the directory.

## 6. Set up workspace `package.json` files

- [x] 6.1 Create `apps/server/package.json` with `"name": "@rembric/server"`, `"private": true`, `"type": "module"`, and the server-relevant scripts moved out of the root `package.json` (`build`, `dev`, `start`, `test`, `typecheck`, `clean`, `build:css`, `db:generate`, `db:check`). Verify `pnpm -F @rembric/server run typecheck` passes once installed.
- [x] 6.2 Create `apps/plugin/package.json` with `"name": "@rembric/plugin"`, `"private": true`, and a `version` field matching the current `apps/plugin/.claude-plugin/plugin.json::version` (`0.8.0`). Add `"scripts": { "test": "vitest run" }` so `pnpm -F @rembric/plugin test` runs `apps/plugin/.opencode-plugin/plugin.test.ts`.
- [x] 6.3 Edit root `package.json`: strip the server-specific scripts and dependencies that moved into `apps/server/package.json`. Keep workspace-level scripts (`dev:docker:up`, `test:hermes-plugin`, `format`, `format:check`, `prepare`). Update `test:hermes-plugin` path to `apps/plugin/.hermes-plugin/tests/`.
- [x] 6.4 Update root `package.json::devDependencies` to keep only dependencies needed at the workspace level (eslint, prettier, husky, lint-staged, commitlint). Move server-only devDependencies (`vitest`, `tsx`, `drizzle-kit`, etc.) to `apps/server/package.json::devDependencies`.

## 7. Update `pnpm-workspace.yaml`

- [x] 7.1 Edit `pnpm-workspace.yaml` to add a `packages:` block at the top listing `apps/*` and `packages/*`. Preserve the existing `allowBuilds:`, `blockExoticSubdeps:`, `minimumReleaseAge:`, and `minimumReleaseAgeExclude:` (if present) entries verbatim.
- [x] 7.2 Run `pnpm install --frozen-lockfile`. If the lockfile fails frozen-mode validation due to the workspace restructure, run `pnpm install` (which updates the lockfile), then commit the updated `pnpm-lock.yaml` as part of the restructure commit. Document any lockfile churn in the PR description.
- [x] 7.3 Verify `pnpm -r ls` lists `@rembric/server` and `@rembric/plugin` as workspace members.

## 8. Update `apps/server/Dockerfile`

- [x] 8.1 Edit `apps/server/Dockerfile` so the `COPY` instructions reference the new paths. Specifically: copy `pnpm-lock.yaml`, `pnpm-workspace.yaml`, root `package.json`, `apps/server/package.json`, and `apps/plugin/package.json` separately; then run `pnpm install --frozen-lockfile --filter @rembric/server...`.
- [x] 8.2 Update the `COPY` of source from `COPY src/ /app/src/` to `COPY apps/server/src/ /app/src/` (or the equivalent restructure that lets `tsx watch /app/src/cli.ts` continue to work in the dev stage).
- [x] 8.3 Update the `dev` stage `CMD` to invoke `tsx src/scripts/seed-dev.ts --reset` (the seed stays TypeScript and runs via `tsx`, which is already a dev dependency installed in the `dev` stage; do NOT introduce a stripped-down `.mjs` duplicate — the `.ts` script imports the services layer and `createDb`, which is what guarantees the schema is migrated before the seed inserts run).
- [x] 8.4 Verify the runtime stage is STILL the last `FROM ... AS <name>` declaration (invariant from the development-environment spec).
- [x] 8.5 Confirm `LABEL rembric.stage=runtime` on the runtime stage and `LABEL rembric.stage=dev` on the dev stage.

## 9. Update `docker-compose*.yml`

- [x] 9.1 Edit `docker-compose.yml`: change the build context's `dockerfile:` to `apps/server/Dockerfile`. The `context:` SHALL stay as `.` (the repo root).
- [x] 9.2 Edit `docker-compose.dev.yml`: change the `dockerfile:` to `apps/server/Dockerfile`. Update the bind-mount from `./src:/app/src` to `./apps/server/src:/app/src`.
- [x] 9.3 Edit `docker-compose.build.yml` (if it exists at the repo root) to reference the new Dockerfile path.
- [x] 9.4 Run `docker compose -f docker-compose.yml build` locally and verify the runtime image builds.
- [x] 9.5 Run `docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build`, verify the dev container reaches `healthy`, the seed script runs, the dashboard at `http://127.0.0.1:8788/dashboard` renders populated counters, then teardown with Ctrl-C.

## 10. Rewrite `release-please-config.json` and `.release-please-manifest.json`

- [x] 10.1 Replace `release-please-config.json` contents with the 5-component manifest described in `design.md::Decision 3` (server + claude-code + codex + hermes + opencode, with the `bridge-bundlers` linked-versions plugin group).
- [x] 10.2 Replace `.release-please-manifest.json` contents with 5 entries:
  ```json
  {
    "apps/server": "0.17.0",
    "apps/plugin/.claude-plugin": "0.8.0",
    "apps/plugin/.codex-plugin": "0.8.0",
    "apps/plugin/.hermes-plugin": "0.8.0",
    "apps/plugin/.opencode-plugin": "0.8.0"
  }
  ```
- [x] 10.3 Verify the chosen release-please-action version in `.github/workflows/release-please.yml` supports the `linked-versions` plugin and the chosen `release-type` per package. Pin or upgrade the action as needed and record the version in the PR description.

## 11. Seed script extension (DECIDED: keep `.ts`)

- [x] 11.1 Decision: the seed lives at `apps/server/src/scripts/seed-dev.ts` and stays TypeScript. Reason: it depends on the services layer (`MemoryService`, `ProjectsService`, etc.) and `createDb` to bootstrap migrations before INSERTs. A `.mjs` raw-SQL rewrite was attempted and failed with `no such table: tokens` at boot because it bypassed the migration step.
- [x] 11.2 Dev Dockerfile `CMD` invokes `tsx src/scripts/seed-dev.ts --reset` (task 8.3).
- [x] 11.3 `apps/server/src/test/invariants.test.ts` allow-list entry already references `scripts/seed-dev.ts` (relative to `src/`) — no change needed.

## 12. Update `.github/workflows/release-please.yml`

- [x] 12.1 Update the `publish-docker` job's `if:` condition to gate on the `apps/server` path being in `paths_released` (or whatever output key the pinned release-please-action emits — verify against the action's source). Example: `if: ${{ fromJSON(needs.release-please.outputs.paths_released)['apps/server'] != null }}`.
- [x] 12.2 Update the `publish-docker` job's invocation to pass the new tag format (`server-vX.Y.Z`) where appropriate. The `docker-publish.yml` reusable workflow may need its `inputs.tag` semantics revisited if it strips the `v` prefix.

## 13. Update `.github/workflows/docker-publish.yml`

- [x] 13.1 Update the `build-push` step's `context:` to `.` and `file:` to `apps/server/Dockerfile`.
- [x] 13.2 Verify the smoke-test step's image inspection commands still work (`docker inspect` outputs are the same regardless of build path).

## 14. Update `.github/workflows/ci.yml`

- [x] 14.1 Update any path-based grep / matrix entries to reference `apps/server/` and `apps/plugin/` as appropriate.
- [x] 14.2 Verify `pnpm install --frozen-lockfile` still works in CI given the new workspace layout.
- [x] 14.3 Update the `docker-build-check` job to use `context: .` and `file: apps/server/Dockerfile`.

## 15. Update `.claude-plugin/marketplace.json` and `.codex-plugin/marketplace.json`

- [x] 15.1 Edit `.claude-plugin/marketplace.json`: change `plugins[0].source` from `"./plugin"` to `"./apps/plugin"`.
- [x] 15.2 Edit `.codex-plugin/marketplace.json`: change `plugins[0].source.path` from `"./plugin"` to `"./apps/plugin"`. Update `plugins[0].source.url` from `git@github.com:susomejias/rembric.git` to `https://github.com/susomejias/rembric.git` if the spec change requires (currently the spec mentions the `https://` form; verify).

## 16. Legacy install-URL strategy (DECIDED: hard cutover, no shims)

- [x] 16.1 Decision: do NOT create `plugin/.hermes-plugin/install.sh` or `plugin/.opencode-plugin/install.sh` shims. Bookmarked old `curl ... main/plugin/...` URLs return a plain raw.githubusercontent.com 404; the documented install command in `README.md`, `docs/agents.md`, and per-client READMEs is the source of truth.
- [x] 16.2 N/A — no shim file to create.
- [x] 16.3 N/A — no shim to chmod.
- [x] 16.4 N/A — no shim to test.
- [x] 16.5 N/A — no follow-up issue to file (no shims to remove later).
- [x] 16.6 Release notes for the first post-restructure plugin releases (`hermes-vX.Y.Z`, `opencode-vX.Y.Z`) MUST flag the install URL change as **BREAKING** so the 404 has a discoverable landing page. Handled at release-PR review time.

## 17. Update `apps/plugin/.opencode-plugin/install.sh`

- [x] 17.1 Edit `apps/plugin/.opencode-plugin/install.sh` so the default `PLUGIN_SRC` and `BIN_SRC` point at `https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.opencode-plugin` and `https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/bin` respectively.
- [x] 17.2 Verify the local-dev usage example in the script's header comments references `PLUGIN_SRC="$(pwd)/apps/plugin/.opencode-plugin"` and `BIN_SRC="$(pwd)/apps/plugin/bin"`.

## 18. Update `apps/plugin/.hermes-plugin/install.sh`

- [x] 18.1 Edit `apps/plugin/.hermes-plugin/install.sh` so the default `PLUGIN_SRC` points at `https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.hermes-plugin`.
- [x] 18.2 Verify the local-dev usage example references `PLUGIN_SRC="$(pwd)/apps/plugin/.hermes-plugin"`.

## 19. Update root `README.md`

- [x] 19.1 Update the "Supported agents" table install commands to use the new `apps/plugin/.X-plugin/install.sh` URLs for curl-pipe-sh clients.
- [x] 19.2 Update marketplace install commands to reference the new `marketplace.json::source` paths (no user-visible change to the marketplace command itself, but verify text accuracy).
- [x] 19.3 Update any `./plugin/...` repo-internal links to `./apps/plugin/...`.
- [x] 19.4 Update the Docker quickstart curl URLs if they reference `docker-compose.yml` from the root (no change expected — those stay at root).

## 20. Update `apps/plugin/README.md`, `apps/plugin/CHANGELOG.md`, and per-client READMEs

- [x] 20.1 Edit `apps/plugin/README.md`: update the install table install URLs to point at `apps/plugin/.X-plugin/...` paths; remove the lock-step language from the introduction; explain the per-component versioning briefly.
- [x] 20.2 Edit `apps/plugin/CHANGELOG.md`: do NOT rewrite historical entries (they are immutable). Add a new top-section entry describing the restructure, the new release-please component layout, and the breaking URL changes.
- [x] 20.3 Edit `apps/plugin/.opencode-plugin/README.md`: update install URLs to `apps/plugin/.opencode-plugin/install.sh`. Update the local-dev example commands.
- [x] 20.4 Edit `apps/plugin/.hermes-plugin/README.md`: update install URL to `apps/plugin/.hermes-plugin/install.sh`.

## 21. Update `docs/agents.md`

- [x] 21.1 Replace every occurrence of `plugin/.claude-plugin/` with `apps/plugin/.claude-plugin/`, `plugin/.codex-plugin/` with `apps/plugin/.codex-plugin/`, `plugin/.hermes-plugin/` with `apps/plugin/.hermes-plugin/`, `plugin/.opencode-plugin/` with `apps/plugin/.opencode-plugin/`.
- [x] 21.2 Replace `plugin/bin/` with `apps/plugin/bin/`, `plugin/hooks/` with `apps/plugin/hooks/`, `plugin/scripts/` with `apps/plugin/scripts/`, `plugin/commands/` with `apps/plugin/commands/`.
- [x] 21.3 Replace the install URL `raw.githubusercontent.com/.../main/plugin/.X-plugin/install.sh` references with `raw.githubusercontent.com/.../main/apps/plugin/.X-plugin/install.sh`.

## 22. Update `docs/docker.md`

- [x] 22.1 Grep `docs/docker.md` for `src/`, `plugin/`, `Dockerfile`, and replace with `apps/server/src/`, `apps/plugin/`, `apps/server/Dockerfile` as appropriate.
- [x] 22.2 Verify the Docker run examples still produce valid command strings.

## 23. Update `CLAUDE.md`

- [x] 23.1 Edit the `## Architecture` paragraph to use `apps/server/src/{...}` and `apps/plugin/` paths.
- [x] 23.2 Edit `### Load-bearing invariants` paths: `src/services/...` → `apps/server/src/services/...`; `scripts/seed-dev.ts` → `apps/server/src/scripts/seed-dev.ts` (seed stays TypeScript per task 11); `src/test/invariants.test.ts` → `apps/server/src/test/invariants.test.ts`; `src/mcp/tools.ts` → `apps/server/src/mcp/tools.ts`.
- [x] 23.3 Edit `## Dashboard conventions` paths: `src/dashboard/...` → `apps/server/src/dashboard/...` (three references).
- [x] 23.4 Edit `## Code style` co-located-tests line to `**/*.test.ts (each workspace)` and the invariants path to `apps/server/src/**/__tests__/invariants/`.
- [x] 23.5 Edit `## Skills` rembric-plugin-development bullet: "before touching anything under `plugin/`" → "before touching anything under `apps/plugin/`".
- [x] 23.6 Rewrite `## Plugin development discipline` bullets:
  - Bullet 1: update path to `apps/plugin/bin/rembric-dotenv.mjs` and `apps/server/src/test/invariants.test.ts`.
  - Bullet 2: REPLACE the lock-step text entirely with: "Per-component versioning. Each `apps/plugin/.X-plugin/` is its own release-please component. `claude-code` and `codex` are linked (cascade on shared `bin/`+`hooks/`+`commands/`+`scripts/` changes). `hermes` and `opencode` bump independently."
  - Bullet 3: update path to `apps/server/src/mcp/tools.ts`.
  - Bullet 4: update path to `git ls-files apps/plugin/` and keep the rest verbatim.

## 24. Update `CONTRIBUTING.md` and `RELEASING.md`

- [x] 24.1 Edit `CONTRIBUTING.md`: replace any `plugin/` or `src/` path references with the new `apps/...` paths. Verify the "Adding a dependency" section still points at the npm-security-best-practices skill.
- [x] 24.2 Rewrite `RELEASING.md` to explain the 5-component model: how to read `release-please-config.json`, how component-prefixed tags work, how docker-publish is gated, and the procedure for the first release after the restructure (`server-v0.18.0`).

## 25. Update `.agents/skills/rembric-plugin-development/`

- [x] 25.1 Edit `.agents/skills/rembric-plugin-development/SKILL.md`: replace every `plugin/` path with `apps/plugin/`; update the four clients section if it references specific paths; replace the "version lock-step across four sources" text with the per-component versioning explanation.
- [x] 25.2 Edit `.agents/skills/rembric-plugin-development/references/per-client-gotchas.md`: replace paths.
- [x] 25.3 Edit `.agents/skills/rembric-plugin-development/references/e2e-walkthrough.md`: replace paths; update install commands; verify the dev-stack invocation (`pnpm run dev:docker:up`) still appears verbatim.

## 26. Update inline doc comments in bridge and dotenv

- [x] 26.1 Edit the comment block at the top of `apps/plugin/bin/rembric-dotenv.mjs`: update the list of consumers from `plugin/bin/rembric-bridge.mjs` / `plugin/.opencode-plugin/plugin.ts` / `plugin/scripts/_api.sh` / `plugin/.hermes-plugin/__init__.py` to use `apps/plugin/...` paths.
- [x] 26.2 Edit any `// path:` style header comment in `apps/plugin/bin/rembric-bridge.mjs` similarly.

## 27. Sweep `openspec/specs/**/*.md` (specs not modified by this change)

- [x] 27.1 `grep -rn 'plugin/' openspec/specs/` and review each hit. For each match that is INSIDE this change's spec deltas, skip. For matches in OTHER specs (capabilities not modified by this change), update path inline as a sweep edit.
- [x] 27.2 Verify `openspec/changes/archive/**` is NOT modified (historical specs are immutable).
- [x] 27.3 Run `openspec validate --strict` to confirm no spec sweep broke an unrelated capability.

## 28. Update `apps/server/src/test/invariants.test.ts` allow-list paths

- [x] 28.1 Open the `invariants.test.ts` file in its new location. Verify the `FORBIDDEN` rules' `allow` entries reference the right paths relative to `apps/server/src/` (`services/memory.ts` and `scripts/seed-dev.ts` — seed stays TypeScript per task 11).
- [x] 28.2 Verify the invariant test for `rembric-dotenv.mjs is THE single source of truth` references `apps/plugin/bin/rembric-dotenv.mjs` (the new canonical path).
- [x] 28.3 Run `pnpm -F @rembric/server vitest run src/test/invariants.test.ts` and confirm all invariants pass.

## 29. Local CI matrix dry-run

- [x] 29.1 `pnpm install --frozen-lockfile` — succeeds.
- [x] 29.2 `pnpm run typecheck` (root) — exits clean across all workspaces.
- [x] 29.3 `pnpm run lint` — exits clean.
- [x] 29.4 `pnpm test` — all suites pass, including the per-workspace tests and the Hermes Python unittest call (verify it picks up `apps/plugin/.hermes-plugin/tests/`).
- [x] 29.5 `pnpm run build` (via `pnpm -r build` or equivalent) — produces `apps/server/dist/`.
- [x] 29.6 `docker compose -f docker-compose.yml build` — runtime image builds.
- [x] 29.7 `docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build` — dev container reaches `healthy`, dashboard renders, then teardown with Ctrl-C.

## 30. Re-validate the OpenSpec change after implementation

- [x] 30.1 `openspec validate restructure-monorepo-apps-layout --strict` — exits clean (verified 2026-05-20).
- [x] 30.2 `git diff --stat main..HEAD` — all touched files belong to the restructure scope (server moves, plugin moves, package.json/workspace/release-please rewrites, Docker + compose path updates, docs sweeps, skill sweeps, hermes-tests nesting, dev-seed Dockerfile fix, no-shim cutover, openspec specs sweep). No unrelated files.

## 31. Operator-only steps (perform manually post-merge)

- [ ] 31.1 **Operator-only**: After PR merge to `main`, release-please opens five release PRs (or one combined PR depending on the action version). Merge them in order: server first (to validate Docker publish), then the linked `claude-code` + `codex` PR, then `hermes` and `opencode` individually as PRs appear.
- [ ] 31.2 **Operator-only**: After the first `server-v0.18.0` release-please PR merges, monitor `docker-publish.yml`. Verify `ghcr.io/susomejias/rembric:0.18.0` appears, the smoke test passes, and `:latest` is promoted.
- [ ] 31.3 **Operator-only**: Re-run Spike 1 + Spike 2 against the just-merged `main` to confirm marketplace installs work for real users in real environments.
- [x] 31.4 N/A — no legacy install shims were created (Decision 6), so no follow-up cleanup change is required.
- [ ] 31.5 **Operator-only**: Coordinate with `add-data-protection-defaults` change in-flight — rebase whichever change is second onto the first's new paths before its own merge.

## 32. Communication

- [ ] 32.1 Draft and publish a GitHub Release note for `server-v0.18.0` that calls out: (1) the move to apps/+packages monorepo; (2) the BREAKING change to public install URLs (hard 404 cutover — no shim files; canonical install commands documented in README + docs); (3) the new component-prefixed tag format; (4) the linked-versions group for marketplaces; (5) the unchanged server semantics (no migration needed for operators pulling the new image).
- [ ] 32.2 Pin a GitHub Discussion or Issue summarising the change for users searching for the old `raw.githubusercontent.com/.../main/plugin/...` URLs.
