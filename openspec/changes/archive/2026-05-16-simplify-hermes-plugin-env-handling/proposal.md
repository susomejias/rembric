## Why

The current Hermes plugin (`plugin/.hermes-plugin/`) handles credential storage in three places: `get_config_schema()` returning a UI-prompted form (stored as `~/.hermes/rembric.json`), a custom `_preload_rembric_dotenv()` reading `~/.rembric/.env` at module import, and the implicit assumption that shell `export REMBRIC_*` propagates to the in-process provider. Verified in a live Hermes LXC install (2026-05-16): Hermes spawns its `mcp_servers.*` subprocesses (the bridge) with env taken from `~/.hermes/.env` directly — NOT from the parent process's `os.environ`. As a result the user must duplicate values into two files (`~/.hermes/.env` for the bridge, `~/.rembric/.env` for the provider) and that's the only setup that fully works. This is friction users hit on first install and the original spec under-specified it.

Hermes's documented mechanism for env vars that need to propagate to subprocesses spawned by Hermes is the `requires_env:` field in the plugin manifest. When a plugin declares it, `hermes plugins install` prompts the user at install time, writes the answers to `~/.hermes/.env` via `save_env_value`, and exposes them to the in-process plugin code (`os.environ`) AND every subprocess Hermes spawns from `mcp_servers.*` for that session. One file, no preload helper, no duplication.

The earlier choice to use `get_config_schema()` instead of `requires_env:` was based on a wrong assumption about which mechanism was "more modern". `get_config_schema()` is for in-process plugin config that does NOT need to reach subprocesses (flags, modes, etc.); `requires_env:` is for runtime env. The three Rembric values (`REMBRIC_SERVER_URL`, `REMBRIC_API_TOKEN`, `REMBRIC_PROJECT_SLUG`) belong in the second category.

## What Changes

- **MANIFEST** Declare `requires_env:` in `plugin/.hermes-plugin/plugin.yaml` with the three vars, marked `secret: true` for the token.
- **CODE** Remove `RembricMemoryProvider.get_config_schema()` and `RembricMemoryProvider.save_config()` — Hermes handles credential storage natively via `~/.hermes/.env`.
- **CODE** Remove `_preload_rembric_dotenv()` and the `~/.rembric/.env` / `${XDG_CONFIG_HOME}/rembric/.env` candidate paths from the plugin. Hermes pre-loads `~/.hermes/.env` into the provider's process env before module import.
- **CODE** Simplify the slug resolution cascade from five steps to four. Step 2 (read `<hermes_home>/rembric.json`) becomes obsolete because `save_config` no longer writes that file. The new cascade is: env var → `<cwd>/.rembric` → URL parse → degraded.
- **DOCS** Rewrite `plugin/.hermes-plugin/README.md::Configure` to reflect the new install-prompt UX and a single source of truth (`~/.hermes/.env`). Remove the `~/.rembric/.env` recommendation block.
- **DOCS** Mirror the change in `docs/agents.md::Hermes Agent` section.
- **DOCS** Update `plugin/CHANGELOG.md` with a `[0.4.0]` entry covering the manifest schema change.
- **VERSION** Bump all three client manifests to `0.4.0` (minor — additional manifest field + removed Python public methods).
- **TESTS** Drop `test_dotenv_preload.py` and the config-schema cases in `test_handle_tool_call_defensive.py`. Update `test_slug_resolution.py` to reflect the four-step cascade (no `rembric.json` source).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `hermes-agent-plugin`: revise requirements covering the manifest, provider methods, slug cascade, and documentation. Removes the `rembric.json` and `~/.rembric/.env` preload requirements.

## Impact

- **Modified files**:
  - `plugin/.hermes-plugin/plugin.yaml` (add `requires_env`)
  - `plugin/.hermes-plugin/__init__.py` (remove ~60 LOC)
  - `plugin/.hermes-plugin/README.md` (rewrite install/configure section)
  - `plugin/.hermes-plugin-tests/test_*.py` (drop two test files, adjust slug test)
  - `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json` (version bump)
  - `plugin/CHANGELOG.md` (`[0.4.0]` entry)
  - `docs/agents.md` (Hermes section rewrite)
  - `openspec/specs/hermes-agent-plugin/spec.md` (on archive)
- **No changes**: bridge, scripts, hooks, MCP configs for Claude/Codex, server code, DB schema.
- **Breaking for users on 0.3.x**: anyone with `~/.rembric/.env` must move the same vars to `~/.hermes/.env` (or re-run `hermes plugins install` to be prompted). The `~/.rembric/.env` preload is gone; the file is silently ignored. A migration note in the CHANGELOG covers this.
