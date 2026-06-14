## Why

The 2026-06-14 `collapse-plugin-release-components` change folded Claude Code + Codex + shared assets into one `plugin-shared` component to escape the `linked-versions` auto-tag bug ([release-please#1946](https://github.com/googleapis/release-please/issues/1946)). It works and is stable, but it bought stability with a misnomer and lock-step: touching a Claude-only file forces a Codex bump (and vice versa), `plugin-shared` no longer means "shared", and the per-client tags/CHANGELOGs are gone. The collapse was the minimum-stable fix under pressure (releases broke twice in one day), not the considered optimum — the `node-workspace` plugin, which gives independent per-client versions **and** cascades shared-asset bumps, was never evaluated. This change adopts it.

## What Changes

- **Re-introduce `claude-code-plugin` and `codex-plugin` as independent release-please components** keyed at `apps/plugin/.claude-plugin` and `apps/plugin/.codex-plugin` (`release-type: node`), each carrying its own version, tag (`claude-code-plugin-vX.Y.Z`, `codex-plugin-vX.Y.Z` — resuming the frozen tag lines), and CHANGELOG.
- **Add a minimal `package.json` to each client dir** (`apps/plugin/.claude-plugin/package.json`, `.codex-plugin/package.json`) declaring `private: true` and a dependency on `@rembric/plugin` (the shared root package at `apps/plugin`). These are release-please dependency-graph nodes + version carriers, NOT pnpm workspace members — the `apps/*` workspace glob does not match nested dirs, so `pnpm install` ignores them and the lockfile is untouched.
- **Enable the `node-workspace` release-please plugin with `merge: false`.** When `@rembric/plugin` (shared assets) bumps, node-workspace patch-bumps every dependent (`claude-code-plugin`, `codex-plugin`) in its **own separate release PR**. `merge: false` is load-bearing: it keeps node-workspace from combining the dependent PRs, so every PR remains a normal per-component PR with `${version}` in its title that auto-tags natively.
- **`plugin-shared` reverts to owning only the shared assets**: its `exclude-paths` re-adds `apps/plugin/.claude-plugin` and `apps/plugin/.codex-plugin`; its `extra-files` updaters for the two client `plugin.json`s are removed (each client now owns its own version).
- **`separate-pull-requests: true` and the absence of `linked-versions` are retained.** No grouped PR is ever produced — the failure mode that broke releases twice (a version-less grouped PR title that can't auto-tag) is structurally impossible.
- **opencode switches `release-type: node` → `simple`** (dry-run finding): node-workspace reads a `package.json` for every `node` component to build the graph and aborts if one is missing; opencode has none (version in the `plugin.ts` comment), so `simple` keeps it out of the graph. hermes is already `simple` and unchanged. Both remain independent re-fetchers outside the dependency graph.
- **Migration creates anchor tags** `claude-code-plugin-v<seed>` / `codex-plugin-v<seed>` at HEAD (dry-run finding) so the first cascade is a clean `+patch` rather than a re-scan of pre-migration history.
- **BREAKING (release-plumbing only):** Claude and Codex versions now **diverge** from `plugin-shared` and from each other over time — a cascade is `+patch`, not version-equalization. The lock-step guarantee from the collapse is intentionally removed. No runtime, bridge, hook, or installer-flow behavior changes; the installer's per-client installed-version detection (reading each `plugin.json`) already works per-client.
- This change touches **no load-bearing data invariant** (append-only memory, scope-at-service, `topic_key` convergence, judgment freshness) — it is release/distribution plumbing only. It supersedes `2026-06-14-collapse-plugin-release-components`.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `open-source-distribution`: the "Release-please MUST run in multi-component manifest mode with four independent components" requirement changes to a **six-component** model (server, plugin-shared, claude-code-plugin, codex-plugin, opencode-plugin, hermes-plugin) driven by the `node-workspace` plugin (`merge: false`) for shared→client cascade, replacing the merged-`plugin-shared`-owns-claude+codex model and its `extra-files` lock-step. The release-identity contract changes from "claude/codex track `plugin-shared-v*` via extra-files" to "claude/codex have their own `claude-code-plugin-v*` / `codex-plugin-v*` tags, patch-cascaded from `@rembric/plugin`". The auto-tag-on-merge guarantee is preserved (and re-justified via `merge: false` rather than via "no grouping at all").
- `codex-distribution`: the "Claude Code and Codex version-bump together when shared bin or hooks change" requirement is reworded — a shared-asset change now cascades a **patch bump to the independent `codex-plugin` (and `claude-code-plugin`) components via node-workspace**, each in its own versioned PR, rather than bumping a single merged component via `extra-files`.
- `hermes-agent-plugin`: the per-component versioning requirement that references the merged `plugin-shared`/`extra-files` model for claude+codex is reworded to the six-component + node-workspace model; hermes remains an independent component outside the dependency graph (unchanged behavior).
- `opencode-plugin`: the requirement text referencing the merged claude+codex component is reworded; opencode remains an independent component outside the dependency graph (unchanged behavior).

## Impact

- `release-please-config.json` — re-add `apps/plugin/.claude-plugin` and `apps/plugin/.codex-plugin` as `node` packages (`component: claude-code-plugin` / `codex-plugin`, `include-component-in-tag`, `include-v-in-tag`, `changelog-path`, `bump-minor-pre-major`); narrow `apps/plugin` `exclude-paths` back to all four client dirs and drop its `extra-files`; add `"plugins": [{ "type": "node-workspace", "merge": false }]`.
- `.release-please-manifest.json` — re-add `apps/plugin/.claude-plugin` and `apps/plugin/.codex-plugin` entries (seeded at the current `apps/plugin` version, `0.11.1`, so the first cascade computes from a stable base).
- `apps/plugin/.claude-plugin/package.json`, `apps/plugin/.codex-plugin/package.json` — NEW minimal manifests (`private: true`, `version`, `dependencies: { "@rembric/plugin": "workspace:*" }` or a plain range — exact protocol settled in the dry-run).
- `apps/plugin/.claude-plugin/CHANGELOG.md`, `apps/plugin/.codex-plugin/CHANGELOG.md` — re-created (release-please writes them again).
- `apps/plugin/.claude-plugin/plugin.json`, `.codex-plugin/plugin.json` — `version` field now bumped by each client's own `node` strategy (its `package.json` is the primary carrier; `plugin.json` becomes an `extra-files` updater of the client's own component).
- `apps/plugin/install.sh` — `component_key()` for claude/codex points back at the per-client dirs (revert the collapse's mapping to `apps/plugin`).
- `install.test.ts` — `PLUGIN_VERSION` map for claude/codex follows back to the per-client manifest entries.
- `CLAUDE.md` — "Plugin development discipline" / per-component versioning section rewritten to the six-component + node-workspace model.
- `.agents/skills/rembric-plugin-development/` — update any spot describing the four-component/collapse model.
- `openspec/specs/{open-source-distribution,codex-distribution,hermes-agent-plugin,opencode-plugin}/spec.md` — delta updates.
- `.github/workflows/release-please.yml` — descriptive comment listing plugin component names (no functional change; server-only Docker gating untouched).
- `pnpm-workspace.yaml`, `pnpm-lock.yaml` — verified UNCHANGED (the new client `package.json`s are not workspace members); this is a dry-run validation gate, not an edit.
- GitHub state (one-time): seed the two new components on the next release-please run; verify via `release-please --dry-run` (or an inspected `workflow_dispatch` run) BEFORE merging that (a) node-workspace resolves the dep graph despite the clients not being pnpm members, (b) a shared-asset commit produces separate versioned PRs for claude and codex with a `+patch` bump, and (c) each PR auto-tags on merge with no "untagged, merged release PRs outstanding".
