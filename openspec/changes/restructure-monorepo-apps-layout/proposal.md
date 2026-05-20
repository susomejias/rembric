## Why

The repo is a single release-please package at the root. Every conventional commit — including those that touch only `plugin/` or docs — bumps the global `rembric` version and triggers `docker-publish.yml`, publishing a new GHCR image even though `src/` was never touched. Recent evidence: commits `9f7fbe4 feat(plugin)` → `90497b5 release 0.16.0` and `52eddf2 feat(plugin)` → `bf67c45 release 0.17.0` both shipped a Docker image without any server code change. This is wasted CI minutes, wasted registry storage, and confusing release notes that bundle unrelated changes under a single `rembric` version.

The fix is structural: move to an industry-standard `apps/` + `packages/` monorepo with pnpm workspaces, and configure release-please as 5 independent components so each release line advances at its own pace. Docker publish becomes gated on the `server` component only.

## What Changes

- **BREAKING (external)** Move `src/` and root `scripts/` into `apps/server/`. Move `plugin/` into `apps/plugin/`. Add `packages/` as an empty staging directory for future extractions. No code semantics change — pure relocation.
- **BREAKING (external)** Migrate release-please from a single `.` package to a 5-component manifest: `server`, `claude-code`, `codex`, `hermes`, `opencode`. Tags change from `vX.Y.Z` to `<component>-vX.Y.Z`. The `claude-code` and `codex` components are linked via release-please's `linked-versions` plugin (group `bridge-bundlers`) so shared changes under `apps/plugin/bin/` `hooks/` `commands/` `scripts/` cascade to both marketplace plugins. `hermes` and `opencode` stay independent (their installers re-fetch from `main` at install-time).
- **BREAKING (external)** `docker-publish.yml` is no longer triggered by every release. It runs only when `server` is in `paths_released`. The first release after this change cuts `server-v0.18.0` (minor bump — semantics unchanged, only layout moved).
- **BREAKING (external)** Public install URLs move from `raw.githubusercontent.com/.../main/plugin/...` to `.../main/apps/plugin/...`. The two `marketplace.json` files at the repo root update their `source` / `source.path` pointers from `"./plugin"` to `"./apps/plugin"`. No shim files are left under `plugin/` — bookmarked old URLs receive a plain 404; the breakage is called out in the first post-restructure plugin release notes.
- Adopt pnpm workspaces with `packages: [apps/*, packages/*]` in `pnpm-workspace.yaml` (existing supply-chain policy entries — `allowBuilds`, `blockExoticSubdeps`, `minimumReleaseAge` — stay verbatim). Two workspace members in this change: `@rembric/server` and `@rembric/plugin`.
- Move `Dockerfile`, `drizzle.config.ts`, `vitest.config.ts`, and `tsconfig.{json,build.json}` into `apps/server/`. `docker-compose.yml`, `docker-compose.dev.yml`, `docker-compose.build.yml` update to `dockerfile: apps/server/Dockerfile` with `context: .`.
- Bridge and dotenv stay at `apps/plugin/bin/` as the single source. **No extraction to `packages/bridge/` and no canonical-with-sync pattern.** The existing invariant that `rembric-dotenv.mjs` is the only JS/TS implementation of `parseDotenv` + `readRembricSlug` + `SLUG_RE` continues — only its path changes.
- The version-lock-step rule across the four plugin manifests is **removed** and replaced by per-component versioning with the `bridge-bundlers` cascade.
- Coordinated docs sweep: `README.md`, `apps/plugin/README.md`, `apps/plugin/.opencode-plugin/README.md`, `apps/plugin/.hermes-plugin/README.md`, `docs/agents.md`, `docs/docker.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `RELEASING.md`, the three files under `.agents/skills/rembric-plugin-development/`, and any `openspec/specs/**/*.md` mentioning the moved paths.

## Capabilities

### New Capabilities

(none — this change reshapes existing capabilities; it does not introduce new ones.)

### Modified Capabilities

- `development-environment`: bind-mount paths in `docker-compose.dev.yml` move from `./src:/app/src` to `./apps/server/src:/app/src`; the Dockerfile relocates to `apps/server/Dockerfile`; the seed script moves from `src/scripts/seed-dev.ts` to `apps/server/src/scripts/seed-dev.ts` (stays TypeScript, invoked via `tsx`); pnpm workspace declaration is added with two members.
- `open-source-distribution`: release-identity surfaces split into 5 lanes; tag format adds component prefix; release-pipeline section formalizes the multi-component release-please configuration and the docker-publish gate; install URLs in README requirement update to `apps/plugin/...` paths; legacy URLs return 404 (no shim).
- `claude-code-plugin`: plugin root moves from `plugin/` to `apps/plugin/`; `.claude-plugin/marketplace.json::source` updates from `"./plugin"` to `"./apps/plugin"`; the lock-step versioning requirement is removed and replaced with the `claude-code` release-please component and its participation in the `bridge-bundlers` linked-versions group.
- `codex-distribution`: same shape as claude-code — root path move, marketplace.json::source.path update, lock-step requirement removed in favor of independent `codex` component participating in `bridge-bundlers`.
- `hermes-agent-plugin`: install.sh URL moves; plugin source path under git tree updates; `hermes` becomes its own release-please component (no linked-versions group — Hermes does not bundle the bridge).
- `opencode-plugin`: install.sh + BIN_SRC URLs move; `opencode` becomes its own release-please component (no linked-versions group).

## Impact

**Affected files (filesystem moves)**:

- `src/**` → `apps/server/src/**`
- `scripts/**` → `apps/server/scripts/**`
- `Dockerfile` → `apps/server/Dockerfile`
- `drizzle.config.ts` → `apps/server/drizzle.config.ts`
- `vitest.config.ts` → `apps/server/vitest.config.ts`
- `tsconfig.json`, `tsconfig.build.json` → `apps/server/`
- `plugin/**` → `apps/plugin/**` (no internal reshuffle)
- `CHANGELOG.md` (root) → `apps/server/CHANGELOG.md`
- `plugin/CHANGELOG.md` → `apps/plugin/CHANGELOG.md`

**Affected files (content edits only)**:

- `.claude-plugin/marketplace.json` — `plugins[0].source` value
- `.codex-plugin/marketplace.json` — `plugins[0].source.path` value
- `docker-compose.yml`, `docker-compose.dev.yml`, `docker-compose.build.yml` — Dockerfile path
- `release-please-config.json` — full rewrite, 5 packages
- `.release-please-manifest.json` — 5 entries seeded
- `.github/workflows/release-please.yml` — docker-publish gating condition
- `pnpm-workspace.yaml` — add `packages:` block (keep existing policy entries)
- `package.json` (root) — strip server-specific scripts (move to `apps/server/package.json`), keep workspace-level scripts
- `CLAUDE.md` — paths in Architecture / Load-bearing invariants / Dashboard conventions / Code style / Skills, plus full rewrite of Plugin development discipline bullet 2 (lock-step → per-component)
- `README.md`, `docs/agents.md`, `docs/docker.md`, `CONTRIBUTING.md`, `RELEASING.md` — path sweep
- `.agents/skills/rembric-plugin-development/SKILL.md` and `references/per-client-gotchas.md` and `references/e2e-walkthrough.md` — path sweep
- `apps/server/src/test/invariants.test.ts` — allow-list paths (`services/memory.ts` and `scripts/seed-dev.ts` stay relative to `src/`; seed remains TypeScript); the rembric-dotenv single-source invariant updates to `apps/plugin/bin/rembric-dotenv.mjs`
- No legacy `plugin/.hermes-plugin/install.sh` or `plugin/.opencode-plugin/install.sh` shims — old URLs return 404; release notes communicate the move.

**Invariants affected**:

- The append-only memory contract is **unchanged** in substance. Only paths in the `apps/server/src/test/invariants.test.ts` allow-list shift.
- The `rembric-dotenv.mjs is THE single source` invariant is **unchanged** in substance — only the path moves.
- The plugin version lock-step invariant is **removed** by this change (replaced by per-component versioning).

**Downstream**:

- Anyone bookmarking the old `raw.githubusercontent.com/.../plugin/...` URLs receives a plain 404. The breakage is documented in the first post-restructure `hermes-*` and `opencode-*` release notes (per Decision 6 in design.md).
- Codex marketplace caches by `version` under `~/.codex/plugins/cache/`; the new component-prefixed tags invalidate stale caches naturally on first `codex plugin update`.
- The `add-data-protection-defaults` change is in-flight (`openspec/changes/add-data-protection-defaults/`); paths it references will need a follow-up rebase after this change lands. Coordinate sequencing.
