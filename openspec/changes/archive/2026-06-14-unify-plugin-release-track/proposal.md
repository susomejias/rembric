## Why

The release pipeline runs six release-please components (`server`, `plugin-shared`, `claude-code-plugin`, `codex-plugin`, `opencode-plugin`, `hermes-plugin`) with a `node-workspace` cascade so a shared-asset change patch-bumps the bundled clients. The design is sound but **fragile and high-churn**, and it just failed in production:

- Merging the per-component release PRs in quick succession let the release/CI runs **cancel each other** (no `concurrency` guard), so component tags (`claude-code-plugin-v0.12.2`, `codex-plugin-v0.13.0`) were **never minted**.
- A missing component tag is also a missing cascade **anchor**, so release-please **re-scanned pre-migration history** and produced **phantom release PRs** that recycle ancient commits (#62/#134/#136) and spiral versions upward (codex `0.12.2 → 0.13.0 → 0.14.0`).
- Net effect: a "brutal mess" every release, manifest conflicts on every sibling merge, and contributor confusion.

The deeper problem: **the per-client independence delivers no consumed value.** Nothing installs a plugin by version — the marketplace points at `./apps/plugin` and every client installs from `main` (the TUI installer / `curl | sh` pull `main`; opencode/hermes re-fetch shared assets at install time). The five plugin versions, four tag lineages, four CHANGELOGs, the `node-workspace` graph, and the anchor-tag dance exist to version artifacts **nobody depends on**. That complexity is pure cost.

## What Changes

Collapse the six release components into **two independent tracks**, and **unify all plugin clients under one version**:

- **`server`** — unchanged: `apps/server`, `release-type: node`, tag `server-vX.Y.Z`, Docker image. Releases only when `apps/server/**` changes. (The "Docker publishes only on server release" requirement already exists and is kept.)
- **`plugin`** — a SINGLE component covering the **entire** `apps/plugin/` tree (shared assets + all four client dirs). Tag `plugin-vX.Y.Z`, one CHANGELOG (`apps/plugin/CHANGELOG.md`), one version shared by **every** client. Releases only when `apps/plugin/**` changes; never rebuilds the server image.
- **Drop the `node-workspace` plugin** entirely — with one plugin component there is no inter-component dependency to cascade, so the anchor-tag fragility disappears by construction.
- **Unified plugin version**, baseline **`0.14.0`** (next minor above the current max, `0.13.0`). The single `plugin` component's `extra-files` update every client's version carrier in lock-step: `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.opencode-plugin/plugin.ts` comment, `.hermes-plugin/plugin.yaml`.
- **Add a `concurrency` guard** (`cancel-in-progress: false`) to `release-please.yml` so tag-minting runs queue instead of cancelling each other — the direct cause of today's missing tags.
- **Consolidate CHANGELOGs**: `apps/plugin/CHANGELOG.md` becomes the single user-facing plugin changelog; the four per-client `CHANGELOG.md` files are frozen/folded in.
- **Recover the tangled state**: close the phantom release PRs (#150/#151 and any siblings); the migration commit reseeds the manifest to two entries so release-please stops re-proposing.

This **reverts the per-client independence** chosen in #136 (and asserted across four specs) — a deliberate reversal, justified because that independence has no consumer and is the source of the recurring breakage.

## Capabilities

### Modified Capabilities

- `open-source-distribution`: the multi-component release requirement changes from six components (+`node-workspace` cascade, anchor tags) to **two** (`server`, `plugin`), with one unified plugin version and a `concurrency` guard. The "docker-publish only on server release" requirement is retained (already satisfied).
- `codex-distribution`: scenarios asserting an independent `codex-plugin` component / `codex-plugin-v*` tag / cascade change to "codex versions under the unified `plugin` track (`plugin-vX.Y.Z`)".
- `opencode-plugin`: the `opencode-plugin` independent component / `opencode-plugin-v*` tag becomes the unified `plugin` track; the `plugin.ts` version comment is updated by the `plugin` component.
- `hermes-agent-plugin`: the `hermes-plugin` independent component / `hermes-plugin-v*` tag becomes the unified `plugin` track; `plugin.yaml::version` is updated by the `plugin` component.

### New Capabilities

_None._

## Impact

Affected config / CI:

- `release-please-config.json` — 6 packages → 2; remove `node-workspace` plugin; the `plugin` component covers all of `apps/plugin` (no `exclude-paths`) with `extra-files` for the four client version carriers.
- `.release-please-manifest.json` — 6 entries → 2 (`apps/server`, `apps/plugin: 0.14.0`).
- `.github/workflows/release-please.yml` — add `concurrency` guard; the `publish-docker` gate on `apps/server` paths is retained.
- `apps/plugin/CHANGELOG.md` — single plugin changelog; per-client `CHANGELOG.md` files frozen/folded.
- Client version carriers (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.opencode-plugin/plugin.ts`, `.hermes-plugin/plugin.yaml`) — now all carry the unified `plugin` version.

Affected specs: `open-source-distribution`, `codex-distribution`, `opencode-plugin`, `hermes-agent-plugin`.

Operational recovery (one-time): close phantom release PRs; reseed manifest; the stale per-client tags stay in history, inert (no new ones minted).

Load-bearing: this is distribution/CI infra governed by the `rembric-plugin-development` and `rembric-tui-installer` skills — implementation MUST consult both and run the installer e2e, since install URLs / marketplace pointers must keep working.

## Out of scope / verified-unaffected

- **Docker-on-server-only** already exists (kept, not re-implemented).
- **Install URLs / marketplace** point at `./apps/plugin` on `main` — independent of plugin version, so unaffected (to be confirmed by the installer e2e during apply).
- Server versioning/tags/Docker flow — untouched.
