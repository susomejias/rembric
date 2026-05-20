## Context

Rembric today is a single release-please package rooted at the repo level. `release-please-config.json` declares one entry (`.`) producing tags like `v0.17.0`; the `.release-please-manifest.json` carries one version. The repo's tree mixes the Node server (`src/`, `scripts/`, `Dockerfile`, root `tsconfig`), the multi-client plugin (`plugin/.{claude,codex,hermes,opencode}-plugin/` + shared `bin/` `hooks/` `commands/` `scripts/`), and repo-level governance (`docs/`, `openspec/`, marketplace manifests at `.claude-plugin/marketplace.json` and `.codex-plugin/marketplace.json`).

The marketplace manifests at the repo root each carry a single pointer (`source` for Claude Code, `source.path` for Codex with `source.source: "git-subdir"`) that designates which subdirectory the marketplace consumer extracts as the plugin root. Both currently point to `"./plugin"`. The curl-pipe-sh installers for Hermes and opencode read from hard-coded `raw.githubusercontent.com/.../main/plugin/...` URLs.

Two recent commits show the cost of the single-package model concretely: `9f7fbe4 feat(plugin)` and `52eddf2 feat(plugin)` both produced new GHCR Docker images via release-please → docker-publish, despite `src/` being untouched.

Stakeholders: the repo owner (Suso) for distribution decisions, contributors (CLAUDE.md + skills as their north star), and end users of the four plugin clients (their install commands and marketplace URLs are the public-facing surface this change touches).

## Goals / Non-Goals

**Goals:**

- Decouple the Docker release line from the plugin release lines so a plugin-only commit never publishes a new GHCR image.
- Adopt the industry-standard `apps/` + `packages/` monorepo layout with pnpm workspaces so the repo structure communicates where deliverables vs. shared libraries live (even if `packages/` starts empty).
- Give each plugin client its own release line and CHANGELOG so a Hermes-only fix releases only Hermes, not all four plugins.
- Keep marketplace consumers (Claude Code + Codex) working with zero changes on their side, except for the `marketplace.json` pointer update inside this repo.
- Document the new layout and release model in `CLAUDE.md` and `RELEASING.md` so the contract is durable.
- Preserve every load-bearing memory invariant verbatim — this change is layout + release-pipeline, not behavior.

**Non-Goals:**

- Publishing the bridge as an npm package (was a separate decision recorded 2026-05-15; deferred — would need its own change because the trade-off matrix changed when the user rejected the canonical-with-sync pattern).
- Introducing `tooling/` for shared eslint/tsconfig. With two workspaces, the value is too low.
- Introducing Turborepo. No grafo of dependent packages exists; `tsc -b` and `pnpm -r` are sufficient.
- Extracting the bridge or dotenv into `packages/bridge/` or `packages/plugin-core/`. The owner explicitly rejected the duplication-with-sync pattern this would require.
- Any change to MCP tools, dashboard, server logic, or persistence. This change is filesystem-mechanical only.
- Maintaining error shims at `plugin/.hermes-plugin/install.sh` and `plugin/.opencode-plugin/install.sh`. The owner chose a hard cutover (404) over shim files — see Decision 6.

## Decisions

### Decision 1: `apps/` + `packages/` with `packages/` initially empty

Adopt the convention used by Turborepo/Nx templates and most modern JS monorepos: deliverables under `apps/`, shared libraries under `packages/`. The two deliverables in scope are `apps/server` (the Node process / Docker image) and `apps/plugin` (the multi-client plugin tree). `packages/` is created but empty, signalling that the structure is in place for future extractions (e.g., the bridge if/when it becomes an npm package).

**Alternatives considered:**

- _Keep `plugin/` at root, only move `src/` → `apps/server/`_: lighter touch, but inconsistent — half the repo follows the convention and half doesn't. The owner explicitly asked for a fully restructured layout reflecting the packages with industry-standard convention.
- _Flat `packages/_` for everything\*: works for libs-only monorepos (e.g., a single npm scope publishing many packages). Less common for repos that ship apps alongside libs. The apps/+packages split makes the deliverable-vs-library distinction visible at a glance.
- _Per-client app dirs (`apps/plugin-claude-code/`, `apps/plugin-codex/`, etc.) with shared canonical sources in `packages/`_: explored in detail. Required a canonical-with-sync pattern (commit-time duplication of bridge/dotenv/hooks into each app's bundle) because marketplaces extract a single subdirectory. The owner rejected this approach as error-prone. Filed alternatives (npm publish via `npx`, build-time bundling on a release branch) but those have their own blockers (npm publish was previously declined; build-time bundling is over-engineering for current volume).

### Decision 2: `apps/plugin/` remains a single unified directory

Keep the four client manifests (`.claude-plugin/`, `.codex-plugin/`, `.hermes-plugin/`, `.opencode-plugin/`) and the shared `bin/` `hooks/` `commands/` `scripts/` under one `apps/plugin/` directory. Both marketplace consumers extract this entire directory; the unified layout means each manifest references shared code via existing relative paths (e.g., `${CLAUDE_PLUGIN_ROOT}/bin/rembric-bridge.mjs`) without any duplication.

**Alternatives considered:**

- _Four separate app dirs with synced bundles_: rejected (see Decision 1 alternative).
- _Four separate app dirs with symlinks across to a `packages/plugin-core`_: rejected. Codex `source.source: "git-subdir"` extracts only the targeted subtree; symlinks pointing outside the subtree don't resolve at the consumer end. Claude Code's behavior on cross-tree symlinks is undocumented and untrusted.

### Decision 3: Five release-please components with one linked-versions group

Configure release-please in manifest mode with these packages:

```jsonc
{
  "packages": {
    "apps/server": {
      "release-type": "node",
      "component": "server",
      "include-component-in-tag": true,
      "package-name": "@rembric/server",
    },
    "apps/plugin/.claude-plugin": {
      "release-type": "simple",
      "component": "claude-code",
      "include-component-in-tag": true,
      "extra-files": ["plugin.json"],
    },
    "apps/plugin/.codex-plugin": {
      "release-type": "simple",
      "component": "codex",
      "include-component-in-tag": true,
      "extra-files": ["plugin.json"],
    },
    "apps/plugin/.hermes-plugin": {
      "release-type": "simple",
      "component": "hermes",
      "include-component-in-tag": true,
      "extra-files": ["plugin.yaml"],
    },
    "apps/plugin/.opencode-plugin": {
      "release-type": "node",
      "component": "opencode",
      "include-component-in-tag": true,
      "extra-files": [{ "type": "generic", "path": "plugin.ts" }],
    },
  },
  "plugins": [
    {
      "type": "linked-versions",
      "groupName": "bridge-bundlers",
      "components": ["claude-code", "codex"],
    },
  ],
}
```

Why `linked-versions` for `claude-code` + `codex`: both marketplaces extract `apps/plugin/` as a self-contained root and consume the shared `bin/`, `hooks/`, `commands/`, `scripts/` directly. A change to any of those shared paths reaches Claude Code AND Codex users via marketplace re-pull; both clients deserve a coordinated version bump and changelog entry. `hermes` and `opencode` are excluded from the group because their `install.sh` re-fetches from `raw.githubusercontent.com/.../main/...` on every install — shared changes already propagate to their users on next reinstall without requiring a coordinated release.

Tag format moves from `vX.Y.Z` to `<component>-vX.Y.Z` (e.g., `server-v0.18.0`, `claude-code-v0.9.0`). This change is irreversible for anyone with old tag-based URLs, but unavoidable for multi-component release-please.

**Alternatives considered:**

- _Path-routing via custom GitHub Action_: a workflow that inspects diff against the previous release and decides which components need bumping. More precise than `linked-versions` but requires custom code and a per-PR computation step. Saved for later if the linked-versions group becomes too coarse.
- _No linked-versions; commit-scope routing_: rely on developers writing `feat(claude-code,codex): ...` for shared changes. Manual, error-prone.

### Decision 4: docker-publish gated on `server` releases only

`release-please.yml` reads `paths_released` from the release-please action output. The `publish-docker` job's `if:` condition becomes `fromJSON(needs.release-please.outputs.paths_released)['apps/server'] != null`. Other components releasing in the same run (linked claude-code + codex, for instance) do not trigger docker-publish.

If the release-please action's output shape differs in the pinned version (e.g., `releases_created` is keyed by component name instead of path), the condition uses whichever key release-please actually emits — verified against the action's release notes during implementation.

### Decision 5: First server release after refactor is a minor bump

The first release-please PR after this change lands cuts `server-v0.18.0` (minor), not `v1.0.0` (major). Rationale: the server's runtime semantics — MCP API, HTTP endpoints, dashboard, persistence, all CLI-equivalents — are byte-identical. Only the source location and the release lane changed. A major bump would mis-signal a breaking server change that isn't there.

The user-facing breakage (install URLs, marketplace.json pointer, tag format) is communicated as **BREAKING** in the release notes of each affected component independently. End users of the plugin clients see those notes when their bookmarked URL 404s (per Decision 6) or when they get the new release notification.

### Decision 6: No legacy install-URL shims — hard cutover

After deliberation the owner chose NOT to keep error shims at `plugin/.hermes-plugin/install.sh` / `plugin/.opencode-plugin/install.sh`. Users with bookmarked `curl ... main/plugin/...` commands will receive a plain raw.githubusercontent.com 404 until they update their install command.

Rationale: the install URL is documented in `README.md`, `docs/agents.md`, and the per-client `README.md`s; bookmarked one-liners are rare in practice and the 404 is short, unambiguous, and forces re-reading the docs. Maintaining shim files (and remembering to delete them in 3-6 months) was deemed more drag than the marginal UX recovery.

The release notes for the first plugin release post-restructure (`hermes-vX.Y.Z`, `opencode-vX.Y.Z`) MUST call out the URL change as **BREAKING** so anyone hitting the 404 has a single place to land that explains the move.

**Alternatives considered:**

- _Keep 3–6 month error shims that print the new URL and exit 1_: original design, rejected by the owner as more drag (maintenance + scheduled removal) than the marginal UX recovery is worth.
- _Silently rewrite the curl target_ in the shim using `sed` and `eval`: opaque magic; users should learn what changed, not have it papered over.
- _Keep the shims indefinitely_: clutter with no end-of-life.

### Decision 7: Bridge and dotenv stay at `apps/plugin/bin/`

Do not move `rembric-bridge.mjs` or `rembric-dotenv.mjs` to `packages/`. They remain inside the plugin app directory. The existing invariant — that `rembric-dotenv.mjs` is the only JS/TS implementation of `parseDotenv` + `readRembricSlug` + `SLUG_RE` — continues to hold; only its path moves (`apps/plugin/bin/rembric-dotenv.mjs`). The invariant test enforces this from its new home at `apps/server/src/test/invariants.test.ts`.

**Alternatives considered:**

- _Extract bridge to `packages/bridge/` now_: explored at length. Requires commit-time duplication of `bin/rembric-bridge.mjs` into both `apps/plugin-claude-code/bin/` and `apps/plugin-codex/bin/` (marketplaces extract a subtree, can't follow cross-tree references). A `pnpm sync-plugin-bundles` script + pre-commit hook + invariant test would enforce the duplication. The owner rejected this as a maintenance burden and source of drift bugs.
- _Bridge as npm package (`@rembric/bridge`) consumed via `npx` in plugin manifests_: the cleanest industry-standard pattern. Defers cleanly to a future change; needs an npm publishing decision the owner has previously postponed.

## Risks / Trade-offs

[Risk] **Marketplace.json `source` pointer to `./apps/plugin` may not be accepted by Claude Code or Codex marketplace consumers.** Today both manifests point to `./plugin`, a flat repo-root subdir. Whether `./apps/plugin` (nested two levels) is also accepted is undocumented for Claude Code's `source` field and undocumented for Codex's `source.path` with `source.source: "git-subdir"`. → **Mitigation**: Spike 1 and Spike 2 (below) validate both paths against a local clone before implementation begins. If either spike fails, design.md updates to use a workaround (e.g., a top-level wrapper symlink or a script that maintains the legacy `plugin/` path as a checkout-time symlink).

[Risk] **Codex plugin cache invalidation on existing users.** Codex caches plugins by version at `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/`. After this change, the plugin version bumps (linked-versions group) — Codex sees a new version, invalidates the cache, and re-fetches from the new `marketplace.json::source.path`. This is the intended behaviour but depends on Codex's reading of the new manifest succeeding. → **Mitigation**: Spike 2 covers this end-to-end with a real `codex plugin update rembric` against a local repo clone.

[Risk] **Old tag URLs in third-party docs or scripts (`v0.17.0`, `v0.16.0`) become orphaned**. They continue to exist as git tags forever, but they map to a different release line than the new `server-v0.18.0+` series. → **Mitigation**: RELEASING.md and the first server release notes explicitly document the tag prefix change and the version reset rationale.

[Risk] **The `add-data-protection-defaults` change in flight references paths that this change moves**. → **Mitigation**: coordinate sequencing. If `add-data-protection-defaults` lands first, this change rebases its task list to reference the post-data-protection paths. If this change lands first, `add-data-protection-defaults` rebases. Owner decides ordering before either is merged.

[Trade-off] **`packages/` starts empty.** Looks weird for a few months. → Accepted because it's a clear signal that the layout is ready for future extractions (bridge npm, plugin-core, etc.) and removes the friction of "we'd need to restructure first" when those extractions become real drivers.

[Trade-off] **Tag format changes from `vX.Y.Z` to `<component>-vX.Y.Z`.** → Accepted because it's the canonical release-please multi-component output; trying to keep `vX.Y.Z` for the server while using component prefixes for plugin tags would require custom config that complicates downstream tooling (release notes, CHANGELOG generators, git tooling).

[Trade-off] **No bridge npm publish in this change.** → Accepted because publishing the bridge has its own decision matrix (registry choice, PAT vs public, fallback for marketplaces that can't use npx). Bundling it here would expand scope to a level the owner doesn't want. The structural layout supports adding it later cleanly.

## Migration Plan

### Pre-implementation spikes (gates the apply)

**Spike 1 — Claude Code marketplace consumes nested `./apps/plugin`**: In a clean test environment (VM or container), check out a branch with `.claude-plugin/marketplace.json::source` set to `"./apps/plugin"` and the relocated tree. Execute `claude plugin marketplace add file:///path/to/local/repo` and `claude plugin install rembric@rembric`. Verify the install succeeds, `${CLAUDE_PLUGIN_ROOT}/bin/rembric-bridge.mjs` resolves at runtime, and `memory.context` returns a result. Document the exact Claude Code version tested in `tasks.md`. Fail-condition response: keep `marketplace.json::source = "./plugin"` and add a checkout-time symlink (`plugin → apps/plugin`) generated by a `prepare` script in root `package.json`.

**Spike 2 — Codex marketplace consumes nested `./apps/plugin` via git-subdir**: same shape as Spike 1 but for Codex CLI. `codex plugin marketplace add <local-repo-url>` and `codex plugin install rembric`. Verify the plugin appears under `~/.codex/plugins/cache/rembric/<new-version>/` with the expected file tree (manifest + `bin/` + `hooks/` + `scripts/`). Fail-condition response: same as Spike 1 (symlink fallback).

### Implementation order (assumes spikes pass)

1. **Branch setup**: create `feat/restructure-monorepo-apps-layout`. All work happens on this branch; merge as a single PR.
2. **Move files (`git mv`)** in dependency order: `plugin/` → `apps/plugin/` first (lowest cross-reference count), then `src/` + `scripts/` → `apps/server/`, then `Dockerfile`, `drizzle.config.ts`, `vitest.config.ts`, `tsconfig*.json`, root `CHANGELOG.md`. Verify `git status` shows renames not adds+deletes for each batch.
3. **Add workspace package.json files**: `apps/server/package.json` (copy server-relevant scripts + deps from root), `apps/plugin/package.json` (new, stub identifying `@rembric/plugin`). Update root `package.json` to keep only workspace-level scripts.
4. **Update `pnpm-workspace.yaml`**: add `packages: [apps/*, packages/*]` while preserving the existing supply-chain policy block (`allowBuilds`, `blockExoticSubdeps`, `minimumReleaseAge`).
5. **Update docker-compose files** to reference `apps/server/Dockerfile`. Verify the build still completes (`pnpm run dev:docker:up` smoke test).
6. **Rewrite `release-please-config.json`** with the 5-package manifest. Reset `.release-please-manifest.json` to the 5 starting versions: `apps/server: 0.17.0`, `apps/plugin/.claude-plugin: 0.8.0`, `apps/plugin/.codex-plugin: 0.8.0`, `apps/plugin/.hermes-plugin: 0.8.0`, `apps/plugin/.opencode-plugin: 0.8.0` (these match the current plugin manifest versions; the next release advances each).
7. **Update `.github/workflows/release-please.yml`**: change the docker-publish job's `if:` to gate on `apps/server` being in `paths_released`.
8. **Update both `marketplace.json` files**: `source` / `source.path` from `"./plugin"` to `"./apps/plugin"`.
9. **(skipped per Decision 6)** No legacy install.sh shims are created under `plugin/.hermes-plugin/` or `plugin/.opencode-plugin/`. Bookmarked old URLs return HTTP 404; the breakage is announced in the post-restructure plugin release notes and remains discoverable via the canonical install commands in `README.md` / `docs/agents.md`.
10. **Sweep documentation** in a single commit: README.md, `docs/agents.md`, `docs/docker.md`, `CONTRIBUTING.md`, `RELEASING.md`, the three skill files, the in-code comments in `apps/plugin/bin/rembric-bridge.mjs` and `apps/plugin/bin/rembric-dotenv.mjs`, and any `openspec/specs/**/*.md` references (with `grep -rn 'plugin/'` + manual review).
11. **Update CLAUDE.md** with the path swaps and the rewritten Plugin development discipline section.
12. **Update `apps/server/src/test/invariants.test.ts`** allow-list paths (no behavior change, just path strings).
13. **Run the full CI matrix locally**: `pnpm install --frozen-lockfile`, `pnpm run typecheck`, `pnpm run lint`, `pnpm test`, `pnpm run build`, `docker compose -f docker-compose.yml build`, `docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build` (smoke test, then teardown).
14. **Run spike validations** (Spike 1 + Spike 2) one more time against the final branch HEAD.
15. **PR + review**: single PR, mark `BREAKING` in title for external URL changes. Merge after CI green + owner approval.

### Rollback

If post-merge a critical path break is discovered (e.g., a marketplace consumer rejects the new `marketplace.json::source`):

1. **Revert PR via GitHub UI** — single atomic revert because the change is one PR.
2. The marketplace consumers continue resolving from `./plugin` (the original layout returns).
3. `release-please-config.json` reverts to the single-package form; release-please re-syncs the manifest on next merge to main.

Since no shim files were placed under `plugin/`, rollback simply restores the pre-restructure tree and cancels nothing on the user side beyond the URL change announcement.

## Open Questions

1. **Codex plugin cache key**: does `~/.codex/plugins/cache/rembric/...` key by plugin name + version, or also by marketplace.json digest? Spike 2 must confirm that updating `marketplace.json::source.path` plus bumping the plugin version triggers a clean re-fetch.
2. **release-please action output keys**: `paths_released` vs `releases_created` vs another shape — depends on the pinned release-please-action version. Implementation step 7 verifies against actual action behavior; if neither matches, fall back to `tag_name` parsing.
3. **Coordination with `add-data-protection-defaults`**: which lands first? Pending owner decision; both PRs reference each other's paths.
