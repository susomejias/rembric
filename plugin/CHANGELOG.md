# Changelog

All notable changes to the Rembric Claude Code plugin.

The plugin is versioned independently from the Rembric server (`@susomejias/rembric` on npm). Plugin releases use git tags of the form `plugin-vX.Y.Z` and are produced via `claude plugin tag --push` run from inside the `plugin/` directory.

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
