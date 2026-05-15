## MODIFIED Requirements

### Requirement: Codex hook configuration

The repository SHALL host Codex hook configuration at `plugin/hooks/hooks.codex.json`, sibling to the Claude Code plugin's `plugin/hooks/hooks.json`, declaring the four Codex-supported events the plugin wires.

#### Scenario: Hook event coverage

- **WHEN** `plugin/hooks/hooks.codex.json` is loaded
- **THEN** the `hooks` object declares entries for `SessionStart`, `UserPromptSubmit`, `PreCompact`, and `Stop`
- **AND** every hook entry SHALL be `type: "command"` — Codex does not support `type: "mcp_tool"` for hooks
- **AND** the `SessionStart` hook SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh` (reused from the Claude Code plugin, which now performs the HTTP session create — Codex inherits that behavior automatically)
- **AND** the `UserPromptSubmit` hook SHALL declare the matcher `remember|recall|acordate|qué hicimos|what did we do` and invoke `${CLAUDE_PLUGIN_ROOT}/scripts/prompt-search.sh` (reused from the Claude Code plugin)

#### Scenario: Codex PreCompact wires to a HTTP-summary script

- **WHEN** the `PreCompact` hook fires
- **THEN** the hook SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/pre-compact.sh` (the SAME script as Claude Code, reused — no separate `pre-compact-codex.sh`)
- **AND** the script SHALL read `session_id` and the compact transcript from stdin, parse `.rembric` for the slug, and POST `/api/<slug>/sessions/<session_id>/summary` against the Rembric HTTP API
- **AND** the script SHALL exit zero even on internal error (`trap 'exit 0' ERR`) so a hook failure never aborts compaction
- **AND** the prior `plugin/scripts/pre-compact-codex.sh` SHALL be deleted (its stdout-nudge approach is obsoleted by the HTTP path that works identically for Claude Code and Codex)

#### Scenario: Codex Stop wires to a HTTP-end script

- **WHEN** the `Stop` hook fires
- **THEN** the hook SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-stop.sh` (the SAME script as Claude Code — no separate `stop-codex.sh`)
- **AND** the script SHALL POST `/api/<slug>/sessions/<session_id>/end`
- **AND** the script SHALL exit zero even on internal error
- **AND** the prior `plugin/scripts/stop-codex.sh` SHALL be deleted

## ADDED Requirements

### Requirement: Codex hooks MUST receive `session_id` from stdin in the same JSON shape as Claude Code

The shared scripts `session-start.sh`, `pre-compact.sh`, and `session-stop.sh` SHALL read the hook stdin as a JSON object containing a `session_id` field (and `cwd` when relevant). Claude Code and Codex CLI both pass the host-session id in stdin JSON for `command`-type hooks.

If Codex passes the id under a different key (e.g. `sessionId`), the scripts SHALL prefer `session_id` and SHALL fall back to `sessionId` so the same script supports both clients without per-client forks. When neither field is present the scripts SHALL skip the HTTP call and exit `0`.

#### Scenario: Script reads stdin in both shapes

- **WHEN** the script receives stdin `{"session_id": "x"}` (Claude shape)
- **THEN** it SHALL extract `x` as the session id

- **WHEN** the script receives stdin `{"sessionId": "x"}` (Codex shape, if it differs)
- **THEN** it SHALL extract `x` as the session id

- **WHEN** the script receives stdin with neither field
- **THEN** it SHALL skip the HTTP call, emit a stderr diagnostic, and exit `0`

#### Scenario: Codex session id format may differ from Claude's

- **WHEN** Codex passes an id like `codex-2026-05-15-abc123`
- **THEN** the server's regex `^[A-Za-z0-9_-]{8,128}$` SHALL accept it
- **AND** the upsert SHALL succeed under the calling token's namespace

#### Scenario: Codex session id outside the allowed format

- **WHEN** Codex passes an id that contains characters outside `[A-Za-z0-9_-]` (theoretical; should not happen in practice)
- **THEN** the server SHALL respond `400 invalid_input`
- **AND** the script SHALL exit `0` (failure is silent at the hook level)
