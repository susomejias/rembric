## Context

The six-component release-please setup (spec'd in `open-source-distribution` "multi-component manifest mode") was the product of real iteration (#134 collapse, #136 node-workspace migration, #140 sync). Its goal: let claude/codex re-version when shared assets change (they bundle the marketplace-cached `rembric-bridge.mjs`) while keeping each client's version/tag/CHANGELOG independent.

It works **only when every merged release PR mints its component tag**, because those tags are the cascade **anchors** (`open-source-distribution` line ~173: a missing anchor makes release-please re-scan pre-migration history and inflate bumps). In production that invariant broke: rapid sequential merges of the per-component release PRs, with **no `concurrency` guard** on `release-please.yml`, let CI/release runs cancel each other → `claude-code-plugin-v0.12.2` / `codex-plugin-v0.13.0` were never minted → release-please lost the anchors → phantom PRs recycling #62/#134/#136 and a codex version spiral (`0.12.2→0.13.0→0.14.0`).

## Goals / Non-Goals

**Goals:**

- Eliminate the cascade/anchor/race/phantom-PR class of failure by construction.
- One unified plugin version for all clients (claude/codex/opencode/hermes) — what actually makes sense given how they ship.
- Keep a user-facing plugin changelog.
- Never rebuild the server image on plugin-only changes (already true — keep it).

**Non-Goals:**

- Changing how plugins are installed (still from `main`, marketplace → `./apps/plugin`).
- Changing server versioning / Docker flow.
- npm publishing (sunset; out of scope permanently).
- Re-titling/retagging the legacy per-client tags already in history (left inert).

## Decisions

### D1: Two tracks — `server` and `plugin` — no `node-workspace`

The cascade existed to keep five plugin components in sync. With **one** `plugin` component covering all of `apps/plugin/`, there is nothing to cascade: any plugin change bumps the one plugin version, and the bundled bridge is versioned as part of the tree. Dropping `node-workspace` removes the dependency graph, the anchor-tag requirement, and the whole phantom-bump failure mode.

```
6 components + node-workspace cascade        →    2 independent components
  server                                            server   (apps/server)   → Docker
  plugin-shared ─┐                                  plugin   (apps/plugin/**) → tag + CHANGELOG
  claude ◀───────┤ cascade (fragile anchors)
  codex  ◀───────┘
  opencode (simple)                            no cascade · no anchors · no graph
  hermes   (simple)                            tags: server-v* , plugin-v*
```

### D2: Unified plugin version, baseline `0.14.0`

All four client version carriers move in lock-step under the single `plugin` component:

| Carrier                                                           | Updated by                                 |
| ----------------------------------------------------------------- | ------------------------------------------ |
| `.claude-plugin/plugin.json::version`                             | `plugin` component `extra-files`           |
| `.codex-plugin/plugin.json::version`                              | `plugin` component `extra-files`           |
| `.opencode-plugin/plugin.ts` `// @rembric-plugin-version` comment | `plugin` component `extra-files` (generic) |
| `.hermes-plugin/plugin.yaml::version`                             | `plugin` component `extra-files`           |

Baseline **`0.14.0`** = next minor above the current divergent max (`0.13.0`), a clean "from here, plugins version as one." (`1.0.0` was considered to mark the consolidation but rejected — the plugin tree is pre-1.0 and a major would overstate it.)

**This reverts the per-client independence of #136** and the "versions independently" assertions in `codex-distribution`, `opencode-plugin`, `hermes-agent-plugin`. Justified: that independence versions artifacts nobody installs by version (everything ships from `main`), so it is cost without benefit, and it is the mechanism behind the recurring breakage.

### D3: `concurrency` guard — the direct fix for the missing tags

`release-please.yml` gains:

```yaml
concurrency:
  group: release-please-${{ github.ref }}
  cancel-in-progress: false
```

`cancel-in-progress: false` queues overlapping runs instead of cancelling, so a rapid second merge can never abort the first run's tag-minting. This is the proximate fix for today's incident and is valuable independent of the component collapse.

### D4: One plugin CHANGELOG

`apps/plugin/CHANGELOG.md` is the single user-facing plugin changelog (all clients). The four per-client `CHANGELOG.md` files are frozen (folded into the unified one, or left as historical stubs). This is the "documentation for users" requirement — one coherent log beats four fragmented ones.

### D5: Docker-on-server-only is retained, not re-built

`open-source-distribution` already requires `publish-docker` to gate on `apps/server` in `paths_released`. Verified present. Kept as-is; the only workflow change is the `concurrency` guard.

## Alternatives considered

- **Minimal fix: keep six components, add only the `concurrency` guard.** Fixes today's missing-tags incident, preserves per-client independence. Rejected: it leaves the anchor-tag fragility and the five-version churn whose value is zero (no consumer). The user explicitly wants the simpler model and unified versions.
- **Single repo-wide version (server + plugins together).** One tag/CHANGELOG for everything. Rejected: a plugin-only change would rebump and **rebuild the server image** — violates a hard requirement.
- **Server-only (drop plugin versioning entirely).** Simplest, but loses the user-facing plugin changelog — rejected by the changelog requirement.
- **Migrate to Changesets.** Viable without npm publish, gives one aggregated Version PR + `fixed` groups. Rejected for now: it keeps the work of versioning things nobody installs and adds a custom `component-vX.Y.Z` tagger + handling for the non-`package.json` clients. The 2-track release-please collapse achieves the goal with far less migration.

## Risks / Trade-offs

- **Recovery sequencing.** Phantom PRs regenerate until the new config lands. Order: land the config change → phantom PRs become impossible → close any stragglers. Closing before the config change is only a temporary quiet.
- **Stale per-client tags in history.** `claude-code-plugin-v*` etc. remain but are never extended. Harmless; documented.
- **Marketplace/installer coupling.** Must confirm nothing consumes per-client versions (installer `status`, marketplace display). Marketplace points at `./apps/plugin`; expected safe — gated by the installer e2e in tasks.
- **Cross-spec consistency.** Four specs assert per-client independence; all must flip together or the spec set self-contradicts. Enumerated in tasks.

## Migration / rollout

1. Land config + manifest + workflow changes (2 components, `0.14.0` plugin seed, `concurrency` guard).
2. release-please then proposes at most two release PRs (`server`, `plugin`) — no cascade, no phantom.
3. Close the outstanding phantom PRs; verify no new ones regenerate.
4. Run the installer e2e to confirm install URLs / marketplace still resolve.

No data/schema migration — this is CI/distribution config only.
