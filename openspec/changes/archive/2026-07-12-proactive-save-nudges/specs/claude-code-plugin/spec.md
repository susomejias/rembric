## ADDED Requirements

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
- The script SHALL fail safe: unreadable/empty stdin or any error SHALL exit 0 (still maintaining the counter under a fallback key).

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
