## ADDED Requirements

### Requirement: The plugin SHALL ship eight hook event types across twelve handler entries at `apps/plugin/hooks/hooks.json`

The plugin's hook catalog SHALL declare exactly eight event types: `SessionStart` (with TWO matcher groups — one for `startup|resume|clear|fork`, one for `compact`), `UserPromptSubmit` (THREE entries, NONE carrying a `matcher` key — the recall/first-prompt entry, the per-turn line emitter, and the prompt-time recall-hints emitter), `PreToolUse` (TWO entries — matcher `Read|Edit|Write|MultiEdit|NotebookEdit|Bash` for the file-anchored recall hook, and matcher `SubagentHandback` for the subagent report forwarder), `SessionEnd`, `PreCompact`, `PostCompact`, `Stop` (ONE entry — the synchronous end-of-turn report), and `SubagentStop` (ONE entry — the subagent report forwarder). That is **twelve handler entries** in total. It SHALL NOT declare a `PostToolUse` entry (the save nudge moved off `PostToolUse` onto the `UserPromptSubmit` entry in the `proactive-save-nudges` change, and the firing decision moved off the client entirely in `server-gated-session-nudges`). The subagent report forwarder does not reopen that: on Claude Code v2.1.271+ the report a `SubagentHandback` call delivers is its `tool_input.message`, which `PreToolUse` receives exactly as `PostToolUse` would (`code.claude.com/docs/en/hooks`, "which a `PreToolUse` or `PostToolUse` hook matched on `SubagentHandback` receives as `tool_input.message`").

Both counts SHALL be asserted as an exact set, not a containment check: a `toContain`-style assertion cannot catch a spec or manifest that wrongly claims an event type is _absent_, which is the defect class this requirement replaces. The handler count is stated separately from the event-type count because Codex's per-hook trust prompt counts handlers while its documentation counts event types (see `codex-distribution`).

The first matcher group SHALL include `fork`, and its omission was a defect rather than a decision. Claude Code documents five `SessionStart` sources — `startup`, `resume`, `clear`, `compact` and `fork` — where `fork` fires for "a new session forked from an existing one: `--fork-session` with `--resume` or `--continue`, the `/fork` background copy, or `/branch`", with the note "Before v2.1.214, forked sessions reported source `"resume"`". A matcher group that omits it means a forked conversation fires NO hook of this plugin at all: no row is registered, no line is emitted, and every `memory.save` for the life of that conversation persists `session_id = NULL`. A forked session is a NEW session rather than a resumed one — `--fork-session` is documented as "When resuming, create a new session ID instead of reusing the original" — so it belongs in the registration group alongside `startup`, not in a branch of its own.

Both `SessionStart` groups SHALL follow their `/sessions` ensure with one `POST /api/<slug>/sessions/<session_id>/resume`, unconditionally and without inspecting `source`. That rule is uniform across all five clients and is specified once in `plugin-session-protocol`'s lifecycle mapping; this capability records only that both of this client's ensure sites honour it.

`PreCompact` and `PostCompact` snapshot transcript/compaction-summary state as pure side effects — neither emits stdout that reaches the model. The matcher-less `UserPromptSubmit` entries emit plain-stdout lines. The file-recall `PreToolUse` entry emits only `hookSpecificOutput.additionalContext` JSON, or nothing. The two subagent report entries emit nothing at all. Full behavioural detail lives in the per-hook subsections below and in the `plugin-session-protocol` capability's lifecycle mapping, which is the authoritative table of which hook POSTs what.

**`Stop` now carries exactly one entry, and it is model-silent.** The historical reason a `Stop` hook was once removed was a semantic bug, not a structural prohibition: Claude Code's `Stop` fires once per assistant turn, not at session end, and the prior hook posted to `/end`, transitioning the session on turn one. Neither the entry required here nor any of its predecessors since posts to `/end`.

The forced-continuation hazard that governed the two-entry shape is retired at its source rather than guarded. Measured on Claude Code 2.1.232: the `Stop` runner appends a hook's `additionalContext` to the very array it returns as `blockingErrors`, the query loop treats a non-empty array as a block, and the host's consecutive-block cap is not a backstop because a tool-call response resets it — an unguarded reminder re-fired on 141 consecutive continuations. The remaining entry writes NOTHING to that channel: its whole output is an HTTP report, so it cannot start the loop, and the reminder it fetches is delivered on the NEXT turn's `UserPromptSubmit` stdout, where the host has no such behaviour. The `stop_hook_active` check survives for report idempotence rather than loop bounding (`plugin-session-protocol`).

Consequently the raw-sync entry is gone. It was asynchronous because it POSTed a 19.5 KB transcript body every turn; the report that replaces it is small, synchronous and awaited, because the next turn's output depends on its response — an asynchronous handler is fire-and-forget by the host's contract and could not deliver one.

#### SessionStart (matcher: startup|resume|clear|fork)

- Type: `command`.
- Matcher: `startup|resume|clear|fork`.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh claude-code`.
- The script SHALL read `session_id`, `cwd`, and `source` from hook stdin. It SHALL NOT branch on `source`: all four matched values register a row, and `fork` carries a new session id, so registration is the correct response to every one of them.
- The script SHALL read `${cwd}/.rembric` for `PROJECT_SLUG` using the same dotenv parser as the bridge.
- When a valid slug is resolved, the script SHALL POST `${REMBRIC_SERVER_URL}/api/<slug>/sessions` with body `{"id": "<session_id>", "cwd": "<cwd>", "agent": "claude-code"}`. The server-side handler writes the placeholder title.
- Immediately afterwards, and only when the ensure was attempted, the script SHALL POST `${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/resume` with body `{}`. On a fresh row that is a documented no-op; on a row a previous run ended or the sweep abandoned, it is what returns the conversation's memories to it.
- The script SHALL emit the generic nudge `rembric: If this is a continuation of recent work, call memory.context before responding.` to stdout.
- Output cap: ≤30 tokens (measured 22.25 — 89 bytes newline-exclusive, the convention pinned below; the one budget in this capability that held as originally written).

#### SessionStart (matcher: compact)

- Type: `command`.
- Matcher: `compact`.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/post-compact.sh claude-code`.
- The script SHALL read `session_id` and `cwd` from hook stdin (slug resolution piggybacks on `.rembric` as elsewhere).
- When both `session_id` and a valid slug resolve, the script SHALL re-POST `${REMBRIC_SERVER_URL}/api/<slug>/sessions` as an idempotent session-row ensure, and SHALL then POST `${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/resume` with body `{}`. The pair is what covers the case where the stale sweep abandoned the row between the pre-compact moment and the resume; the ensure alone never could, because the ensure path returns a terminal row untouched (`http-api`). This hook is NOT stdout-only.
- The script SHALL emit an imperative instruction block to stdout, prefixed `rembric:` so Codex's `looks_like_json` heuristic does not flag it. Its content and its ≤700-byte cap are governed by `plugin-session-protocol`'s post-compaction requirement, which this change rewords for the section-wise merge; the reworded block SHALL be re-measured in the same commit.
- Output cap: ≤175 tokens. `plugin-session-protocol` asserts the same number and the two SHALL be changed together.
- This stdout IS injected into the model's context, because `SessionStart` is one of the events documented as carrying stdout into context.

#### UserPromptSubmit (entry 1 — recall keyword + first prompt)

- Type: `command`.
- Matcher: NONE. The entry SHALL NOT declare a `matcher` key. Claude Code's dispatcher would otherwise filter invocation, and the script needs to see **every** prompt to detect the session's first one. Codex ignores the manifest matcher for this event regardless, so a matcher-less registration is also the only shape that behaves identically on both clients.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/prompt-search.sh`.
- The script SHALL self-filter internally for TWO independent triggers, emitting one line each, and MAY emit both on the same turn:
  1. a recall-intent keyword (`remember|recall|acuérdate|qué hicimos|what did we do`, case-insensitive) matched against the stdin `prompt` field, on any turn;
  2. the session's first prompt, tracked by its OWN per-session turn counter under `${TMPDIR:-/tmp}/rembric-relevance-prefetch/`. It is now the ONLY turn counter in the plugin tree; the `rembric-turnnudge` counter it used to be distinguished from is deleted.
- Unparseable or empty stdin SHALL fail OPEN on the keyword trigger (emit the recall line) and fail CLOSED on the first-prompt trigger (an unreadable counter SHALL NOT be read as turn 1).
- The script SHALL make NO network call. It sources `_api.sh` for the stdin and counter helpers only.

#### UserPromptSubmit (entry 2 — per-turn line emitter)

- Type: `command`. Matcher: NONE.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/prompt-nudge.sh`. Behaviour is specified by this capability's line-emitter requirement, by `session-nudges`, and by `plugin-session-protocol`'s sessionId-line requirement; not restated here.

#### UserPromptSubmit (entry 3 — prompt-time recall hints)

- Type: `command`. Matcher: NONE.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/prompt-hints.sh` with `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` taken from the plugin options. Its behaviour is owned by the prompt-time recall change (`proactive-entity-recall`); this requirement records only that the entry ships, so the manifest counts stated here are the true ones.

#### PreToolUse (file-anchored recall)

- Type: `command`. Matcher: `Read|Edit|Write|MultiEdit|NotebookEdit|Bash`. The entry SHALL NOT declare `async`: the host documents that a background hook's `additionalContext` is not delivered.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/file-recall.sh claude-code` with `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` taken from the plugin options, and a `timeout` of 2 seconds — above the script's own 0.3-second POST budget and far below the host's 600-second default.
- Behaviour is specified by this capability's file-recall hook requirement and by `plugin-session-protocol`; not restated here.
- Output cap: at most `FILE_RECALL_MAX_BYTES` (1024) bytes of `additionalContext` per file the call names, at most five files per firing, and nothing on every firing that has no fresh path, no match, or a failure.

#### SessionEnd

- Type: `command`.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-end.sh claude-code`. The agent-name argument SHALL be passed explicitly rather than left to the script's default, because Codex CLI wires the same single script with `codex-cli` to select its own transcript parser (`codex-distribution`), and a bare invocation on one client against an argument on the other is the shape that lets the two drift.
- The script SHALL read `session_id`, `cwd`, `transcript_path`, and `reason` from hook stdin.
- The script SHALL read `${cwd}/.rembric` for `PROJECT_SLUG`.
- When both resolve, the script SHALL read `transcript_path` if the file exists and build the fallback body, PREFERRING the deterministic fact extraction over the raw transcript format and falling through to the format when the extractor is unavailable or yields nothing (`sessions`, "A session that ends without a curated summary MUST still leave grounded, checkable facts"). It SHALL extract a title from the first non-empty assistant message (truncated to 100 chars) and POST `${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/end` with body `{"summary": "<body>", "title": "<derived>", "final": false}`.
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

- Type: `command`. The entry SHALL NOT declare `async`.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/stop-report.sh claude-code`.
- The script SHALL read `session_id`, `cwd`, `transcript_path` and `stop_hook_active` from hook stdin, and SHALL exit having done nothing when `stop_hook_active` is `true`, decided before it touches the transcript.
- The script SHALL determine whether the turn invoked a tool by reading only the bytes appended to `transcript_path` since the previous report, matched against `"type":"tool_use"`, and SHALL persist the new byte length for the next report. Where no previous offset is recorded it SHALL scan at most the last 256 KB and SHALL report `true` if the marker appears there.
- The script SHALL POST `${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/turn` with `{"usedTools": <bool>}`, adding `"title"` on the session's first report only, and SHALL cache the response's `lines` for `prompt-nudge.sh` to print on the next turn.
- The script SHALL emit NO stdout under any circumstance — no `hookSpecificOutput`, no plain text, no `decision`. Output cap: 0 tokens to model. This is a strict tightening: the entry this one replaces was the single row in the on-invoke table with no fixed cap.
- The script SHALL run on every `Stop` that is not a continuation, and SHALL exit `0` on any error, identically to every other hook script's fail-safe discipline.

#### PreToolUse (subagent report, matcher: SubagentHandback)

- Type: `command`. Matcher: `SubagentHandback`. The entry SHALL declare `"async": true`, so the hook can never delay, block or deny the hand-back: the host documents that a denied `SubagentHandback` makes the subagent retry up to three times.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/subagent-report.sh claude-code` with `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` taken from the plugin options.
- Behaviour is specified by this capability's subagent-report requirement. Output cap: 0 tokens to model.

#### SubagentStop

- Type: `command`. Matcher: NONE. The entry SHALL declare `"async": true`.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/subagent-report.sh claude-code` with `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` taken from the plugin options — the same script as the `SubagentHandback` entry.
- Behaviour is specified by this capability's subagent-report requirement. Output cap: 0 tokens to model.

#### Scenario: The manifest declares eight event types and twelve handlers

- **WHEN** `apps/plugin/hooks/hooks.json` is loaded
- **THEN** its event-type set SHALL be exactly `{SessionStart, UserPromptSubmit, PreToolUse, SessionEnd, PreCompact, PostCompact, Stop, SubagentStop}`
- **AND** it SHALL carry exactly twelve handler entries, with NO `PostToolUse` entry
- **AND** `PreToolUse` SHALL declare exactly two entries: one with matcher `Read|Edit|Write|MultiEdit|NotebookEdit|Bash`, invoking `file-recall.sh claude-code`, carrying no `async` key; and one with matcher `SubagentHandback`, invoking `subagent-report.sh claude-code`, with `"async": true`
- **AND** `SubagentStop` SHALL declare exactly one entry, with no `matcher` key, invoking `subagent-report.sh claude-code`, with `"async": true`
- **AND** `Stop` SHALL declare exactly one entry, invoking `stop-report.sh`, carrying no `async` key
- **AND** both counts SHALL be asserted as exact sets rather than containment

#### Scenario: `stop-sync.sh` is gone from the tree and from the manifest

- **WHEN** the repository is inspected at HEAD
- **THEN** `apps/plugin/scripts/stop-sync.sh` SHALL NOT exist
- **AND** no manifest entry SHALL reference it

#### Scenario: SessionStart hook creates a session and writes the placeholder title

- **GIVEN** the plugin is installed, `${cwd}/.rembric` contains `PROJECT_SLUG=foo`, project `foo` exists, and `REMBRIC_SERVER_URL` is reachable
- **WHEN** Claude Code fires the `SessionStart` hook (`source: startup`) with stdin `{"session_id": "claude-sess-abc12345", "cwd": "/home/u/foo"}` at 22:14 UTC
- **THEN** the script SHALL POST to `${REMBRIC_SERVER_URL}/api/foo/sessions` with body `{"id": "claude-sess-abc12345", "cwd": "/home/u/foo", "agent": "claude-code"}`
- **AND** SHALL then POST `${REMBRIC_SERVER_URL}/api/foo/sessions/claude-sess-abc12345/resume` with body `{}`, which succeeds as a no-op reporting `previousStatus: 'active'`
- **AND** the server SHALL insert a row with `title = 'foo · 22:14 UTC'`, `title_final = false`
- **AND** the script SHALL still emit the `rembric: If this is a continuation...` nudge on stdout

#### Scenario: A resumed Claude Code session returns its row to active

- **GIVEN** session `<S>` was registered in a previous run and its row is now `ended` (its `SessionEnd` hook fired) or `abandoned` (the stale sweep flipped it)
- **WHEN** the operator runs `claude --resume <S>` and `SessionStart` fires with `source: "resume"` and the SAME `session_id`
- **THEN** `session-start.sh` SHALL POST the ensure and then the resume
- **AND** the row SHALL be `status='active'` with `ended_at IS NULL`
- **AND** the control SHALL pass in the same run: without the resume POST the row stays terminal and a subsequent `memory.save` on that transport persists `session_id = NULL`

#### Scenario: A forked session is registered as a new session

- **GIVEN** the operator runs `claude --resume <S> --fork-session`, which the host documents as creating a new session id
- **WHEN** `SessionStart` fires with `source: "fork"` and a session id `<F>` different from `<S>`
- **THEN** the `startup|resume|clear|fork` matcher group SHALL match, and `session-start.sh` SHALL register `<F>` as a new row
- **AND** the resume that follows SHALL succeed as a no-op against `<F>`
- **AND** `<S>` SHALL be left in whatever state it was already in — a fork SHALL NOT revive the session it was forked from
- **AND** the control SHALL pass in the same run: with `fork` absent from every matcher, no hook fires and no row exists for `<F>`

#### Scenario: SessionStart hook with matcher compact re-ensures the row and injects the instruction

- **WHEN** Claude Code resumes a session from auto-compaction and fires `SessionStart` with `source: 'compact'`
- **THEN** `post-compact.sh` SHALL POST `/api/foo/sessions` with the session id, cwd and agent, and SHALL then POST `/api/foo/sessions/<session_id>/resume`, so a row the stale sweep abandoned mid-conversation is returned to `active`
- **AND** SHALL emit a multi-line instruction to stdout prefixed with `rembric:` directing the model to read the stored summary with `memory.session_get` and then call `memory.session_summary` with the session's CURRENT COMPLETE state — never with the compacted window, which `plugin-session-protocol`'s post-compaction requirement forbids
- **AND** the next model turn SHALL see the instruction in its context and (when cooperating) SHALL call `memory.session_summary({title, summary})` with the model-authored values

#### Scenario: No UserPromptSubmit entry declares a matcher

- **WHEN** `apps/plugin/hooks/hooks.json` is loaded
- **THEN** all three `UserPromptSubmit` entries SHALL be objects with a `hooks` array and NO `matcher` key
- **AND** the assertion SHALL fail the build if a `matcher` is added to any of them

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
- **AND** this is the worst case `prompt-search.sh` alone can reach; it is NOT the worst-case `UserPromptSubmit` turn, which is the pending-notice case the token-budget requirement's per-firing-turn ceiling is set against

#### Scenario: SessionEnd hook captures the transcript and POSTs /end with summary

- **GIVEN** a Claude Code session with at least one assistant turn, whose `transcript_path` JSONL is readable
- **WHEN** Claude Code fires `SessionEnd` with stdin `{"session_id": "...", "transcript_path": "/path/to/transcript.jsonl", "reason": "logout"}`, the hook having been invoked as `session-end.sh claude-code`
- **THEN** the script SHALL build the fallback body from `_transcript.sh`, PREFERRING the deterministic fact extraction and falling through to the transcript formatter when the extractor is unavailable or yields nothing, and derive a title from the first non-empty assistant message
- **AND** SHALL POST `/api/foo/sessions/<S>/end` with body `{"summary": "<body>", "title": "<derived>", "final": false}`
- **AND** the server SHALL transition the row to `status='ended'`, write the summary and title (subject to `final` precedence), and respond `200 OK`

#### Scenario: SessionEnd with missing transcript_path

- **WHEN** SessionEnd fires and `transcript_path` is missing/unreadable
- **THEN** the script SHALL POST `/end {}` and the row SHALL transition to `ended` with whatever summary/title were already in place

#### Scenario: SessionEnd when model already wrote a final summary

- **GIVEN** a session whose `summary_final = true` because the model called `memory.session_summary` mid-session
- **WHEN** SessionEnd fires and posts `/end {summary: "raw transcript", title: "...", final: false}`
- **THEN** the row SHALL transition to `ended`
- **AND** `summary` and `title` SHALL remain the model-authored values (the `final:false` writes are silently skipped due to precedence)

#### Scenario: Hook catalog lives at the new path

- **WHEN** Claude Code consumes the plugin from the marketplace
- **THEN** `${CLAUDE_PLUGIN_ROOT}/hooks/hooks.json` SHALL resolve to a file whose source-of-truth in this repository is `apps/plugin/hooks/hooks.json`
- **AND** the file's event-type set SHALL be exactly `{SessionStart, UserPromptSubmit, PreToolUse, SessionEnd, PreCompact, PostCompact, Stop, SubagentStop}` carrying exactly twelve handler entries, with NO `PostToolUse` entry


### Requirement: `subagent-report.sh` SHALL forward a finished subagent's report, silently and without blocking

`apps/plugin/scripts/subagent-report.sh` is the one forwarder for Claude Code and Codex. It takes the agent name as its first argument (`claude-code` or `codex-cli`), exactly as `session-end.sh` and `stop-report.sh` do. There SHALL be no `subagent-report.codex.sh`.

The script SHALL read `hook_event_name`, `session_id`, `cwd` and `agent_type` from hook stdin, and SHALL take the report text from:

- `tool_input.message` when `hook_event_name` is `PreToolUse` (the `SubagentHandback` call, Claude Code v2.1.271+ in auto mode);
- `last_assistant_message` when `hook_event_name` is `SubagentStop`.

It SHALL do nothing more, and exit `0`, when any of these holds:

- the report is empty, absent or `null`;
- the event is `SubagentStop`, the agent is `claude-code`, and `agent_type` is empty or absent. Claude Code documents that such events come from host-internal agents (prompt suggestions, `/btw`), not from a subagent the model delegated to;
- the report fails the cross-client pre-filter (`plugin-session-protocol`);
- no project slug resolves from `${cwd}/.rembric`, or `session_id` is empty.

Otherwise it SHALL strip `<private>…</private>` spans with the existing shared helper and send `POST ${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/learnings` with body `{"report": <text>, "agentType": <agent_type>}`. It SHALL omit `agentType` when `agent_type` is empty. The POST is capped at 2 seconds through the helper's budget override.

The script SHALL discard the response. On `claude-code` it SHALL write nothing to stdout. On `codex-cli` it SHALL write exactly `{}` to stdout once, on every path including skips and failures, because Codex rejects non-JSON stdout from `SubagentStop`. It SHALL exit `0` on any error.

#### Scenario: A hand-back report is forwarded

- **GIVEN** a `PreToolUse` stdin with `tool_name: "SubagentHandback"`, `agent_type: "Explore"`, a resolvable slug, and `tool_input.message` ending in a `## Key Learnings` list
- **WHEN** `subagent-report.sh claude-code` runs
- **THEN** it SHALL POST `/api/<slug>/sessions/<session_id>/learnings` with that message as `report` and `"agentType": "Explore"`
- **AND** it SHALL write nothing to stdout and exit `0`

#### Scenario: A SubagentStop report is forwarded

- **GIVEN** a `SubagentStop` stdin with a non-empty `agent_type` and a `last_assistant_message` containing a `## Key Learnings` list
- **WHEN** `subagent-report.sh claude-code` runs
- **THEN** it SHALL POST that text as `report`

#### Scenario: A host-internal agent is ignored

- **GIVEN** a `SubagentStop` stdin with `agent_type: ""` and a `last_assistant_message` containing a `## Key Learnings` list
- **WHEN** `subagent-report.sh claude-code` runs
- **THEN** it SHALL make no request and exit `0`

#### Scenario: A report without learnings is not sent

- **GIVEN** a `SubagentStop` stdin whose `last_assistant_message` does not contain the string `key learnings` in any letter case
- **WHEN** the script runs
- **THEN** it SHALL make no request

#### Scenario: Private spans never leave the machine

- **GIVEN** a report containing `<private>secret-value</private>` above its learnings list
- **WHEN** the script forwards it
- **THEN** the posted `report` SHALL NOT contain `secret-value`

#### Scenario: A failed POST is one diagnostic line and nothing else

- **GIVEN** the server is unreachable
- **WHEN** the script forwards a report
- **THEN** it SHALL write exactly one diagnostic line to stderr and exit `0`
- **AND** on `codex-cli` its stdout SHALL be exactly `{}`

## REMOVED Requirements

### Requirement: The plugin SHALL ship seven hook event types across ten handler entries at `apps/plugin/hooks/hooks.json`

**Reason**: This change adds a `SubagentStop` entry and a second `PreToolUse` group, matched on `SubagentHandback`. The requirement's title and scenario titles carry the counts, so it cannot be corrected in place.

**Migration**: Superseded by the eight-event, twelve-handler manifest requirement this change adds to the same capability. That requirement carries every subsection and scenario of the removed one, with the counts corrected.
