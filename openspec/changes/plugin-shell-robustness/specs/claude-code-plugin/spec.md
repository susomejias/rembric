## MODIFIED Requirements

### Requirement: The plugin SHALL ship a thin curl helper at `${CLAUDE_PLUGIN_ROOT}/scripts/_api.sh`

To keep `session-start.sh`, `post-compact.sh`, `session-end.sh`, `pre-compact.sh`, and `post-compaction.sh` minimal and consistent, the plugin SHALL ship a shared helper at `apps/plugin/scripts/_api.sh` that:

- Resolves `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` from the environment.
- Parses `${cwd}/.rembric` for `PROJECT_SLUG` (reuses the same dotenv parser logic). The parser SHALL trim BOTH leading and trailing whitespace from each value before quote-stripping — trailing whitespace SHALL NOT be left in the parsed value, and this trim SHALL also strip a trailing carriage return, so a `.rembric` file saved with CRLF line endings resolves to the same slug the JS bridge (`bin/rembric-dotenv.mjs`, which trims both sides) resolves.
- Exposes a function `rembric_post <path> <json-body>` that issues `curl -sf -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --max-time 3 -d "$body" "$URL"`.
- Exposes a function `rembric_json_escape <string>` that escapes for embedding in a JSON value: backslash, double quote, and every control character in the range U+0000–U+001F. `\n`, `\r`, and `\t` SHALL use their short escape forms; every other character in that range (e.g. ``, an ANSI escape from pasted colored terminal output) SHALL be escaped as `\u00XX` so the output is always valid JSON. Characters at or above U+0020 (including `\x7f`/DEL, which JSON does not require escaping) SHALL be left untouched.
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

#### Scenario: A `.rembric` value with trailing whitespace or CRLF resolves the same as the JS bridge

- **GIVEN** a `.rembric` file containing `PROJECT_SLUG=demo` followed by trailing spaces, OR the same line saved with a trailing `\r\n`
- **WHEN** `rembric_parse_dotenv` parses the file
- **THEN** the parsed `PROJECT_SLUG` value SHALL be exactly `demo`, with no trailing whitespace or carriage return
- **AND** this SHALL match what `bin/rembric-dotenv.mjs` (the bridge's parser) resolves for the same file

#### Scenario: rembric_json_escape produces valid JSON for a transcript containing an ANSI escape

- **GIVEN** a string containing a raw `\x1b` (ESC) byte, e.g. from pasted colored terminal output
- **WHEN** `rembric_json_escape` is called on it
- **THEN** the output SHALL contain `` in place of the raw byte
- **AND** embedding the output as a JSON string value and parsing it back SHALL reproduce the original byte exactly

### Requirement: The plugin SHALL ship a unified `UserPromptSubmit` per-turn nudge hook

The plugin's hook catalog (`apps/plugin/hooks/hooks.json`) SHALL declare a matcher-less `UserPromptSubmit` entry — distinct from the existing keyword-gated recall entry (`prompt-search.sh`) — invoking a new shared script `${CLAUDE_PLUGIN_ROOT}/scripts/prompt-nudge.sh` that carries BOTH the save and the session-summary reminders on a per-turn cadence. The plugin SHALL NOT ship a `PostToolUse` save-nudge hook (the prior `post-tool.sh` approach is removed; `hooks.json` SHALL contain no `PostToolUse` entry emitting a `memory.save` reminder).

- The entry SHALL declare NO matcher, so it fires on every user prompt. Claude Code supports multiple entries per hook event (`SessionStart` already declares two), so this coexists with the recall entry.
- The script SHALL read `session_id` from hook stdin and maintain a per-session turn counter file under `${TMPDIR:-/tmp}/rembric-turnnudge/<sanitized-session-id>`, incrementing once per invocation.
- On each turn the script SHALL emit, as PLAIN text on stdout (NOT a `hookSpecificOutput` JSON object — plain stdout is the documented `UserPromptSubmit` injection shape):
  - the **save** nudge line when `count % 5 == 0`;
  - the **summary** nudge line when `count == 1` OR `count % 10 == 0`.
  - Both lines MAY be emitted on the same turn (their cadences coincide every 10th turn); zero lines are emitted on turns matching neither.
- Both nudge texts SHALL be `rembric:`-prefixed (so the shared Codex path's `looks_like_json` heuristic does not flag them). The save text directs `memory.save` (title ≤100 + content); the summary text directs `memory.session_summary({title≤100, summary})` with the `Goal · Discoveries · Accomplished · Next Steps · Files` structure. Both SHALL be byte-identical to the opencode and Hermes copies.
- The script SHALL make NO network call and needs no `REMBRIC_SERVER_URL`/`REMBRIC_API_TOKEN`.
- The script SHALL fail safe: unreadable/empty stdin, an unreadable OR unwritable counter file, or any other error SHALL exit `0` AND emit NOTHING (no save or summary line). A broken counter mechanism SHALL NOT be treated as an implicit `count=0` — that value satisfies BOTH firing thresholds (`0 % 5 == 0` and `0 % 10 == 0`) and would fire every nudge on every single turn instead of none.

#### Scenario: Save nudge fires every 5th turn

- **GIVEN** the plugin is installed and a Claude Code session
- **WHEN** `UserPromptSubmit` fires for the 5th time with stdin `{"session_id":"claude-sess-abc"}`
- **THEN** `prompt-nudge.sh` SHALL emit the plain `rembric:` save nudge on stdout
- **AND** SHALL NOT emit the save nudge on turns 1–4

#### Scenario: Summary nudge fires on turn 1 and every 10th turn

- **WHEN** `UserPromptSubmit` fires for the 1st time in a session
- **THEN** `prompt-nudge.sh` SHALL emit the plain `rembric:` summary nudge
- **AND** SHALL emit it again on turn 10 (`count % 10 == 0`) and not on turns 2–9

#### Scenario: Both nudges emit on a coinciding turn

- **WHEN** the turn count is a multiple of 10 (both `%5` and `%10` match)
- **THEN** `prompt-nudge.sh` SHALL emit BOTH the save line and the summary line as plain stdout (two lines), neither replacing the other

#### Scenario: No PostToolUse save-nudge hook exists

- **WHEN** `apps/plugin/hooks/hooks.json` is inspected
- **THEN** it SHALL contain no `PostToolUse` entry emitting a `memory.save` reminder
- **AND** `apps/plugin/scripts/post-tool.sh` SHALL NOT exist

#### Scenario: Fail-safe on unreadable stdin

- **WHEN** `UserPromptSubmit` fires and stdin is empty or unparseable
- **THEN** `prompt-nudge.sh` SHALL exit 0 and emit nothing that breaks the host

#### Scenario: Fail-closed when the counter file is unwritable

- **GIVEN** `${TMPDIR:-/tmp}/rembric-turnnudge` cannot be created or the per-session counter file cannot be read back (e.g. a path component exists as a regular file, or the directory is not writable)
- **WHEN** `UserPromptSubmit` fires
- **THEN** `prompt-nudge.sh` SHALL exit `0` and emit NEITHER the save nor the summary nudge
- **AND** it SHALL NOT default the turn count to `0` and fire both nudges as a result
