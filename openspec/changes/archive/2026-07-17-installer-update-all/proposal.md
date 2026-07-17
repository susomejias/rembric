## Why

`memory.about` has always advertised an `update_all` command — `curl -fsSL <installer> | sh -s -- --action=update` — as the way to update every installed plugin at once. But the installer rejected exactly that invocation: `--action` without `--agent` fell through to a usage error (`--agent requires --action`, ironically backwards for this case — there was no `--agent`, and the installer had no notion of "update everything"). Every deployed server has been advertising a broken command. This closes that gap and adds the matching interactive menu entry.

## What Changes

- **`--action=update` with no `--agent` (or the explicit `--agent=all` alias) now updates every installed plugin that has an update available**, skipping the rest (not installed, already up to date, ahead, or unknown) — never erroring. Implemented as `do_update_all` in `apps/plugin/install.sh`, reusing the existing `installed_version`/`available_version`/`vercmp` detection the `--status` table already computes.
- **Interactive menu**: the Plugins section's "Which agent?" prompt gains a first entry, `all — update outdated`, sitting right below the already-rendered status table so the operator sees what will be touched before confirming.
- **`memory.about`'s plugins note** updated: `update_all` is now safe to run directly without checking `status` first (it only ever touches agents that need it); the `status`-first-then-selective-update advice remains valid for the `subset` command.

No breaking changes. `--agent=<specific-clients> --action=update` is unaffected — this only changes what happens when `--agent` is absent (previously: error) or explicitly `all`.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `tui-installer`: ADD a requirement describing the update-all behavior — flag semantics (bare `--action=update`, and the `--agent=all` alias), per-agent skip states, the interactive menu entry, and the exit-0 no-op case when nothing needs updating.
- `mcp-api`: MODIFY the `memory.about` requirement's `plugins.note` guidance and its "read-only status command" scenario — `update_all` no longer requires a `status` check first; that advice now applies specifically to the `subset` (explicit `--agent=`) path.

## Impact

- `apps/plugin/install.sh` — `do_update_all` (new), non-interactive dispatch, interactive menu, `usage()` text.
- `apps/server/src/mcp/about-tool.ts` — `plugins.note` wording.
- `install.test.ts` — new tests for the update-all selectivity (updates the outdated, skips the rest, never errors, `--agent=all` alias, up-to-date agents skipped).
- Issue: #262.
