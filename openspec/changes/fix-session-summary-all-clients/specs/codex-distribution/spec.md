## MODIFIED Requirements

### Requirement: Codex hook configuration

The repository SHALL host Codex hook configuration at `plugin/hooks/hooks.codex.json`, sibling to the Claude Code plugin's `plugin/hooks/hooks.json`, declaring the three Codex-supported events the plugin wires.

Codex's hook surface differs from Claude Code's in ways the platform forces:

- Codex has no `SessionEnd` event (verified against `developers.openai.com/codex/hooks`).
- Codex has no `PreCompact` or `PostCompact` event.
- Codex's `SessionStart` matcher does not include `"compact"` — only `startup|resume|clear`.
- Codex's `Stop` hook REQUIRES JSON on stdout: "Stop expects JSON on stdout when it exits 0. Plain text output is invalid for this event." Per official docs.

Therefore Codex's mapping of lifecycle events to HTTP endpoints diverges from Claude Code's by necessity, NOT by choice. Codex sessions stay `active` until the `abandonStale` job flips them to `abandoned`; this is the steady state for Codex sessions.

#### Scenario: Hook event coverage

- **WHEN** `plugin/hooks/hooks.codex.json` is loaded
- **THEN** the `hooks` object SHALL declare entries for `SessionStart`, `UserPromptSubmit`, and `Stop`
- **AND** the `hooks` object SHALL NOT contain `PreCompact`, `PostCompact`, or `SessionEnd` (Codex does not support these events)
- **AND** every hook entry SHALL be `type: "command"` — Codex does not support `type: "mcp_tool"` for hooks
- **AND** the `SessionStart` hook SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh codex-cli` (reused from the Claude Code plugin; the `agent` arg differs)
- **AND** the `UserPromptSubmit` hook SHALL declare the matcher `remember|recall|acordate|qué hicimos|what did we do` and invoke `${CLAUDE_PLUGIN_ROOT}/scripts/prompt-search.sh` (reused)

#### Scenario: Codex Stop wires to a per-turn summary writer

- **WHEN** the `Stop` hook fires (which it does once per agent turn under Codex semantics)
- **THEN** the hook SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-stop.sh codex-cli` (Codex-only — Claude Code does NOT wire `Stop` in this version)
- **AND** the script SHALL read `session_id`, `cwd`, and `transcript_path` from stdin
- **AND** SHALL read `${cwd}/.rembric` for the slug
- **AND** SHALL read `transcript_path` if readable, format it via `_transcript.sh`, derive a title from the first non-empty assistant message (≤100 chars)
- **AND** SHALL POST `${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/summary` with body `{"summary": "<formatted>", "title": "<derived>", "final": false}` — note: `/summary` NOT `/end`, because Codex Stop is per-turn and the session must stay `active` for the next turn to keep updating
- **AND** SHALL emit `'{}'` to stdout (Codex requires JSON on Stop stdout; plain text is invalid per docs)
- **AND** SHALL exit zero even on internal error

#### Scenario: Codex sessions remain active until abandoned by sweep

- **GIVEN** a Codex session where Stop has fired N times
- **WHEN** the user closes Codex CLI
- **THEN** the session row SHALL remain `status='active'` (no SessionEnd signal to transition it)
- **AND** the `abandonStale` job (running per `SESSION_ABANDON_AFTER_MS`, default 24h) SHALL eventually flip the row to `status='abandoned'`
- **AND** the row's `summary` and `title` SHALL reflect the most recent Stop's POST (the latest transcript)

#### Scenario: Codex Stop output without JSON would fail the hook

- **GIVEN** a script that POSTs `/summary` correctly but emits plain text to stdout
- **WHEN** Codex receives that stdout
- **THEN** Codex SHALL flag the hook output as invalid (per the "Stop expects JSON" contract) and the hook SHALL be considered failed for that turn

#### Scenario: pre-compact-codex.sh deletion

- **WHEN** the repository is at HEAD after this change
- **THEN** the file `plugin/scripts/pre-compact-codex.sh` SHALL NOT exist
- **AND** the file `plugin/scripts/pre-compact.sh` SHALL NOT exist (deleted from Claude Code spec as well)
- **AND** no Codex hook entry SHALL reference either file
