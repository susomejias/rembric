# Harden installer, hook transport, and bridge against silent failures

## Why

Several plugin-side paths fail silently or hang indefinitely: the bash `rembric_post` helper (Claude Code + Codex hooks) swallows every HTTP error with no diagnostic (a bad token gives ZERO signal, while opencode and Hermes both emit one); the installer's `bring_up` prints "Up." + dashboard URL based only on `docker compose up -d` exiting 0, without checking the app is actually healthy; the installer's artifact `fetch()` and the root shim's curl have no `--max-time`/`--retry` (a slow raw.githubusercontent hangs the install forever, while the release check right next to it already uses `--max-time 4`); the bridge spawns `npx -y mcp-remote@latest`, re-resolving "latest" on every session start (network dependency at startup, non-reproducible, a broken upstream release instantly breaks all users); and the opencode installer both mis-detects existing config (`grep '"rembric"'` over the whole JSON) and never verifies its dev→installed import rewrite `sed`, which on drift silently installs a plugin that crashes at load.

## What Changes

- **MODIFIED** `apps/plugin/scripts/_api.sh`: failed lifecycle POSTs emit a one-line stderr diagnostic (curl rc + path), still `return 0` (never break the host).
- **MODIFIED** `apps/plugin/install.sh::bring_up`: after `docker compose up -d`, poll `http://127.0.0.1:<port>/healthz` with the known token (bounded retries) and report real health; on timeout report failure guidance instead of "Up.".
- **MODIFIED** `apps/plugin/install.sh::fetch()` and root `install.sh` curl: add `--max-time`/`--retry --retry-connrefused` bounds.
- **MODIFIED** `apps/plugin/install.sh`: validate `--port=<n>` is numeric (1-65535) at parse time.
- **MODIFIED** `apps/plugin/bin/rembric-bridge.mjs`: pin `mcp-remote@<exact-version>` (bumped deliberately with plugin releases), replacing `@latest`.
- **MODIFIED** `apps/plugin/.opencode-plugin/install.sh`: precise already-configured detection (match the `mcp.rembric` key context, not any `"rembric"` substring) and a post-`sed` assertion that the rewritten import actually points at `DOTENV_DEST` (fail the install loudly instead of installing a broken plugin).
- **MODIFIED** `apps/plugin/scripts/session-stop.sh`: reconcile the stale header comment claiming Codex has no PreCompact/PostCompact (the manifest wires both) — comment-only.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `tui-installer`: bring-up health verification, bounded network fetches, port validation.
- `plugin-session-protocol`: failed lifecycle POSTs emit a stderr diagnostic in every client (normative alignment with opencode/Hermes behavior).
- `claude-code-plugin`: the bridge pins the `mcp-remote` version (ADDED requirement; the prose bullet in "MCP bridge contract" naming `@latest` is updated at archive-time sync).
- `opencode-plugin`: installer detection precision + import-rewrite verification.

## Impact

- `apps/plugin/scripts/_api.sh`, `apps/plugin/scripts/session-stop.sh`, `apps/plugin/install.sh`, root `install.sh`, `apps/plugin/bin/rembric-bridge.mjs`, `apps/plugin/.opencode-plugin/install.sh`.
- Tests: `install.test.ts` (root, headless suite) extended for the new installer behaviors; bridge test for the pinned spawn args if a harness exists.
- Plugin release track only; no server change. Installer contract (orchestrator model, flags/env surface, three run modes, `set -e` safety, POSIX sh) preserved — see `.agents/skills/rembric-tui-installer/SKILL.md`.
