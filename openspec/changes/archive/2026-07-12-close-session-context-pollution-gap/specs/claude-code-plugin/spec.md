## MODIFIED Requirements

### Requirement: The plugin SHALL ship exactly four hooks at `apps/plugin/hooks/hooks.json`

The plugin's hook catalog SHALL declare: `SessionStart` (with TWO matcher groups — one for `startup|resume|clear`, one for `compact`), `UserPromptSubmit` (TWO entries — the keyword-gated recall entry and the matcher-less unified per-turn save+summary nudge), `SessionEnd`, `PreCompact`, `PostCompact`, and `Stop`. It SHALL NOT declare a `PostToolUse` entry (the save nudge moved off `PostToolUse` onto the `UserPromptSubmit` unified nudge in the `proactive-save-nudges` change).

`PreCompact` and `PostCompact` (re-added after this requirement previously removed them) snapshot transcript/compaction-summary state as pure side effects — neither emits stdout that reaches the model. The matcher-less `UserPromptSubmit` unified nudge emits throttled `memory.save` and `memory.session_summary` reminders as plain stdout (see the `proactive-save-nudges` change; unchanged by this one). Full behavioral detail lives in those requirements/changes and is not restated here — this requirement's scope is the catalog's shape plus the hooks detailed below.

The historical reason a `Stop` hook was once removed was a **semantic bug**, not a structural prohibition on `Stop` itself: Claude Code's `Stop` fires once per assistant turn (verified against `code.claude.com/docs/en/hooks`), not at session end. The prior `Stop` hook posted to `/end` (session termination), so the first turn prematurely transitioned the session to `ended` and every subsequent turn's call failed silently. `SessionEnd` remains the correct lifecycle hook for one-per-session terminal behaviour and is unchanged. The `Stop` hook re-added by this requirement never posts to `/end` and never transitions session status — it cannot trigger that bug. It also never emits `hookSpecificOutput.additionalContext` or any other model-facing output, so it is a categorically different use of the event from a model-facing nudge (which a separate change, `proactive-save-nudges`, evaluated and declined for `Stop` due to forced-continuation risk — that decision is unaffected).

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
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/post-compact.sh claude-code`.
- The script SHALL read `session_id` and `cwd` from hook stdin (slug resolution piggybacks on `.rembric` as elsewhere).
- The script SHALL emit an imperative instruction block to stdout, prefixed `rembric:` so Codex's `looks_like_json` heuristic does not flag it. The instruction SHALL direct the model to: (1) call `memory.session_summary({title, summary})` with the compact summary it just produced (which appears in its context above the hook output), specifying Title (≤100 chars, descriptive) and Summary (Goal · Discoveries · Accomplished · Next Steps · Files); (2) call `memory.context` if it needs prior context to continue.
- Output cap: ≤120 tokens (the instruction needs more room than a nudge).
- This stdout IS injected into the model's context, because `SessionStart` is one of the events documented as carrying stdout into context.

#### UserPromptSubmit

- Type: `command`.
- Matcher: `remember|recall|acuérdate|qué hicimos|what did we do` (case-insensitive).
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/prompt-search.sh`.
- Behaviour unchanged from prior spec.

#### SessionEnd

- Type: `command`.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-end.sh`.
- The script SHALL read `session_id`, `cwd`, `transcript_path`, and `reason` from hook stdin.
- The script SHALL read `${cwd}/.rembric` for `PROJECT_SLUG`.
- When both resolve, the script SHALL read `transcript_path` if the file exists, format the transcript via the shared `_transcript.sh` helper (oldest-first `role: content` lines, truncated to 19500 chars), extract a title from the first non-empty assistant message (truncated to 100 chars), and POST `${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/end` with body `{"summary": "<formatted>", "title": "<derived>", "final": false}`.
- When `transcript_path` is missing/unreadable/empty, the script SHALL POST `/end {}` (degraded mode — transition without summary).
- The script SHALL discard the response, SHALL emit no stdout (`SessionEnd` is not stdout-injected), and SHALL exit `0` on any error.

#### Stop

- Type: `command`.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/stop-sync.sh`.
- The script SHALL read `session_id`, `cwd`, and `transcript_path` from hook stdin.
- The script SHALL read `${cwd}/.rembric` for `PROJECT_SLUG`.
- When both resolve and `transcript_path` is readable, the script SHALL format the transcript via the SAME shared `_transcript.sh` helpers `SessionEnd` uses (`rembric_format_transcript_claude_code`, `rembric_extract_first_assistant_claude_code`) and POST `${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/summary` with body `{"summary": "<formatted>", "title": "<derived>"}` — the `final` field SHALL be omitted (never `true`), so the write can never mark the session curated.
- The script SHALL emit NO stdout under any circumstance — no `hookSpecificOutput`, no plain text. This hook exists purely as a side effect; it SHALL NOT be used as a channel to inject anything into the model's context.
- The hook entry SHALL declare `"async": true`. IF validated (during this capability's e2e pass) to genuinely decouple the POST from turn completion, the script SHALL run unconditionally on every `Stop`, with no throttle. IF validation shows `async` does not reliably decouple latency, the script SHALL instead maintain a per-session counter file (mirroring the per-session counter-file pattern used by `prompt-nudge.sh`, e.g. `${TMPDIR}/rembric-turnnudge/`) and only POST every 3rd `Stop`.
- The script SHALL discard the response and SHALL exit `0` on any error, identically to every other hook script's fail-safe discipline.

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

#### Scenario: Stop hook syncs summary and title without touching the model

- **GIVEN** a Claude Code session mid-conversation, whose `transcript_path` JSONL contains at least one assistant message
- **WHEN** Claude Code fires `Stop` with stdin `{"session_id": "...", "transcript_path": "/path/to/transcript.jsonl", "cwd": "..."}`
- **THEN** `stop-sync.sh` SHALL POST `/api/foo/sessions/<S>/summary` with body `{"summary": "<formatted>", "title": "<derived>"}` (no `final` field)
- **AND** the row's `summary_final` and `title_final` SHALL remain (or become) `false`
- **AND** the hook SHALL emit no stdout of any kind — nothing reaches the model's context from this event

#### Scenario: Stop hook never overwrites a curated summary

- **GIVEN** a session whose `summary_final = true` (set via `memory.session_summary`)
- **WHEN** `Stop` fires and `stop-sync.sh` POSTs a freshly-formatted raw transcript
- **THEN** the write SHALL be silently skipped by the existing `final`-precedence rule
- **AND** the curated `summary`/`title` SHALL remain unchanged

#### Scenario: Stop hook cadence falls back to a throttle if async doesn't decouple latency

- **GIVEN** the `"async": true` hook declaration is validated NOT to decouple the POST from turn completion
- **WHEN** `Stop` fires
- **THEN** `stop-sync.sh` SHALL only POST on every 3rd matched call for that session, using the same counter-file pattern as `prompt-nudge.sh`
- **AND** SHALL emit no output on the 2 skipped calls

#### Scenario: Hook catalog lives at the new path

- **WHEN** Claude Code consumes the plugin from the marketplace
- **THEN** `${CLAUDE_PLUGIN_ROOT}/hooks/hooks.json` SHALL resolve to a file whose source-of-truth in this repository is `apps/plugin/hooks/hooks.json`
- **AND** the file SHALL declare the hook entries listed above (`SessionStart` × 2 matchers, `UserPromptSubmit` × 2 — recall + unified nudge, `SessionEnd`, `PreCompact`, `PostCompact`, `Stop`), with NO `PostToolUse` entry
