## MODIFIED Requirements

### Requirement: The plugin SHALL ship exactly four hooks at `plugin/hooks/hooks.json`

The plugin's hook catalog SHALL declare four entries: `SessionStart` (with TWO matcher groups — one for `startup|resume|clear`, one for `compact`), `UserPromptSubmit`, and `SessionEnd`. The prior `Stop` and `PreCompact` entries SHALL NOT be wired in this version. The prior `pre-compact.sh` script SHALL be deleted from the repo.

The prior `Stop` hook was a semantic bug: Claude Code's `Stop` fires once per assistant turn (verified against `code.claude.com/docs/en/hooks`), not at session end. Wiring it to `POST /end` transitioned the session to `ended` on turn 1 and silently failed on every subsequent turn. `SessionEnd` is the correct lifecycle hook for one-per-session terminal behaviour.

The prior `PreCompact` hook had two problems: (1) its stdout is not injected into the model's context (`PreCompact` is documented as "side effects only", unlike `SessionStart`); (2) its POST body was the hook event metadata blob, not the transcript. Removed entirely.

#### SessionStart (matcher: startup|resume|clear)

- Type: `command`.
- Matcher: `startup|resume|clear`.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh claude-code`.
- The script SHALL read `session_id`, `cwd`, and `source` from hook stdin.
- The script SHALL read `${cwd}/.rembric` for `PROJECT_SLUG` using the same dotenv parser as the bridge.
- When a valid slug is resolved, the script SHALL POST `${REMBRIC_SERVER_URL}/api/<slug>/sessions` with body `{"id": "<session_id>", "cwd": "<cwd>", "agent": "claude-code"}`. The server-side handler writes the placeholder title.
- The script SHALL emit the generic nudge `rembric: If this is a continuation of recent work, call memory.context before responding.` to stdout.
- Output cap: ≤30 tokens.

#### SessionStart (matcher: compact)

- Type: `command`.
- Matcher: `compact`.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/post-compact.sh claude-code` (new script).
- The script SHALL read `session_id` and `cwd` from hook stdin (slug resolution piggybacks on `.rembric` as elsewhere).
- The script SHALL emit an imperative instruction block to stdout, prefixed `rembric:` so Codex's `looks_like_json` heuristic does not flag it. The instruction SHALL direct the model to: (1) call `memory.session_summary({title, summary})` with the compact summary it just produced (which appears in its context above the hook output), specifying Title (≤100 chars, descriptive) and Summary (Goal · Discoveries · Accomplished · Next Steps · Files); (2) call `memory.context` if it needs prior context to continue.
- Output cap: ≤120 tokens (the instruction needs more room than a nudge).
- This stdout IS injected into the model's context, because `SessionStart` is one of the events documented as carrying stdout into context.

#### UserPromptSubmit

- Type: `command`.
- Matcher: `remember|recall|acordate|qué hicimos|what did we do` (case-insensitive).
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/prompt-search.sh`.
- Behaviour unchanged from prior spec.

#### SessionEnd

- Type: `command`.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-end.sh` (new script, REPLACES `session-stop.sh`).
- The script SHALL read `session_id`, `cwd`, `transcript_path`, and `reason` from hook stdin.
- The script SHALL read `${cwd}/.rembric` for `PROJECT_SLUG`.
- When both resolve, the script SHALL read `transcript_path` if the file exists, format the transcript via the shared `_transcript.sh` helper (oldest-first `role: content` lines, truncated to 19500 chars), extract a title from the first non-empty assistant message (truncated to 100 chars), and POST `${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/end` with body `{"summary": "<formatted>", "title": "<derived>", "final": false}`.
- When `transcript_path` is missing/unreadable/empty, the script SHALL POST `/end {}` (degraded mode — transition without summary).
- The script SHALL discard the response, SHALL emit no stdout (`SessionEnd` is not stdout-injected), and SHALL exit `0` on any error.

#### Scenario: SessionStart hook creates a session and writes the placeholder title

- **GIVEN** the plugin is installed, `${cwd}/.rembric` contains `PROJECT_SLUG=foo`, project `foo` exists, and `REMBRIC_SERVER_URL` is reachable
- **WHEN** Claude Code fires the `SessionStart` hook (`source: startup`) with stdin `{"session_id": "claude-sess-abc12345", "cwd": "/home/u/foo"}` at 22:14 UTC
- **THEN** the script SHALL POST to `${REMBRIC_SERVER_URL}/api/foo/sessions` with body `{"id": "claude-sess-abc12345", "cwd": "/home/u/foo", "agent": "claude-code"}`
- **AND** the server SHALL insert a row with `title = 'foo · 22:14 UTC'`, `title_final = false`
- **AND** the script SHALL still emit the `rembric: If this is a continuation...` nudge on stdout

#### Scenario: SessionStart hook with matcher compact injects the imperative instruction

- **WHEN** Claude Code resumes a session from auto-compaction and fires `SessionStart` with `source: 'compact'`
- **THEN** the `post-compact.sh` script SHALL emit a multi-line instruction to stdout prefixed with `rembric:` directing the model to call `memory.session_summary` with the compact summary visible in its context
- **AND** the next model turn SHALL see the instruction in its context and (when cooperating) SHALL call `memory.session_summary({title, summary})` with the model-authored values

#### Scenario: SessionEnd hook captures the transcript and POSTs /end with summary

- **GIVEN** a Claude Code session with at least one assistant turn, whose `transcript_path` JSONL is readable
- **WHEN** Claude Code fires `SessionEnd` with stdin `{"session_id": "...", "transcript_path": "/path/to/transcript.jsonl", "reason": "logout"}`
- **THEN** the script SHALL format the transcript via `_transcript.sh`, derive a title from the first non-empty assistant message
- **AND** SHALL POST `/api/foo/sessions/<S>/end` with body `{"summary": "<formatted>", "title": "<derived>", "final": false}`
- **AND** the server SHALL transition the row to `status='ended'`, write the summary and title (subject to `final` precedence), and respond `200 OK`

#### Scenario: SessionEnd with missing transcript_path

- **WHEN** SessionEnd fires and `transcript_path` is missing/unreadable
- **THEN** the script SHALL POST `/end {}` and the row SHALL transition to `ended` with whatever summary/title were already in place

#### Scenario: SessionEnd when model already wrote a final summary

- **GIVEN** a session whose `summary_final = true` because the model called `memory.session_summary` mid-session
- **WHEN** SessionEnd fires and posts `/end {summary: "raw transcript", title: "...", final: false}`
- **THEN** the row SHALL transition to `ended`
- **AND** `summary` and `title` SHALL remain the model-authored values (the `final:false` writes are silently skipped due to precedence)

### Requirement: The plugin SHALL ship a thin curl helper at `${CLAUDE_PLUGIN_ROOT}/scripts/_api.sh`

To keep `session-start.sh`, `post-compact.sh`, and `session-end.sh` minimal and consistent, the plugin SHALL ship a shared helper at `plugin/scripts/_api.sh` that:

- Resolves `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` from the environment.
- Parses `${cwd}/.rembric` for `PROJECT_SLUG` (reuses the same dotenv parser logic).
- Exposes a function `rembric_post <path> <json-body>` that issues `curl -sf -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --max-time 3 -d "$body" "$URL"`.
- Exposes a function `rembric_json_escape <string>` that escapes for embedding in a JSON value.
- Exposes functions `rembric_session_id_from_stdin_json`, `rembric_cwd_from_stdin_json`, and a new `rembric_transcript_path_from_stdin_json` that pull those fields from stdin JSON.
- Discards stdout and returns `0` even on failure (so callers can `|| true` safely).

A new sibling helper `plugin/scripts/_transcript.sh` SHALL expose `rembric_format_transcript <path>` that reads a JSONL transcript and emits `role: content\n…` oldest-first, truncated to 19500 chars from the tail. The helper SHALL prefer `jq` when available and SHALL fall back to a sed-based parser otherwise; both paths SHALL emit empty string on parse failure rather than crashing.

Each hook script SHALL `source` `_api.sh` (and `_transcript.sh` where transcript handling is needed) and SHALL NOT inline the curl invocation or transcript parsing directly. The helpers SHALL respect the same "exit 0 on error" discipline as the existing scripts.

#### Scenario: Helper is sourced by all hook scripts

- **WHEN** `session-start.sh`, `post-compact.sh`, or `session-end.sh` are read
- **THEN** each SHALL start with `source "${SCRIPT_DIR}/_api.sh"` (where `SCRIPT_DIR` is the script's own directory)
- **AND** `session-end.sh` SHALL also `source "${SCRIPT_DIR}/_transcript.sh"`
- **AND** none SHALL inline a literal `curl` invocation outside the helper

#### Scenario: Helper fails silently when env is incomplete

- **WHEN** `REMBRIC_SERVER_URL` or `REMBRIC_API_TOKEN` is missing
- **THEN** the helper SHALL emit a one-line stderr diagnostic and `rembric_post` SHALL return `0` without issuing a request

#### Scenario: Transcript helper degrades gracefully

- **WHEN** `rembric_format_transcript <path>` is called with a non-existent path
- **THEN** the helper SHALL emit empty string to stdout and exit `0`

- **WHEN** the helper is called with a malformed JSONL file
- **THEN** the helper SHALL extract what it can (best-effort `role`/`content` parse) and emit empty string if nothing parsable was found, exiting `0`

## REMOVED Requirements

### Requirement: The plugin SHALL ship exactly four hooks (prior version)

**Reason**: replaced by the new five-hook layout (SessionStart × 2 matchers, UserPromptSubmit, SessionEnd). The prior version wired `Stop` (which fires per-turn, not per-session — semantic bug) and `PreCompact` (whose stdout doesn't reach the model and whose POST body was hook metadata, not the transcript). Both removed.

**Migration**: existing plugin installations that have already pulled an older `plugin.json` version will continue to wire the old hooks until they update. Behaviour stays the current (broken) state until the plugin version bump in this change reaches them. After update, the old hook scripts (`session-stop.sh`, `pre-compact.sh`) SHALL be deleted from the repo so they cannot be re-invoked accidentally.
