# Changelog

All notable changes to the Rembric Claude Code plugin.

The plugin is versioned independently from the Rembric server (`@susomejias/rembric` on npm). Plugin releases use git tags of the form `plugin-vX.Y.Z` and are produced via `claude plugin tag --push` run from inside the `plugin/` directory.

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
