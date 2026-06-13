## Why

release-please's `linked-versions` plugin hardcodes the grouped release-PR title to `chore${scope}: release <groupName> libraries` — with **no `${version}`** and ignoring any title-pattern config. A merged group PR therefore can't be parsed back to a version, so its releases/tags are never created; the next run sees an "untagged, merged release PR outstanding" and **aborts before opening any new release PR**. This stalled plugin releases twice in one day, each time needing manual tag creation + relabelling. No config fixes it — the title is hardcoded in the plugin ([release-please#1946](https://github.com/googleapis/release-please/issues/1946), open, "no definitive permanent fix"). The only durable fix is to stop using `linked-versions` and give every release component a PR whose title carries a version (auto-taggable natively).

## What Changes

- **Remove the `linked-versions` plugin entirely** from `release-please-config.json`. No grouped release PR is ever produced again.
- **Merge three components into one** keyed at `apps/plugin`: `plugin-shared` + `claude-code-plugin` + `codex-plugin` become a single `plugin-shared` component (name kept to preserve the existing `plugin-shared-v0.11.1` tag → **zero tag migration**). Its path becomes `apps/plugin` excluding `.opencode-plugin` and `.hermes-plugin`; the two client manifests join as `extra-files` (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`).
- **opencode and hermes components stay exactly as configured** (independent). Rationale, already documented in the specs: claude+codex are marketplace-**cached** and bundle `bin/rembric-bridge.mjs`, so they must bump together when shared assets change; opencode and hermes are **re-fetchers** (their `install.sh` re-pulls shared from `main` at install) so they need no coordinated bump.
- **Delete the two orphaned stub CHANGELOGs** (`.claude-plugin/CHANGELOG.md`, `.codex-plugin/CHANGELOG.md`) — they only ever said "Synchronize plugin-suite versions"; the real plugin history lives in `apps/plugin/CHANGELOG.md`.
- **Installer + test touch-ups**: `component_key()` maps claude+codex → `apps/plugin`; the `install.test.ts` `PLUGIN_VERSION` map follows. Installed-version detection (reading `plugin.json`/`plugin.ts`/`plugin.yaml`) is **unchanged**.
- **Live migration (one-time)**: close the orphaned group release PR #133 and delete its branch `release-please--branches--main--groups--plugin-suite`; the new `plugin-shared` component then opens a normal release PR (0.11.1 → 0.12.0) whose title carries the version and auto-tags on merge.

This realigns a pre-existing drift: the specs already describe a `bridge-bundlers` group / "five components" model that does **not** match the live `plugin-suite` / six-component config. This change makes config, specs, and `CLAUDE.md` describe one true model.

No load-bearing data invariant (append-only, scope-at-service, topic_key, judgment freshness) is touched — this is release/distribution plumbing only. No npm publish is introduced (the `@rembric/plugin` package stays `private`).

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `open-source-distribution`: the multi-component release model requirement changes from "five independent components" (and the version-drift requirement) to the four-component, no-linked-versions model (server, plugin-shared[=shared+claude+codex], opencode-plugin, hermes-plugin).
- `codex-distribution`: reword the requirement asserting a shared change bumps claude+codex via the `bridge-bundlers` linked group → they are now a single `plugin-shared` component that bumps as a unit.
- `hermes-agent-plugin`: reword the per-component versioning requirement that references the `bridge-bundlers` group and "each `.X-plugin/` is its own component" to the new model; hermes remains independent.
- `opencode-plugin`: reword the references to `bridge-bundlers` cascading claude+codex; opencode remains an independent component (unchanged behavior).

## Impact

- `release-please-config.json` — remove `apps/plugin/.claude-plugin` + `apps/plugin/.codex-plugin` packages and the `plugins: [linked-versions]` block; broaden `apps/plugin` (`exclude-paths` → only `.opencode-plugin`, `.hermes-plugin`) and add the two `extra-files`.
- `.release-please-manifest.json` — remove the `apps/plugin/.claude-plugin` and `apps/plugin/.codex-plugin` keys.
- `apps/plugin/.claude-plugin/CHANGELOG.md`, `apps/plugin/.codex-plugin/CHANGELOG.md` — deleted (stubs).
- `apps/plugin/install.sh` — `component_key()` (claude, codex → `apps/plugin`).
- `install.test.ts` — `PLUGIN_VERSION` map (claude, codex → `MANIFEST['apps/plugin']`); existing version-detection + `--yes` tests must still pass.
- `CLAUDE.md` — "Plugin development discipline" / per-component versioning section rewritten.
- `.agents/skills/rembric-plugin-development/` — update any spot that repeats the per-component/linked-versions model.
- `openspec/specs/{open-source-distribution,codex-distribution,hermes-agent-plugin,opencode-plugin}/spec.md` — delta updates.
- `.github/workflows/release-please.yml` — only the descriptive comment listing plugin component names (no functional change; server gating untouched).
- GitHub state (one-time, public): close PR #133, delete its group branch. Existing per-client tags (`claude-code-plugin-v*`, `codex-plugin-v*`) stay as frozen history.
