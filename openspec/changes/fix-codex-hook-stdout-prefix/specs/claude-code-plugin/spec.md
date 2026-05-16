## MODIFIED Requirements

### Requirement: The plugin SHALL ship exactly four hooks at `plugin/hooks/hooks.json`

The plugin's hook catalog SHALL declare four entries: `SessionStart`, `UserPromptSubmit`, `PreCompact`, and `Stop`. The `PostCompact` event SHALL NO LONGER be wired in this version — its prior responsibility (nudge to call `memory.context`) is folded into the `SessionStart` hook output, which already fires on resume.

#### SessionStart

- Type: `command`.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh`.
- The script SHALL read `session_id` and `cwd` from hook stdin (Claude Code passes these as JSON).
- The script SHALL read `${cwd}/.rembric` for `PROJECT_SLUG` using the same dotenv parser as the bridge (see `plugin/bin/rembric-bridge.mjs`).
- When a valid slug is resolved, the script SHALL issue `POST ${REMBRIC_SERVER_URL}/api/<slug>/sessions` with `Authorization: Bearer ${REMBRIC_API_TOKEN}` and body `{ "id": "<session_id>", "cwd": "<cwd>" }`. The script SHALL discard the response body and SHALL NOT block on slow networks (`--max-time 3`).
- When no valid slug is resolvable, the script SHALL skip the POST and write a one-line stderr diagnostic; no session row is created (the agent can still operate path-less).
- After the POST attempt (success or skip), the script SHALL emit the generic nudge `rembric: If this is a continuation of recent work, call memory.context before responding.` to stdout. The nudge string SHALL NOT begin with `{` or `[` — Codex's hook output parser (`codex-rs/hooks/src/engine/output_parser.rs::looks_like_json`) treats stdout starting with those characters as a malformed JSON attempt and fails the hook with `invalid session start JSON output`. The `rembric:` prefix is the canonical badge.
- Output cap: ≤30 tokens.
- The script SHALL exit `0` on any internal error (`trap 'exit 0' ERR`) so plugin failure NEVER aborts a Claude Code session.

#### UserPromptSubmit

- Type: `command`.
- Matcher: `remember|recall|acordate|qué hicimos|what did we do` (case-insensitive).
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/prompt-search.sh`.
- The script SHALL emit a single short nudge line instructing the agent to call `memory.search` with the user's keywords before responding. The current canonical line is `rembric: User intent: recall. Call memory.search with the user keywords before responding.` The line SHALL NOT begin with `{` or `[` (same rationale as SessionStart).
- Output cap: ≤30 tokens.

#### PreCompact

- Type: `command` (CHANGED from `mcp_tool`).
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/pre-compact.sh`.
- The script SHALL read `session_id` and the compaction transcript/summary from hook stdin.
- The script SHALL read `${cwd}/.rembric` for `PROJECT_SLUG`.
- When `session_id` and slug both resolve, the script SHALL issue `POST ${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/summary` with body `{ "summary": "<compact transcript>" }`. The body SHALL be the verbatim compact summary the hook receives; no transformation, no LLM call.
- The script SHALL discard the response and SHALL NOT emit any stdout (PreCompact output is not seen by the model).
- The script SHALL exit `0` on any error.

#### Stop

- Type: `command` with `async: true`.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-stop.sh`.
- The script SHALL read `session_id` from hook stdin and `${cwd}/.rembric` for `PROJECT_SLUG`.
- When both resolve, the script SHALL issue `POST ${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/end` with an empty body.
- The script SHALL discard the response, SHALL emit no stdout, and SHALL exit `0` on any error.

#### Scenario: SessionStart hook creates a session in Rembric

- **GIVEN** the plugin is installed, `${cwd}/.rembric` contains `PROJECT_SLUG=foo`, project `foo` exists, and `REMBRIC_SERVER_URL` is reachable
- **WHEN** Claude Code fires the `SessionStart` hook with stdin `{"session_id": "claude-sess-abc12345", "cwd": "/home/u/foo"}`
- **THEN** the script SHALL POST to `${REMBRIC_SERVER_URL}/api/foo/sessions` with body `{"id": "claude-sess-abc12345", "cwd": "/home/u/foo"}`
- **AND** the server SHALL insert a row for `(token_id, 'claude-sess-abc12345')`
- **AND** the script SHALL still emit the `rembric: If this is a continuation...` nudge on stdout
- **AND** `/dashboard/sessions` SHALL list the new active session

#### Scenario: SessionStart hook with missing .rembric

- **WHEN** the `SessionStart` hook fires and `${cwd}/.rembric` does not exist
- **THEN** the script SHALL skip the POST, emit a stderr diagnostic, and still emit the standard nudge on stdout
- **AND** the script SHALL exit `0`

#### Scenario: SessionStart hook with server unreachable

- **WHEN** the `SessionStart` hook fires and the POST times out or fails
- **THEN** the script SHALL exit `0` with the nudge on stdout — Claude Code MUST NOT be broken by Rembric unavailability

#### Scenario: PreCompact persists the compact summary

- **GIVEN** the SessionStart hook earlier registered session `claude-sess-abc12345`
- **WHEN** Claude Code fires the `PreCompact` hook with stdin containing the session_id and a compact summary
- **THEN** the script SHALL POST to `/api/foo/sessions/claude-sess-abc12345/summary` with the summary text
- **AND** the server SHALL transition the row to `status='ended'` with that summary persisted

#### Scenario: Stop hook closes the session

- **WHEN** Claude Code fires the `Stop` hook for an active session
- **THEN** the script SHALL POST to `/api/foo/sessions/<session_id>/end`
- **AND** the server SHALL transition the row to `status='ended'` with `ended_at=now` and `summary=NULL`

#### Scenario: Stop hook fires after PreCompact already ended the session

- **GIVEN** PreCompact already transitioned the session to `status='ended'` with a summary
- **WHEN** the `Stop` hook fires and POSTs to `/end`
- **THEN** the server SHALL respond `409 session_already_ended` and the script SHALL exit `0`
- **AND** the session row SHALL remain in `ended` state with its prior summary intact

#### Scenario: SessionStart nudge under Codex passes plain-text path

- **GIVEN** the user has enabled `plugin_hooks` and approved the SessionStart hook via `/hooks` review
- **WHEN** Codex fires the `SessionStart` hook
- **THEN** the script's stdout begins with `rembric:` (NOT `{` or `[`)
- **AND** Codex's `parse_session_start` returns `None` (not structured JSON), `looks_like_json` returns `false`, and the dispatcher takes the plain-text branch
- **AND** the stdout is injected as `additional_context` into the agent's first turn
- **AND** no `hook returned invalid session start JSON output` error appears

### Requirement: Hook script invariants

- Every hook script SHALL use `#!/usr/bin/env bash` and `set -u`.
- Every script SHALL trap errors (`trap 'exit 0' ERR`) and ensure `exit 0` with empty stdout on any failure. Plugin-side failure SHALL NOT break a Claude Code session.
- Every script SHALL be executable (mode 755).
- The first non-whitespace character of a hook script's stdout SHALL NOT be `{` or `[`, UNLESS the script intentionally emits a well-formed JSON object matching the relevant Codex hook event schema (`codex-rs/hooks/src/engine/output_parser.rs::parse_session_start` and siblings). Codex's `looks_like_json` heuristic treats stdout starting with those characters as a JSON attempt; a malformed leading character (e.g. our former `[rembric]` badge prefix) fails the hook with `invalid ... JSON output`. Today every Rembric hook emits either empty stdout or a plain-text nudge prefixed with `rembric:` — neither triggers the heuristic.

#### Scenario: Hook stdout starts with a safe prefix

- **WHEN** any of the four Rembric hooks emits stdout
- **THEN** the first non-whitespace character SHALL be a letter, digit, or other safe character — NEVER `{` or `[` (unless the script is intentionally emitting valid JSON, which none currently does)
- **AND** Codex's plain-text additional_context branch SHALL be taken for both `SessionStart` and `UserPromptSubmit`
