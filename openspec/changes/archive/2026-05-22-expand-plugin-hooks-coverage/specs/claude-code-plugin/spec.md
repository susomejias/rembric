## MODIFIED Requirements

### Requirement: The plugin SHALL ship six hooks at `apps/plugin/hooks/hooks.json`

The plugin's hook catalog SHALL declare six entries: `SessionStart` (with TWO matcher groups — one for `startup|resume|clear`, one for `compact`), `UserPromptSubmit`, `SessionEnd`, `PreCompact`, and `PostCompact`. Both `PreCompact` and `PostCompact` are wired in this version — superseding the prior spec's "the prior PreCompact entry SHALL NOT be wired" exclusion, which was authored when the script and contract were ill-defined. The current wiring uses correctly-shaped stdin parsing and respects the documented "stdout is NOT model-context-injected" contract for both events.

#### SessionStart (matcher: startup|resume|clear)

(Unchanged from the prior spec — see archived `add-claude-code-plugin` change.)

#### SessionStart (matcher: compact)

- Type: `command`.
- Matcher: `compact`.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/post-compact.sh claude-code`.
- Behaviour identical to the prior spec EXCEPT the imperative instruction text SHALL be sharpened. The script's stdout SHALL now direct the model that when the compact summary above lacks specific detail — exact file paths, prior decisions, concrete error messages — it MUST call `memory.context` or `memory.search` BEFORE responding. The wording SHALL make `memory.context` the canonical recovery path post-compact, not an optional suggestion.
- Output cap: ≤120 tokens (unchanged).
- This stdout IS injected into the model's context (unchanged — SessionStart is one of the events that carries stdout into context per Claude Code hook docs).

#### UserPromptSubmit

(Unchanged from the prior spec.)

#### SessionEnd

(Unchanged from the prior spec.)

#### PreCompact

- Type: `command`.
- Matcher: none (fires on every compact).
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/pre-compact.sh`.
- The script SHALL read `session_id`, `cwd`, `transcript_path`, and (optionally) `compaction_trigger` from hook stdin JSON.
- The script SHALL read `${cwd}/.rembric` for `PROJECT_SLUG` using the same dotenv parser as the bridge.
- When `session_id`, slug, and `transcript_path` all resolve AND the transcript file exists, the script SHALL format the transcript via `_transcript.sh::rembric_format_transcript_claude_code` (oldest-first `role: content`, truncated from the head at 19500 chars) and derive a title from the first non-empty assistant message via `rembric_extract_first_assistant_claude_code` (≤100 chars).
- The script SHALL POST `${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/summary` with body `{"summary":"<formatted>","title":"<derived>","final":false}`. When title derivation fails, the body SHALL omit `title`. When transcript formatting fails or `transcript_path` is missing, the script SHALL POST `{}` (degraded mode) so the row is still touched.
- `PreCompact` stdout is NOT injected into model context (verified against `code.claude.com/docs/en/hooks` — only `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `Stop` carry stdout into context). The script SHALL emit no stdout.
- The script SHALL discard the POST response, SHALL exit `0` on any error, and SHALL be mode 755.

#### PostCompact

- Type: `command`.
- Matcher: none (fires on every compact after the compaction completes).
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/post-compaction.sh`.
- The script SHALL read `session_id`, `cwd`, and `compaction_summary` from hook stdin JSON via existing and new helpers in `_api.sh`.
- The script SHALL read `${cwd}/.rembric` for `PROJECT_SLUG`.
- When `session_id`, slug, and `compaction_summary` all present, the script SHALL POST `${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/summary` with body `{"summary":"<compaction_summary>","final":false}`. The script SHALL NOT include `title` (the compaction_summary is content, not a heading).
- When `compaction_summary` is empty or missing on stdin, the script SHALL POST `/summary {}` (degraded mode) and emit a stderr diagnostic of the form `[rembric] PostCompact: missing compaction_summary on stdin; posting empty body`.
- `PostCompact` stdout is NOT injected into model context. The script SHALL emit no stdout.
- The script SHALL discard the POST response, SHALL exit `0` on any error, and SHALL be mode 755.

#### Scenario: SessionStart hook with matcher compact directs the model to call memory.context when detail is missing

- **WHEN** Claude Code resumes a session from auto-compaction and fires `SessionStart` with `source: 'compact'`
- **THEN** the `post-compact.sh` script SHALL emit a multi-line instruction to stdout prefixed with `rembric:` directing the model to (1) call `memory.session_summary` with the compact summary, AND (2) call `memory.context` or `memory.search` if the compact summary lacks specific detail (file paths, prior decisions, concrete error messages) BEFORE responding to the user's pending prompt
- **AND** the next model turn SHALL see the instruction in its context

#### Scenario: PreCompact persists the transcript before context is wiped

- **GIVEN** a Claude Code session at turn N, where the compactor is about to fire
- **AND** `${cwd}/.rembric` contains `PROJECT_SLUG=foo` and `REMBRIC_SERVER_URL` is reachable
- **WHEN** Claude Code fires the `PreCompact` hook with stdin `{"session_id": "claude-sess-abc12345", "cwd": "/home/u/foo", "transcript_path": "/path/to/transcript.jsonl"}`
- **THEN** `pre-compact.sh` SHALL POST `/api/foo/sessions/claude-sess-abc12345/summary` with body containing `summary` = the formatted transcript (≤19500 chars) and `title` = derived from the first assistant message
- **AND** the script SHALL emit no stdout

#### Scenario: PostCompact persists the model-authored compaction summary directly

- **GIVEN** the same session whose PreCompact already POSTed
- **WHEN** Claude Code completes the compaction and fires `PostCompact` with stdin `{"session_id": "claude-sess-abc12345", "cwd": "/home/u/foo", "compaction_summary": "Worked on auth middleware. Decided on JWT. Files: src/auth.ts."}`
- **THEN** `post-compaction.sh` SHALL POST `/api/foo/sessions/claude-sess-abc12345/summary` with body `{"summary": "Worked on auth middleware. Decided on JWT. Files: src/auth.ts.", "final": false}`
- **AND** the server's `summary_final` precedence SHALL apply normally (if the model already wrote `final:true` via MCP, the new POST is silently no-op)

#### Scenario: PostCompact with missing compaction_summary degrades silently

- **WHEN** Claude Code fires `PostCompact` with stdin `{"session_id": "claude-sess-abc12345", "cwd": "/home/u/foo"}` (no `compaction_summary` key)
- **THEN** `post-compaction.sh` SHALL POST `/summary {}` to touch the row
- **AND** emit a stderr diagnostic naming the missing field
- **AND** exit `0`

#### Scenario: PreCompact and PostCompact stdout do not reach the model

- **WHEN** either `pre-compact.sh` or `post-compaction.sh` runs to completion
- **THEN** the script SHALL emit no stdout
- **AND** the model's subsequent turn context SHALL NOT contain any hook output from these scripts (PreCompact and PostCompact are "side effects only" per `code.claude.com/docs/en/hooks`)

#### Scenario: Hook catalog enumerates six hooks

- **WHEN** `apps/plugin/hooks/hooks.json` is loaded
- **THEN** the file declares hook entries for `SessionStart` (two matcher groups), `UserPromptSubmit`, `SessionEnd`, `PreCompact`, and `PostCompact`
- **AND** the file SHALL NOT contain a `Stop` entry (Claude Code's `Stop` semantics are per-turn and not what we want; Codex CLI is the only client where `Stop` is wired)

## MODIFIED Requirements

### Requirement: The plugin SHALL ship a thin curl helper at `${CLAUDE_PLUGIN_ROOT}/scripts/_api.sh`

To keep `session-start.sh`, `post-compact.sh`, `session-end.sh`, `pre-compact.sh`, and `post-compaction.sh` minimal and consistent, the plugin SHALL ship a shared helper at `apps/plugin/scripts/_api.sh` that:

- Resolves `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` from the environment.
- Parses `${cwd}/.rembric` for `PROJECT_SLUG` (reuses the same dotenv parser logic).
- Exposes a function `rembric_post <path> <json-body>` that issues `curl -sf -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --max-time 3 -d "$body" "$URL"`.
- Exposes a function `rembric_json_escape <string>` that escapes for embedding in a JSON value.
- Exposes functions `rembric_session_id_from_stdin_json`, `rembric_cwd_from_stdin_json`, `rembric_transcript_path_from_stdin_json`, AND a new `rembric_compaction_summary_from_stdin_json` that pulls the `compaction_summary` field from hook stdin JSON. The compaction-summary extractor SHALL prefer `compaction_summary` and SHALL fall back to `compactionSummary` (in case Codex uses camelCase, per the same precedent that `session_id`/`sessionId` already follows).
- Discards stdout and returns `0` even on failure (so callers can `|| true` safely).

The sibling helper `apps/plugin/scripts/_transcript.sh` (unchanged) exposes `rembric_format_transcript_claude_code`, `rembric_extract_first_assistant_claude_code`, `rembric_format_transcript_codex_cli`, and `rembric_extract_first_assistant_codex_cli`. The new `pre-compact.sh` consumes the Claude Code variants directly; Codex's `pre-compact.sh` execution SHALL select the codex_cli variants OR (preferred) the script SHALL detect the agent from `$1` (already conventional for `session-start.sh`) and dispatch accordingly. The contract is: `pre-compact.sh <agent>` accepts the same agent name argument as `session-start.sh`.

Each hook script SHALL `source` `_api.sh` (and `_transcript.sh` where transcript handling is needed) and SHALL NOT inline the curl invocation or transcript parsing directly. The helpers SHALL respect the same "exit 0 on error" discipline as the existing scripts.

#### Scenario: New helpers are sourced by the new scripts

- **WHEN** `pre-compact.sh` or `post-compaction.sh` are read
- **THEN** each SHALL start with `source "${SCRIPT_DIR}/_api.sh"` (where `SCRIPT_DIR` is the script's own directory)
- **AND** `pre-compact.sh` SHALL also `source "${SCRIPT_DIR}/_transcript.sh"` (transcript needed)
- **AND** neither SHALL inline a literal `curl` invocation outside the helper

#### Scenario: rembric_compaction_summary_from_stdin_json accepts both naming conventions

- **WHEN** the helper is called with stdin `{"compaction_summary": "X"}` (snake_case, Claude convention)
- **THEN** it SHALL extract `X`

- **WHEN** the helper is called with stdin `{"compactionSummary": "X"}` (camelCase, in case Codex differs)
- **THEN** it SHALL extract `X`

- **WHEN** the helper is called with stdin lacking both keys
- **THEN** it SHALL emit empty string and exit `0`

<!-- Token budget is a `## Section` in the canonical spec, not a `### Requirement`,
     so it cannot be expressed as a MODIFIED Requirement delta. The output cap for
     `post-compact.sh` declared in that section (≤120 tokens) remains the soft
     target; the sharpened nudge stays well within the input window in practice.
     A future change can convert "Token budget" into a proper Requirement if we
     want it enforceable. -->

