## Why

Hermes now documents native Git-subdirectory plugin installation and source-tracked updates. Delegating distribution to its plugin manager can remove Rembric's file-copy backend while retaining the canonical root TUI, with explicitly approved native ownership of provider selection and plugin removal rather than maintaining a second distribution mechanism.

## What Changes

- Route Hermes install/update/remove from the canonical TUI to the native plugin manager, subject to binary detection and explicit execution consent.
- Target `hermes plugins install susomejias/rembric/apps/plugin/.hermes-plugin --enable`, `hermes plugins update rembric`, and `hermes plugins remove rembric`; these commands were exercised in an isolated official Hermes runtime; see `verification.md` for controls and limits.
- Remove obsolete file-copy/removal logic only after its replacement and legacy upgrade behavior are verified. Do not add a parallel legacy backend.
- Preserve the MCP bridge, exact bridge pins, explicit MCP environment mappings and existing recognized legacy MCP migration behavior. Direct HTTP tool transport, provider changes, tool rewrites and config refactoring are out of scope.
- **BREAKING**: reject existing manually copied/untracked installs before replacement; explain explicit backup and native reinstall rather than attempting `adopt`, forced overwrite or automatic deletion of unknown local files.
- **BREAKING**: reject Hermes mutation requests using `REMBRIC_SRC`, `PLUGIN_SRC`, an explicit `--ref` or `REMBRIC_REF` before mutation. This small stage supports the default unpinned native source only; it neither resolves tags into SHAs nor changes pinned installs.
- **BREAKING**: accept Hermes-owned `memory.provider`, plugin selection/grant changes and whole plugin-owned directory removal. Preserve unrelated settings, MCP entries/bridge pins, credentials and project markers. No Rembric-side general config rewrite.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `tui-installer`: native Hermes routing, execution consent, source/ref handling, status/update behavior and conservative removal.
- `hermes-agent-plugin`: native distribution, manual-copy migration, uninstall and affected user documentation; provider/runtime and MCP transport contracts remain unchanged.

## Impact

Candidate implementation surfaces: `apps/plugin/install.sh`, `install.test.ts`, `apps/plugin/.hermes-plugin/install.sh`, `apps/plugin/.hermes-plugin/uninstall.sh`, `apps/plugin/.hermes-plugin/tests/test_uninstall.py`, `apps/plugin/.hermes-plugin/README.md`, `apps/plugin/README.md`, `README.md`, `docs/agents.md`, `.agents/skills/rembric-tui-installer/SKILL.md`, and `.agents/skills/rembric-plugin-development/references/per-client-gotchas.md`.

No new repository, package, provider or dependency. No changes to append-only memory, scope-at-service, topic keys or fresh-context judgment. The pre-existing summary implementation and `improve-hermes-chat-session-summaries` change are separate and untouched.

The user approved this native-isolated policy. The parent completed the isolated real-Hermes migration gate before runtime implementation. Official-image acceptance is recorded separately from moving-main documentary sources in `verification.md`.
