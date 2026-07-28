## MODIFIED Requirements

### Requirement: The plugin SHALL ship six hook event types across nine handler entries at `apps/plugin/hooks/hooks.json`

The plugin's hook catalog SHALL declare exactly six event types: `SessionStart` (with TWO matcher groups — one for `startup|resume|clear`, one for `compact`), `UserPromptSubmit` (TWO entries, NEITHER carrying a `matcher` key — the recall/first-prompt entry and the per-turn save nudge), `SessionEnd`, `PreCompact`, `PostCompact`, and `Stop` (TWO entries — an asynchronous raw sync and a synchronous end-of-turn reminder). That is **nine handler entries** in total. It SHALL NOT declare a `PostToolUse` entry (the save nudge moved off `PostToolUse` onto the `UserPromptSubmit` unified nudge in the `proactive-save-nudges` change).

Both counts SHALL be asserted as an exact set, not a containment check: a `toContain`-style assertion cannot catch a spec or manifest that wrongly claims an event type is _absent_, which is the defect class this requirement replaces. The handler count is stated separately from the event-type count because Codex's per-hook trust prompt counts handlers while its documentation counts event types (see `codex-distribution`).

`PreCompact` and `PostCompact` snapshot transcript/compaction-summary state as pure side effects — neither emits stdout that reaches the model. The matcher-less `UserPromptSubmit` entries emit throttled plain-stdout reminders. Full behavioural detail lives in the per-hook subsections below and in the `plugin-session-protocol` capability's lifecycle mapping, which is the authoritative table of which hook POSTs what.

The historical reason a `Stop` hook was once removed was a **semantic bug**, not a structural prohibition on `Stop` itself: Claude Code's `Stop` fires once per assistant turn (verified against `code.claude.com/docs/en/hooks`), not at session end. The prior `Stop` hook posted to `/end` (session termination), so the first turn prematurely transitioned the session to `ended` and every subsequent turn's call failed silently. `SessionEnd` remains the correct lifecycle hook for one-per-session terminal behaviour. The `Stop` hook required here never posts to `/end` and never transitions session status — it cannot trigger that bug. `Stop` now carries a SECOND entry that IS model-facing, and the decision `proactive-save-nudges` recorded is **narrowed rather than reversed**. That change declined `Stop` on forced-continuation risk, which is a property of the host's BLOCKING decision, not of the event. A non-interrupting `hookSpecificOutput.additionalContext` reminder carries the same text at the same moment and cannot hold a turn open, so the risk that justified declining does not apply to it. The two `Stop` entries therefore have opposite obligations and SHALL NOT be merged: the raw sync stays asynchronous so it never delays the turn, and the reminder MUST NOT be asynchronous, because an asynchronous handler is fire-and-forget by the host's contract and cannot contribute feedback at all. Wiring the reminder asynchronously silently forfeits it. Neither entry ever posts to `/end` or transitions session status. Behaviour is specified in `plugin-session-protocol`.

#### SessionStart (matcher: startup|resume|clear)

- Type: `command`.
- Matcher: `startup|resume|clear`.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh claude-code`.
- The script SHALL read `session_id`, `cwd`, and `source` from hook stdin.
- The script SHALL read `${cwd}/.rembric` for `PROJECT_SLUG` using the same dotenv parser as the bridge.
- When a valid slug is resolved, the script SHALL POST `${REMBRIC_SERVER_URL}/api/<slug>/sessions` with body `{"id": "<session_id>", "cwd": "<cwd>", "agent": "claude-code"}`. The server-side handler writes the placeholder title.
- The script SHALL emit the generic nudge `rembric: If this is a continuation of recent work, call memory.context before responding.` to stdout.
- Output cap: ≤30 tokens (measured 22.25 — 89 bytes newline-exclusive, the convention pinned below; the one budget in this capability that held as originally written).

#### SessionStart (matcher: compact)

- Type: `command`.
- Matcher: `compact`.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/post-compact.sh claude-code`.
- The script SHALL read `session_id` and `cwd` from hook stdin (slug resolution piggybacks on `.rembric` as elsewhere).
- When both `session_id` and a valid slug resolve, the script SHALL re-POST `${REMBRIC_SERVER_URL}/api/<slug>/sessions` as an idempotent session-row ensure, covering the case where the stale sweep abandoned the row between the pre-compact moment and the resume. This hook is NOT stdout-only.
- The script SHALL emit an imperative instruction block to stdout, prefixed `rembric:` so Codex's `looks_like_json` heuristic does not flag it. The instruction SHALL direct the model to: (1) call `memory.session_summary({title, summary})` with the compact summary it just produced (which appears in its context above the hook output), specifying Title (≤100 chars, descriptive) and Summary (Goal · Discoveries · Accomplished · Next Steps · Files); (2) call `memory.context` or `memory.search` if it needs prior context to continue. The section list SHALL be the one canonical structure defined in `sessions`, carried verbatim rather than restated.
- Output cap: ≤150 tokens. `plugin-session-protocol` asserts the same number and the two SHALL be changed together.
- This stdout IS injected into the model's context, because `SessionStart` is one of the events documented as carrying stdout into context.

#### UserPromptSubmit (entry 1 — recall keyword + first prompt)

- Type: `command`.
- Matcher: NONE. The entry SHALL NOT declare a `matcher` key. Claude Code's dispatcher would otherwise filter invocation, and the script needs to see **every** prompt to detect the session's first one. Codex ignores the manifest matcher for this event regardless, so a matcher-less registration is also the only shape that behaves identically on both clients.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/prompt-search.sh`.
- The script SHALL self-filter internally for TWO independent triggers, emitting one line each, and MAY emit both on the same turn:
  1. a recall-intent keyword (`remember|recall|acuérdate|qué hicimos|what did we do`, case-insensitive) matched against the stdin `prompt` field, on any turn;
  2. the session's first prompt, tracked by its OWN per-session turn counter under `${TMPDIR:-/tmp}/rembric-relevance-prefetch/` — distinct from `prompt-nudge.sh`'s `rembric-turnnudge/` counter, so the two scripts' independent cadences never double-increment each other.
- Unparseable or empty stdin SHALL fail OPEN on the keyword trigger (emit the recall line) and fail CLOSED on the first-prompt trigger (an unreadable counter SHALL NOT be read as turn 1).
- The script SHALL make NO network call. It sources `_api.sh` for the stdin and counter helpers only.

#### UserPromptSubmit (entry 2 — unified per-turn nudge)

- Type: `command`. Matcher: NONE.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/prompt-nudge.sh`. Behaviour is specified by this capability's unified-nudge requirement and by `plugin-session-protocol`'s sessionId-nudge requirement; not restated here.

#### SessionEnd

- Type: `command`.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-end.sh`.
- The script SHALL read `session_id`, `cwd`, `transcript_path`, and `reason` from hook stdin.
- The script SHALL read `${cwd}/.rembric` for `PROJECT_SLUG`.
- When both resolve, the script SHALL read `transcript_path` if the file exists, format the transcript via the shared `_transcript.sh` helper (oldest-first `role: content` lines, truncated to 19500 chars), extract a title from the first non-empty assistant message (truncated to 100 chars), and POST `${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/end` with body `{"summary": "<formatted>", "title": "<derived>", "final": false}`.
- When `transcript_path` is missing/unreadable/empty, the script SHALL POST `/end {}` (degraded mode — transition without summary).
- The script SHALL discard the response, SHALL emit no stdout (`SessionEnd` is not stdout-injected), and SHALL exit `0` on any error.
- Output cap: 0 tokens to model (side effect).

#### PreCompact

- Type: `command`.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/pre-compact.sh claude-code`.
- The script SHALL snapshot the still-readable transcript to `/api/<slug>/sessions/<session_id>/summary` with `final:false`, degrading to `{}` when no transcript parses.
- Output cap: 0 tokens to model (side effect).

#### PostCompact

- Type: `command`.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/post-compaction.sh`.
- The script SHALL POST the model-authored `compaction_summary` from stdin to `/api/<slug>/sessions/<session_id>/summary` with `final:false`, after routing it through `_transcript.sh`'s `rembric_redact_private` choke point (the compactor quotes conversation content verbatim, so the payload is transcript-derived — see `plugin-session-protocol`'s client-side redaction requirement). It SHALL degrade to `{}` with one stderr diagnostic when stdin carries no compaction summary.
- Output cap: 0 tokens to model (side effect).

#### Stop

- Type: `command`.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/stop-sync.sh claude-code`.
- The script SHALL read `session_id`, `cwd`, and `transcript_path` from hook stdin.
- The script SHALL read `${cwd}/.rembric` for `PROJECT_SLUG`.
- When both resolve and `transcript_path` is readable, the script SHALL format the transcript via the SAME shared `_transcript.sh` helpers `SessionEnd` uses (`rembric_format_transcript_claude_code`, `rembric_extract_first_assistant_claude_code`) and POST `${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/summary` with body `{"summary": "<formatted>", "title": "<derived>"}` — the `final` field SHALL be omitted (never `true`, never `false`), so the write can never mark the session curated. Codex's variant of the same script sends `final:false` explicitly; that divergence is specified in `codex-distribution`.
- The script SHALL emit NO stdout under any circumstance — no `hookSpecificOutput`, no plain text. This hook exists purely as a side effect; it SHALL NOT be used as a channel to inject anything into the model's context. Output cap: 0 tokens to model.
- The hook entry SHALL declare `"async": true` **and** the script SHALL additionally daemonize its own work: the transcript-format-and-POST body runs in a detached background subshell with stdout and stderr redirected to `/dev/null`, followed by `disown`. Both mechanisms are required, and the redirect is load-bearing — without it an inherited pipe file descriptor in the child keeps the host waiting on that descriptor regardless of how quickly the parent returns, so `"async": true` alone does not make the hook non-blocking. Whether the `async` flag by itself decouples `Stop` from turn latency is unconfirmed upstream; the script therefore does not depend on it.
- The script SHALL run unconditionally on every `Stop`, with no throttle and no counter file. Because the work is daemonized it carries no turn-latency cost that a throttle would need to amortise.
- The script SHALL discard the response and SHALL exit `0` on any error, identically to every other hook script's fail-safe discipline.

#### Scenario: The two Stop entries have opposite execution models

- **WHEN** `hooks.json`'s `Stop` handlers are read in order
- **THEN** the first SHALL invoke the raw sync and SHALL declare `async: true`
- **AND** the second SHALL invoke the end-of-turn reminder and SHALL NOT declare `async`
- **AND** the assertion SHALL be an ordered pair of (script, async), because getting either flag wrong disables that entry silently rather than loudly

#### Scenario: SessionStart hook creates a session and writes the placeholder title

- **GIVEN** the plugin is installed, `${cwd}/.rembric` contains `PROJECT_SLUG=foo`, project `foo` exists, and `REMBRIC_SERVER_URL` is reachable
- **WHEN** Claude Code fires the `SessionStart` hook (`source: startup`) with stdin `{"session_id": "claude-sess-abc12345", "cwd": "/home/u/foo"}` at 22:14 UTC
- **THEN** the script SHALL POST to `${REMBRIC_SERVER_URL}/api/foo/sessions` with body `{"id": "claude-sess-abc12345", "cwd": "/home/u/foo", "agent": "claude-code"}`
- **AND** the server SHALL insert a row with `title = 'foo · 22:14 UTC'`, `title_final = false`
- **AND** the script SHALL still emit the `rembric: If this is a continuation...` nudge on stdout

#### Scenario: SessionStart hook with matcher compact re-ensures the row and injects the instruction

- **WHEN** Claude Code resumes a session from auto-compaction and fires `SessionStart` with `source: 'compact'`
- **THEN** `post-compact.sh` SHALL POST `/api/foo/sessions` with the session id, cwd and agent, so a row abandoned by the stale sweep is re-created silently
- **AND** SHALL emit a multi-line instruction to stdout prefixed with `rembric:` directing the model to call `memory.session_summary` with the compact summary visible in its context
- **AND** the next model turn SHALL see the instruction in its context and (when cooperating) SHALL call `memory.session_summary({title, summary})` with the model-authored values

#### Scenario: Neither UserPromptSubmit entry declares a matcher

- **WHEN** `apps/plugin/hooks/hooks.json` is loaded
- **THEN** both `UserPromptSubmit` entries SHALL be objects with a `hooks` array and NO `matcher` key
- **AND** the assertion SHALL fail the build if a `matcher` is added to either

#### Scenario: prompt-search.sh emits the recall line on a keyword at any turn

- **GIVEN** a session already past its first prompt
- **WHEN** `UserPromptSubmit` fires with stdin whose `prompt` field contains `what did we do`
- **THEN** `prompt-search.sh` SHALL emit exactly the recall line and SHALL NOT emit the first-prompt line

#### Scenario: prompt-search.sh emits the first-prompt line once per session

- **WHEN** `UserPromptSubmit` fires for the first time in a session with a prompt containing no recall keyword
- **THEN** `prompt-search.sh` SHALL emit exactly the first-prompt line
- **AND** on the second and subsequent prompts of the same session it SHALL NOT emit that line again

#### Scenario: Both prompt-search.sh lines can coincide on turn 1

- **WHEN** the first prompt of a session also contains a recall keyword
- **THEN** `prompt-search.sh` SHALL emit both lines, first-prompt line first
- **AND** this is the worst case `prompt-search.sh` alone can reach; it is NOT the worst-case `UserPromptSubmit` turn, which is the counter-divergence case the token-budget requirement's per-firing-turn ceiling is set against

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
- **THEN** `stop-sync.sh` SHALL POST `/api/foo/sessions/<S>/summary` with body `{"summary": "<formatted>", "title": "<derived>"}` containing no `final` key
- **AND** the row's `summary_final` and `title_final` SHALL remain (or become) `false`
- **AND** the hook SHALL emit no stdout of any kind — nothing reaches the model's context from this event

#### Scenario: Stop hook never overwrites a curated summary

- **GIVEN** a session whose `summary_final = true` (set via `memory.session_summary`)
- **WHEN** `Stop` fires and `stop-sync.sh` POSTs a freshly-formatted raw transcript
- **THEN** the write SHALL be silently skipped by the existing `final`-precedence rule
- **AND** the curated `summary`/`title` SHALL remain unchanged

#### Scenario: Stop hook is both declared async and self-daemonized

- **WHEN** `apps/plugin/hooks/hooks.json` and `apps/plugin/scripts/stop-sync.sh` are inspected
- **THEN** the `Stop` handler entry SHALL carry `"async": true`
- **AND** the Claude Code branch of the script SHALL run its sync body as a backgrounded subshell with both stdout and stderr redirected to `/dev/null`, followed by `disown`
- **AND** no per-session counter file SHALL exist for `Stop`, and no `Stop` invocation SHALL be skipped

#### Scenario: Hook catalog lives at the new path

- **WHEN** Claude Code consumes the plugin from the marketplace
- **THEN** `${CLAUDE_PLUGIN_ROOT}/hooks/hooks.json` SHALL resolve to a file whose source-of-truth in this repository is `apps/plugin/hooks/hooks.json`
- **AND** the file's event-type set SHALL be exactly `{SessionStart, UserPromptSubmit, SessionEnd, PreCompact, PostCompact, Stop}` carrying exactly eight handler entries, with NO `PostToolUse` entry

### Requirement: The plugin SHALL ship a unified `UserPromptSubmit` per-turn nudge hook

The plugin's hook catalog (`apps/plugin/hooks/hooks.json`) SHALL declare a matcher-less `UserPromptSubmit` entry — distinct from the existing keyword-gated recall entry (`prompt-search.sh`) — invoking a new shared script `${CLAUDE_PLUGIN_ROOT}/scripts/prompt-nudge.sh` that carries BOTH the save and the session-summary reminders on a per-turn cadence. The plugin SHALL NOT ship a `PostToolUse` save-nudge hook (the prior `post-tool.sh` approach is removed; `hooks.json` SHALL contain no `PostToolUse` entry emitting a `memory.save` reminder).

- The entry SHALL declare NO matcher, so it fires on every user prompt. Claude Code supports multiple entries per hook event (`SessionStart` already declares two), so this coexists with the recall entry.
- The script SHALL read `session_id` from hook stdin and maintain a per-session turn counter file under `${TMPDIR:-/tmp}/rembric-turnnudge/<sanitized-session-id>`, incrementing once per invocation.
- On each turn the script SHALL emit, as PLAIN text on stdout (NOT a `hookSpecificOutput` JSON object — plain stdout is the documented `UserPromptSubmit` injection shape):
  - the **save** nudge line when `count % 5 == 0`;
  - the **summary** nudge line ONLY when `count == 1`.
  - The every-`SUMMARY_NUDGE_EVERY` firing MOVED to the end-of-turn reminder (see `plugin-session-protocol`), because the start of a turn is the one moment a summary reminder cannot be acted on — there is always more work coming. What remains here is the first turn, which establishes the obligation rather than reminding about work already done. The two lines therefore coincide only on turn 1 if the save cadence also fires; zero lines are emitted on turns matching neither.
- Both nudge texts SHALL be `rembric:`-prefixed (so the shared Codex path's `looks_like_json` heuristic does not flag them). The save text directs `memory.save` (title ≤100 + content); the summary text directs `memory.session_summary({title≤100, summary})` with the canonical section list defined in `sessions`. Both SHALL be byte-identical to the opencode and Hermes copies, and the section list SHALL be derived from its single source rather than restated.
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

#### Scenario: The every-N summary firing is not duplicated here

- **WHEN** `prompt-nudge.sh` runs on a turn where `count % SUMMARY_NUDGE_EVERY == 0` and `count != 1`
- **THEN** it SHALL NOT emit the summary nudge line
- **AND** `SUMMARY_NUDGE_EVERY` SHALL NOT be declared in `prompt-nudge.sh`, so the cadence has exactly one owner
