# Changelog

All notable changes to the Rembric Claude Code plugin.

The plugin is versioned independently from the Rembric server (`@susomejias/rembric` on npm). Plugin releases use git tags of the form `plugin-vX.Y.Z` and are produced via `claude plugin tag --push` run from inside the `plugin/` directory.

## [0.2.3] — unreleased

### Fixed

- **Codex SessionStart and UserPromptSubmit hooks no longer fail.** Previously both fired with `error: hook returned invalid session start JSON output` (and the matching UserPromptSubmit variant). Root cause: the `[rembric]` badge prefix in hook stdout triggered Codex's `looks_like_json` heuristic (`codex-rs/hooks/src/engine/output_parser.rs`) — anything starting with `{` or `[` is treated as a JSON attempt, and our plain-text nudges aren't valid JSON. Codex's per-event handler (`codex-rs/hooks/src/events/session_start.rs` and siblings) then raised the misleading "invalid JSON output" error. Switching the badge from `[rembric]` to `rembric:` keeps the visual marker while staying in Codex's plain-text branch — stdout is now injected as `additional_context` into the agent's turn.

### Changed

- **Hook stdout prefix is `rembric:` (was `[rembric]`).** Visible in `claude --debug` and `~/.codex/log/codex-tui.log`. Same content, ASCII-only, no leading `[` so Codex doesn't try to parse it.

### Notes

- Codex users on `0.2.2` who saw `invalid ... JSON output` errors: `codex plugin marketplace upgrade rembric` followed by a Codex restart will pull `0.2.3` and the hooks succeed. Claude Code users: `claude plugin update rembric@rembric`; the nudge text changes prefix but behaviour is unchanged.

## [0.2.2] — unreleased

### Fixed

- **Bridge path-scoping under Codex.** Bridge `projectDir` resolution chain now includes `PWD` between `CLAUDE_PROJECT_DIR` and `process.cwd()` — under Codex, `CLAUDE_PROJECT_DIR` is never set and `process.cwd()` is the plugin cache dir (consequence of the manifest's `cwd: "."`), so the bridge fell back to path-less `/mcp` and ignored `.rembric`. With `PWD` forwarded from the user's shell, path-scoping works again when `codex` is launched from a directory containing a valid `.rembric`.
- **Empty-string env vars no longer trip the resolution chain.** The bridge now uses `||` instead of `??` to skip empty `CLAUDE_PROJECT_DIR=""` (latent bug — previously produced a buggy relative `.rembric` lookup against process cwd).

### Changed

- **Bridge startup diagnostic.** `[rembric-bridge] cwd=<dir> url=<url>` becomes `[rembric-bridge] projectDir=<dir> (from <CLAUDE_PROJECT_DIR|PWD|process.cwd()>) url=<url>` — names the source step that won the precedence chain, useful for debugging path-scoping issues.
- **`plugin/.codex-plugin/mcp.json:env_vars`** gains `"PWD"` so Codex (which `env_clear`s the subprocess) forwards the user's shell `PWD` to the bridge. Claude Code's `plugin/.claude-plugin/mcp.json` is unchanged.

### Notes

- Codex users on `0.2.1` who saw `No .rembric in /Users/.../.codex/plugins/cache/...`: `codex plugin marketplace upgrade rembric` followed by a Codex restart from the project root (where `.rembric` lives) will pick up `0.2.2` and resolve path-scoping correctly.

## [0.2.1] — unreleased

### Fixed

- **Codex bridge: path resolution.** Under Codex the bridge previously failed at module resolution with `Cannot find module '…${CLAUDE_PLUGIN_ROOT}/bin/rembric-bridge.mjs'`. Codex does not substitute `${CLAUDE_PLUGIN_ROOT}` in MCP server `args` — `codex-rs/core-plugins/src/loader.rs::normalize_plugin_mcp_server_value` only resolves the `cwd` field against `plugin_root`; `command` and `args` pass verbatim. The new Codex-specific MCP config uses `cwd: "."` (normalised to the plugin root) + `args: ["./bin/rembric-bridge.mjs"]` so node resolves the bridge path against the spawned cwd.
- **Codex bridge: credential injection.** The shared MCP config used `env: { REMBRIC_*: "${user_config.*}" }` — Claude-Code-specific interpolation. Codex passes `env` map values verbatim AND calls `Command::env_clear()` on the subprocess (`codex-rs/rmcp-client/src/stdio_server_launcher.rs::launch_server`), so shell env is NOT inherited. The new Codex-specific MCP config uses `env_vars: ["REMBRIC_SERVER_URL", "REMBRIC_API_TOKEN"]` — Codex's documented mechanism for forwarding shell env vars to MCP subprocesses (`create_env_for_mcp_server` in `codex-rs/rmcp-client/src/utils.rs`). The Claude Code plugin path is unchanged.

### Changed

- **MCP config files relocated.** `plugin/mcp.json` moves to `plugin/.claude-plugin/mcp.json`. The new `plugin/.codex-plugin/mcp.json` ships alongside it. Each client's MCP config now lives next to its plugin manifest. Manifests reference them via `mcpServers: "./.claude-plugin/mcp.json"` and `mcpServers: "./.codex-plugin/mcp.json"` respectively (Codex requires `./`-prefixed paths relative to `plugin_root` per `resolve_manifest_path` in `codex-rs/core-plugins/src/manifest.rs`; Claude Code accepts the same form).

### Notes

- Existing Codex users who saw `Cannot find module` errors: `codex plugin marketplace upgrade rembric` followed by re-launching `codex` will pull `0.2.1` and resolve the issue (provided `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` are exported in the launching shell).

## [0.2.0] — unreleased

### Changed

- **Sessions now auto-managed via HTTP hooks.** `SessionStart`, `PreCompact`, and `Stop` now POST directly to Rembric's `/api/<slug>/sessions(*)` endpoints. The agent no longer needs to call `memory.session_start`/`memory.session_summary`/`memory.session_end` over MCP — those tools remain available for clients without hook support, but the canonical path is HTTP. `/dashboard/sessions` is now populated automatically.
- **PreCompact hook reworked.** Was `type: mcp_tool` calling `memory.session_summary({auto:true})` (the `auto:true` argument was speced but never implemented, so the hook silently failed). Now a `command` script that POSTs the compact transcript as the literal summary.
- **PostCompact hook removed.** Its prior job (nudge to call `memory.context`) is folded into `SessionStart`, which Claude Code already fires on the `compact` matcher.
- **Stop hook added.** Async POST to `/api/<slug>/sessions/<id>/end` so sessions close cleanly when the agent stops.
- New shared helper `plugin/scripts/_api.sh`; new shared scripts `session-start.sh` (engordado from the prior nudge-only version), `pre-compact.sh`, `session-stop.sh`. Codex and Claude Code use the same scripts via `${CLAUDE_PLUGIN_ROOT}`.

## [0.1.0] — unreleased

### Added

- Initial plugin manifest with userConfig for `server_url` and `api_token` (sensitive).
- MCP server declaration pointing at `${user_config.server_url}/mcp` with bearer auth.
- Single skill `rembric-memory` documenting the proactive-save protocol, recall triggers, and the project-resolution algorithm for the first turn of a session.
- Four slash commands under `/rembric:*`: `remember`, `recall`, `context`, `summary`.
- Four lifecycle hooks:
  - `SessionStart`, `UserPromptSubmit` (matcher), `PostCompact` as prompt-nudges via `command` scripts.
  - `PreCompact` as `mcp_tool` invocation of `memory.session_summary` (side effect).
- Slug resolution algorithm: manifest files first (package.json, Cargo.toml, pyproject.toml, go.mod, composer.json, deno.json), git as an optional signal when present, basename as fallback.
- Always-on token budget ≤75 tokens; on-invoke cost ≤500 tokens for the skill body and ~20 tokens per hook fire.
