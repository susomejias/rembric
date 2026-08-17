## REMOVED Requirements

### Requirement: The plugin SHALL ship six hook event types across nine handler entries at `apps/plugin/hooks/hooks.json`

**Reason**: The handler count is in the requirement's own title and it changes from nine to eight — `Stop` loses its asynchronous raw-sync entry (`stop-sync.sh` is deleted) and keeps one synchronous entry, now `stop-report.sh`. Renaming rather than editing in place keeps the archive sync unambiguous, since the title is the requirement's identity. The replacement below carries the full content with the `Stop` and `UserPromptSubmit` sections rewritten and every other section unchanged.

**Migration**: No operator action. `hooks.json` and `hooks.codex.json` each lose one `Stop` entry and rename the other's script; both counts are asserted as exact sets by `apps/plugin/test/hook-manifests.test.ts`, which is updated in the same commit.

## ADDED Requirements

### Requirement: The plugin SHALL ship six hook event types across eight handler entries at `apps/plugin/hooks/hooks.json`

The plugin's hook catalog SHALL declare exactly six event types: `SessionStart` (with TWO matcher groups — one for `startup|resume|clear|fork`, one for `compact`), `UserPromptSubmit` (TWO entries, NEITHER carrying a `matcher` key — the recall/first-prompt entry and the per-turn line emitter), `SessionEnd`, `PreCompact`, `PostCompact`, and `Stop` (ONE entry — the synchronous end-of-turn report). That is **eight handler entries** in total. It SHALL NOT declare a `PostToolUse` entry (the save nudge moved off `PostToolUse` onto the `UserPromptSubmit` entry in the `proactive-save-nudges` change, and the firing decision moved off the client entirely in `server-gated-session-nudges`).

Both counts SHALL be asserted as an exact set, not a containment check: a `toContain`-style assertion cannot catch a spec or manifest that wrongly claims an event type is _absent_, which is the defect class this requirement replaces. The handler count is stated separately from the event-type count because Codex's per-hook trust prompt counts handlers while its documentation counts event types (see `codex-distribution`).

The first matcher group SHALL include `fork`, and its omission was a defect rather than a decision. Claude Code documents five `SessionStart` sources — `startup`, `resume`, `clear`, `compact` and `fork` — where `fork` fires for "a new session forked from an existing one: `--fork-session` with `--resume` or `--continue`, the `/fork` background copy, or `/branch`", with the note "Before v2.1.214, forked sessions reported source `"resume"`". A matcher group that omits it means a forked conversation fires NO hook of this plugin at all: no row is registered, no line is emitted, and every `memory.save` for the life of that conversation persists `session_id = NULL`. A forked session is a NEW session rather than a resumed one — `--fork-session` is documented as "When resuming, create a new session ID instead of reusing the original" — so it belongs in the registration group alongside `startup`, not in a branch of its own.

Both `SessionStart` groups SHALL follow their `/sessions` ensure with one `POST /api/<slug>/sessions/<session_id>/resume`, unconditionally and without inspecting `source`. That rule is uniform across all five clients and is specified once in `plugin-session-protocol`'s lifecycle mapping; this capability records only that both of this client's ensure sites honour it.

`PreCompact` and `PostCompact` snapshot transcript/compaction-summary state as pure side effects — neither emits stdout that reaches the model. The matcher-less `UserPromptSubmit` entries emit plain-stdout lines. Full behavioural detail lives in the per-hook subsections below and in the `plugin-session-protocol` capability's lifecycle mapping, which is the authoritative table of which hook POSTs what.

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

#### Scenario: The manifest declares six event types and eight handlers

- **WHEN** `apps/plugin/hooks/hooks.json` is loaded
- **THEN** its event-type set SHALL be exactly `{SessionStart, UserPromptSubmit, SessionEnd, PreCompact, PostCompact, Stop}`
- **AND** it SHALL carry exactly eight handler entries, with NO `PostToolUse` entry
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
- **AND** the file's event-type set SHALL be exactly `{SessionStart, UserPromptSubmit, SessionEnd, PreCompact, PostCompact, Stop}` carrying exactly eight handler entries, with NO `PostToolUse` entry

## MODIFIED Requirements

### Requirement: The token budget MUST be stated per firing turn and amortised over the cadence window, in a pinned unit, and asserted in the shared fixtures

Every token figure in this capability SHALL be measured with one pinned proxy: **UTF-8 bytes ÷ 4**, over the stored fixture string and therefore EXCLUDING any trailing newline the emitting script adds. Totals for a whole turn, where a script emits several lines, SHALL include one newline per emitted line — that is the only place the newline counts. `sessionIdTemplate` is measured rendered with a 36-character UUID session id.

Two conventions have to be pinned, not one, and conflating them is what made the ambiguity load-bearing: the canonical post-compact block is 168.0 tokens counted as JS characters and **170.8** counted as UTF-8 bytes, a difference caused by multibyte punctuation. Counting its emitted trailing newline produces 171.0, so quoting that value against the character count would change two variables at once. Per-line caps below are newline-exclusive; turn totals are newline-inclusive. Raising any cap is a deliberate spec edit accompanied by a re-measurement; it is not a test adjustment.

**Always-on cost** (added to every turn while the plugin is enabled, in addition to the MCP tool listings the user already pays for):

- Four command listings (`/rembric:<name> <description>`): ≤80 tokens total.
- **Total: ≤80 tokens**, auditable via `claude plugin details rembric` against a ~100-token ceiling (80 design target plus a 20-token margin).

The plugin ships no skills, so there is no skill description and no skill body in the always-on or on-invoke budget.

**On-invoke cost**, per hook:

| Surface                                     | Cap             |
| ------------------------------------------- | --------------- |
| `SessionStart` (`startup\|resume\|clear\|fork`) | ≤30 tokens  |
| `SessionStart` (`compact`)                  | ≤175 tokens     |
| `UserPromptSubmit`, per FIRING turn         | ≤272 tokens     |
| `UserPromptSubmit`, amortised over 10 turns | ≤60 tokens/turn |
| `SessionEnd`                                | 0 tokens        |
| `PreCompact`                                | 0 tokens        |
| `PostCompact`                               | 0 tokens        |
| `Stop`                                      | 0 tokens        |

**`Stop` is now a single row at 0 tokens, and that is a strict tightening of what this table previously published.** It carried two rows — an asynchronous raw sync at 0 tokens and a synchronous reminder explicitly exempted from any fixed cap, because `plugin-session-protocol` required it to carry "the long form precisely because it has no length budget". The raw-sync entry is deleted, the reminder is composed on the server and bounded there, and the remaining `Stop` handler writes nothing a model can read. No surface in this plugin is uncapped any more.

**Two caps on this table MOVE, and the movement is the direct consequence of relocating the reminder from an uncapped channel onto a capped one.** Both new values are derived rather than chosen:

- **Per FIRING turn: 960 → 1088 bytes (240 → 272 tokens).** The worst reachable turn is the counter-divergence case this ceiling has always been set against, now with the notice in place of the retired `save`+`summary` pair: `firstPromptRelevance` (125) + recall (90) + `sessionIdTemplate` rendered (204) + the server-composed notice at its own 640-byte bound + 4 newlines = **1063 bytes**. The ceiling is 1088 for margin. For comparison, the same divergence case measures 917 bytes today.
- **Amortised over 10 turns: 180 → 240 bytes/turn (45 → 60 tokens/turn).** This cap governed `UserPromptSubmit` alone while the periodic reminder lived on the uncapped `Stop` channel, so it never counted the reminder at all. Measured before this change across ten turns of a working session, driving the real scripts: `UserPromptSubmit` emitted 1230 bytes (123/turn) and `Stop` a further 1044, for **227 bytes/turn across both channels**. Under this change, measured on the shipped fixtures by driving `prompt-search.sh` and `prompt-nudge.sh`, the same ten turns emit **556 bytes** of turn-1 lines (`firstPromptRelevance` 125 + `sessionIdTemplate` rendered 204 + `sessionOpening` 224 + 3 newlines) plus **846 per elapsed floor** (204 + the notice at its 640-byte bound + 2 newlines): **140 bytes/turn** at one floor and **225 bytes/turn** at two, both now entirely on this one channel. The cap rises to 240 to admit the two-floor case honestly rather than to hide it on a second channel.

**On a conversation where no work happens the cost falls rather than rises, and that is the change's point.** Measured today, twenty turns with no tool use at all still emit 1880 bytes across five firing turns, because `prompt-nudge.sh` never opens the transcript. Under this change the same twenty turns emit the turn-1 opening and nothing else — the notice's gate never fires without work (`session-nudges`).

**Per-line caps**, each asserted individually so a single loose aggregate cannot mask an individual violation:

| Fixture / emitted line           | Cap (bytes) | Cap (tok) | Asserted against            |
| -------------------------------- | ----------- | --------- | --------------------------- |
| `SessionStart` nudge             | 100         | 25        | `nudge-fixtures.json`       |
| recall nudge                     | 100         | 25        | `nudge-fixtures.json`       |
| `firstPromptRelevance`           | 140         | 35        | `nudge-fixtures.json`       |
| `sessionIdTemplate` (36-char id) | 224         | 56        | `nudge-fixtures.json`       |
| `sessionOpening`                 | 360         | 90        | `nudge-fixtures.json`       |
| `postCompact`                    | 700         | 175       | `nudge-fixtures.json`       |
| server-composed notice           | 640         | 160       | the emitted string, on the server |

The `save` (132) and `summary` (400) rows are removed with their fixtures: no client composes those strings any more (`plugin-session-protocol`). `endOfTurnRubric`, which deliberately had no row because its surface was uncapped, is removed with that surface.

**The server-composed notice is the first model-facing string in this plugin with no fixture, and its cap is therefore asserted elsewhere.** There is nothing to pin across languages — one implementation composes it and five clients print it — so its 640-byte bound is asserted on the server against the emitted string, including a case whose stored summary forces elision (`session-nudges`). The 640 figure is derived from the per-firing ceiling above and not chosen: 1063 − 125 − 90 − 204 − 4 leaves the notice 640.

The `sessionIdTemplate` line remains the largest single per-turn client-composed contributor (51.0 tokens) and SHALL NOT be removed to reduce the budget. It is not redundant: of `resolveActiveSessionId`'s three paths, the `SessionRouter` fallback is populated only by `memory.session_start`, which the plugin never calls because the session lifecycle is HTTP, and `findActiveForTransport` refuses by design to guess under concurrent ambiguity within its staleness window. With two host sessions open on one repository the line is the only mechanism that attaches a memory to the right session.

#### Scenario: Every fixture line has its own asserted budget

- **WHEN** the shared nudge fixtures are measured in UTF-8 bytes
- **THEN** each of `sessionOpening`, `sessionIdTemplate` (rendered with a 36-character id), `firstPromptRelevance`, the recall nudge, the `SessionStart` nudge and `postCompact` SHALL be within its cap in the table above
- **AND** each SHALL be a separate assertion, so one violation is attributable to one line
- **AND** the fixtures SHALL carry no `save`, `saveCore`, `summary`, `summaryCore` or `endOfTurnRubric` key to measure

#### Scenario: The turn-1 firing turn stays under its unchanged sub-budget

- **GIVEN** a session driven through the real per-session counter file
- **WHEN** turn 1 fires with a recall keyword in the prompt (first-prompt line, recall line, sessionId line, session opening)
- **THEN** the total emitted output SHALL be ≤800 bytes (≤200 tokens) — this sub-budget does NOT move; measured 647 bytes on the shipped fixtures, against 797 before this change

#### Scenario: The counter diverges, a notice is pending, and every line fires at once

- **GIVEN** a session where `prompt-search.sh`'s counter is at one while a server notice is cached from the previous turn
- **WHEN** that turn's prompt also carries a recall keyword
- **THEN** the total emitted output SHALL be ≤1088 bytes (≤272 tokens), and this — not turn 1 — is the case the per-firing-turn ceiling is set against

#### Scenario: The amortised budget holds over a window with two elapsed floors

- **WHEN** ten consecutive `UserPromptSubmit` turns are driven through both matcher-less entries, spanning two elapsed nudge floors with work reported in each
- **THEN** the sum of all emitted bytes divided by ten SHALL be ≤240 bytes/turn (≤60 tokens/turn)
- **AND** the `Stop` handler SHALL have contributed zero bytes to that sum

#### Scenario: A conversation with no work costs less than it does today

- **WHEN** twenty consecutive turns are driven with no tool use reported on any of them
- **THEN** the only emitted bytes SHALL be the turn-1 lines
- **AND** the total SHALL be strictly less than the 1880 bytes the same twenty turns emit before this change

#### Scenario: A side-effect hook emits nothing to the model

- **WHEN** `SessionEnd`, `PreCompact`, `PostCompact`, or `Stop` fires under Claude Code
- **THEN** the script SHALL write nothing to stdout that reaches the model

#### Scenario: Raising a cap requires a re-measurement

- **WHEN** a contributor raises any cap in this requirement
- **THEN** the change SHALL record the new measured value alongside the new cap
- **AND** the corresponding assertion SHALL be updated in the same commit

### Requirement: The plugin SHALL ship a unified `UserPromptSubmit` per-turn nudge hook

The plugin's hook catalog (`apps/plugin/hooks/hooks.json`) SHALL declare a matcher-less `UserPromptSubmit` entry — distinct from the keyword-gated recall entry (`prompt-search.sh`) — invoking `${CLAUDE_PLUGIN_ROOT}/scripts/prompt-nudge.sh`. The plugin SHALL NOT ship a `PostToolUse` save-nudge hook (`hooks.json` SHALL contain no `PostToolUse` entry).

**The script SHALL NOT decide when to remind, and SHALL NOT count turns.** Its job is to print, at the start of a turn, the lines the previous turn's report cached, plus the client-composed lines that apply to this turn. The firing decision belongs to the server (`session-nudges`).

- The entry SHALL declare NO matcher, so it fires on every user prompt. Claude Code supports multiple entries per hook event, so this coexists with the recall entry.
- The script SHALL read `session_id` from hook stdin and read-and-clear the pending-lines cache for that session under `${TMPDIR:-/tmp}/rembric-pending/<sanitized-session-id>`, so a cached notice is printed exactly once.
- On the session's FIRST prompt it SHALL additionally record that prompt, truncated to 100 characters and routed through `rembric_redact_private`, for `stop-report.sh` to send as the provisional title on its first report.
- It SHALL emit, as PLAIN text on stdout (NOT a `hookSpecificOutput` JSON object — plain stdout is the documented `UserPromptSubmit` injection shape): the sessionId line when any write-directing line will follow (`plugin-session-protocol`); the session opening when the ensure reported a newly created session and it has not yet been emitted; and then the cached server lines verbatim.
- **The cached lines SHALL be emitted VERBATIM.** The script SHALL NOT prefix, wrap, truncate, reorder or reformat them. `rembric:`-prefixing is the SERVER's responsibility for this text, so that Codex's `looks_like_json` heuristic sees the same shape on both clients from one source.
- The script SHALL make NO network call and needs no `REMBRIC_SERVER_URL`/`REMBRIC_API_TOKEN`. The request that produced the lines was made by `stop-report.sh` on the previous turn.
- The script SHALL fail safe: unreadable or empty stdin, an unreadable cache file, or any other error SHALL exit `0` and emit nothing.
- **Turns on which nothing is cached and no local line applies SHALL emit ZERO bytes**, which is the majority of turns in a working session and every turn of a conversation-only one.

#### Scenario: A cached notice is printed once, verbatim

- **GIVEN** a pending-lines cache holding two lines written by the previous turn's report
- **WHEN** `UserPromptSubmit` fires
- **THEN** `prompt-nudge.sh` SHALL emit the sessionId line followed by those two lines, byte-for-byte as cached
- **AND** the cache SHALL be cleared, so the next `UserPromptSubmit` emits neither

#### Scenario: The script counts nothing

- **WHEN** `apps/plugin/scripts/prompt-nudge.sh` is read at HEAD
- **THEN** it SHALL contain no modulo operation, no cadence constant and no call to a turn counter
- **AND** `${TMPDIR:-/tmp}/rembric-turnnudge/` SHALL NOT be referenced anywhere in the plugin tree

#### Scenario: The session opening fires on turn 1 of a new session only

- **WHEN** `UserPromptSubmit` fires for the 1st time in a session the ensure reported as `created: true`
- **THEN** `prompt-nudge.sh` SHALL emit the session-opening line
- **AND** it SHALL NOT emit it on any later turn, nor on turn 1 of a session reported `created: false`

#### Scenario: An empty cache emits nothing at all

- **WHEN** `UserPromptSubmit` fires on a turn with no cached lines, no opening due and no recall match
- **THEN** `prompt-nudge.sh` SHALL emit zero bytes

#### Scenario: No PostToolUse save-nudge hook exists

- **WHEN** `apps/plugin/hooks/hooks.json` is inspected
- **THEN** it SHALL contain no `PostToolUse` entry emitting a `memory.save` reminder
- **AND** `apps/plugin/scripts/post-tool.sh` SHALL NOT exist

#### Scenario: Fail-safe on unreadable stdin

- **WHEN** `UserPromptSubmit` fires and stdin is empty or unparseable
- **THEN** `prompt-nudge.sh` SHALL exit 0 and emit nothing that breaks the host

### Requirement: The plugin SHALL ship a thin curl helper at `${CLAUDE_PLUGIN_ROOT}/scripts/_api.sh`

To keep `session-start.sh`, `post-compact.sh`, `session-end.sh`, `pre-compact.sh`, `post-compaction.sh`, `prompt-search.sh`, `prompt-nudge.sh` and `stop-report.sh` minimal and consistent, the plugin SHALL ship a shared helper at `apps/plugin/scripts/_api.sh` that:

- Resolves `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` from the environment.
- Exposes `rembric_parse_dotenv`, which parses `${cwd}/.rembric` for `PROJECT_SLUG` (reusing the same dotenv parser logic as the bridge). The parser SHALL trim BOTH leading and trailing whitespace from each value before quote-stripping — trailing whitespace SHALL NOT be left in the parsed value, and this trim SHALL also strip a trailing carriage return, so a `.rembric` file saved with CRLF line endings resolves to the same slug the JS bridge (`bin/rembric-dotenv.mjs`, which trims both sides) resolves.
- Exposes `rembric_read_project_slug <cwd>`, the wrapper every hook script actually calls to go from a working directory to a validated slug.
- Exposes `rembric_post <path> <json-body>`, which issues `curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --max-time "${REMBRIC_POST_MAX_TIME:-3}" -d "$body" -w '\n%{http_code}' "$URL"`. The budget SHALL be overridable through `REMBRIC_POST_MAX_TIME` and SHALL default to `3` when unset, so a caller running under a host-imposed budget tighter than 3 seconds can fit the request inside it. Codex's `SessionEnd` is the case that forces this: the host allows that one event 1 second by default and 3 seconds at most, against 600 for every other hook, so a fixed 3-second POST consumes the entire budget and leaves nothing for the transcript read or the failure diagnostic (`codex-distribution`). A caller SHALL set the variable only where a tighter budget applies; every other script inherits the default and SHALL NOT restate it. It SHALL use `-s` and NOT `-f`: the status code is captured via `-w` and split off the response, so that a non-2xx response can be reported with its body in the stderr diagnostic required by `plugin-session-protocol`'s failed-POST requirement. `-f` would suppress exactly that body. An empty body argument SHALL be normalised to `{}`.
- Exposes `rembric_turn_report <path> <json-body>`, the ONE function in this file besides `rembric_session_ensure` that reads a response body. It SHALL echo the response's `lines` array as one newline-separated block, or nothing on failure, on a non-2xx status, or when the array is empty. Keeping it separate from `rembric_post` is what stops the body-reading capability from later being pointed at a `/summary` response, which `plugin-session-protocol` forbids.
- Exposes `rembric_pending_write <session-id> <text>` and `rembric_pending_take <session-id>`, a per-session line cache under `${TMPDIR:-/tmp}/rembric-pending/`. `_take` SHALL print and remove in one step, so a notice is printed exactly once. `_write` SHALL NOT overwrite a non-empty cache with an empty value — a second report within one turn would otherwise swallow a pending notice.
- Exposes `rembric_scan_offset <session-id>` and `rembric_scan_offset_set <session-id> <bytes>`, a per-session byte offset under `${TMPDIR:-/tmp}/rembric-scan/` recording how much of the host transcript the previous report consumed.
- Exposes `rembric_turn_count <counter-name> <session-id>`, an atomic per-session turn counter, whose sole remaining caller is `prompt-search.sh` with the counter name `rembric-relevance-prefetch`. It SHALL append one byte and count the file's bytes rather than read-increment-write, because a single `O_APPEND` write is atomic across concurrent invocations. It SHALL echo the new count, or NOTHING when the counter is unreadable — callers MUST treat empty as fail-closed, since defaulting to `0` satisfies every equality check at once. `rembric_turn_count_peek` is removed with its only caller.
- Exposes `rembric_json_escape <string>` that escapes for embedding in a JSON value: backslash, double quote, and every control character in the range U+0000–U+001F. `\n`, `\r`, and `\t` SHALL use their short escape forms; every other character in that range (e.g. an ANSI escape from pasted colored terminal output) SHALL be escaped as `\u00XX` so the output is always valid JSON. Characters at or above U+0020 (including `\x7f`/DEL, which JSON does not require escaping) SHALL be left untouched.
- Exposes stdin-field extractors `rembric_session_id_from_stdin_json`, `rembric_cwd_from_stdin_json`, `rembric_transcript_path_from_stdin_json`, `rembric_prompt_from_stdin_json`, `rembric_stop_hook_active_from_stdin_json` and `rembric_compaction_summary_from_stdin_json`. The compaction-summary extractor SHALL prefer `compaction_summary` and SHALL fall back to `compactionSummary` (in case Codex uses camelCase, per the same precedent that `session_id`/`sessionId` already follows).
- Returns `0` even on failure (so callers can `|| true` safely). `rembric_post` discards the response body from stdout; it does NOT suppress the stderr diagnostic.

The sibling helper `apps/plugin/scripts/_transcript.sh` exposes `rembric_format_transcript_claude_code`, `rembric_extract_first_assistant_claude_code`, `rembric_format_transcript_codex_cli`, `rembric_extract_first_assistant_codex_cli`, the deterministic fact extractor, and `rembric_redact_private` — the mandatory client-side redaction choke point specified by `plugin-session-protocol`'s `<private>`-span requirement. **Every one of those functions is retained; only their call sites move.** The fact extractor's caller becomes `session-end.sh` (`sessions`), and no per-turn script calls it. `post-compaction.sh` routes the compaction summary through `rembric_redact_private` because the compactor quotes conversation content verbatim, making that payload transcript-derived. Any new script sending transcript-derived text SHALL route it through the same function — including the provisional title `prompt-nudge.sh` records for `stop-report.sh`.

`pre-compact.sh <agent>` SHALL detect the agent from `$1` (the same convention `session-start.sh` and `stop-report.sh` use, defaulting to `$REMBRIC_AGENT` then `claude-code`) and dispatch to the matching per-client transcript variants. There is no per-client copy of the script.

Each hook script SHALL `source` `_api.sh` (and `_transcript.sh` where transcript handling is needed) and SHALL NOT inline the curl invocation or transcript parsing directly. The helpers SHALL respect the same "exit 0 on error" discipline as the existing scripts.

#### Scenario: New helpers are sourced by the new scripts

- **WHEN** `pre-compact.sh`, `post-compaction.sh` or `stop-report.sh` are read
- **THEN** each SHALL start with `source "${SCRIPT_DIR}/_api.sh"` (where `SCRIPT_DIR` is the script's own directory)
- **AND** each that handles transcripts SHALL also `source "${SCRIPT_DIR}/_transcript.sh"`
- **AND** none SHALL inline a literal `curl` invocation outside the helper

#### Scenario: The POST budget is overridable and defaults to 3

- **GIVEN** `REMBRIC_POST_MAX_TIME` is unset
- **WHEN** `rembric_post` runs
- **THEN** the curl invocation SHALL carry `--max-time 3`
- **AND** when the variable is set to `2`, the same invocation SHALL carry `--max-time 2`
- **AND** the value SHALL be read at call time, so a per-hook override in a manifest's `command` string takes effect

#### Scenario: rembric_post reports a non-2xx with its body

- **GIVEN** the server responds `401` with a JSON error body
- **WHEN** `rembric_post` is called
- **THEN** it SHALL emit one stderr line naming the path, the curl return code, the HTTP status and the response body
- **AND** it SHALL return `0` so the calling hook still exits `0`

#### Scenario: rembric_turn_report echoes lines only on success

- **GIVEN** the server responds `200` with `{"ok":true,"sessionId":"S","lines":["a","b"]}`
- **WHEN** `rembric_turn_report` is called
- **THEN** it SHALL echo exactly `a\nb`
- **AND** on a `404`, a timeout, or `"lines":[]` it SHALL echo nothing and still return `0`

#### Scenario: The pending cache is take-once and never emptied by a second report

- **GIVEN** `rembric_pending_write S "notice"` has run
- **WHEN** `rembric_pending_write S ""` runs and then `rembric_pending_take S`
- **THEN** `rembric_pending_take` SHALL print `notice`
- **AND** a second `rembric_pending_take S` SHALL print nothing

#### Scenario: rembric_turn_count fails closed when unreadable

- **GIVEN** the counter directory cannot be created or the counter file cannot be read back
- **WHEN** `rembric_turn_count` is called
- **THEN** it SHALL echo nothing
- **AND** the caller SHALL treat the empty value as "do not fire", never as `0`

#### Scenario: pre-compact.sh dispatches on its agent argument

- **WHEN** `pre-compact.sh codex-cli` runs against a Codex transcript
- **THEN** it SHALL use `rembric_format_transcript_codex_cli` and `rembric_extract_first_assistant_codex_cli`
- **WHEN** `pre-compact.sh` runs with no argument or with `claude-code`
- **THEN** it SHALL use the `_claude_code` variants

#### Scenario: post-compaction redacts before POSTing

- **GIVEN** stdin whose `compaction_summary` contains a `<private>…</private>` span
- **WHEN** `post-compaction.sh` runs
- **THEN** the POSTed body SHALL contain `[REDACTED]` in place of the span and SHALL NOT contain the original span

#### Scenario: The provisional title is redacted before it leaves the client

- **GIVEN** a first user prompt containing a `<private>…</private>` span
- **WHEN** `stop-report.sh` sends its first report
- **THEN** the `title` field SHALL contain `[REDACTED]` in place of the span

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
- **THEN** the output SHALL contain the escape sequence in place of the raw byte
- **AND** embedding the output as a JSON string value and parsing it back SHALL reproduce the original byte exactly

### Requirement: The plugin MUST NOT implement migration or coexistence behaviors with other agent memory systems

This capability SHALL NOT specify migration prompts, import flows, side-by-side coexistence rules, or compatibility shims with other agent memory systems. Rembric is positioned as the sole memory layer for any agent it is enabled on; the plugin's hook scripts, MCP bridge, command catalogue, and any server-delivered protocol guidance SHALL be authored under the assumption that no second memory system is active on the same agent. Operators with another memory tool installed SHALL be guided (via the plugin's README) to uninstall it before enabling this plugin, but the plugin itself SHALL NOT attempt detection, warning, or graceful coexistence with such tools.

**The prohibition covers server-composed model-facing text as well.** The stretch-close notice (`session-nudges`) is emitted by the server and printed by every client, so it is protocol guidance within the meaning of this requirement and SHALL be authored under the same assumption.

#### Scenario: Plugin hook scripts do not check for or interoperate with other memory systems

- **WHEN** the plugin's hook scripts (`session-start.sh`, `post-compact.sh`, `session-end.sh`, `pre-compact.sh`, `post-compaction.sh`, `prompt-search.sh`, `prompt-nudge.sh`, `stop-report.sh`) and the published MCP bridge (`apps/plugin/mcp-bridge/`) are inspected
- **THEN** none SHALL contain logic that detects, warns about, defers to, or imports state from any agent memory tool other than Rembric
- **AND** none SHALL name a specific third-party memory tool in their output, comments, or stderr diagnostics

#### Scenario: Protocol guidance does not instruct the agent to migrate from or compare with other memory systems

- **WHEN** the protocol guidance the agent receives is read — server-side via the MCP `initialize.instructions` handshake (`apps/server/src/mcp/instructions.ts`) and the server-composed stretch-close notice, and client-side via the command bodies under `apps/plugin/commands/` and the hook-emitted lines
- **THEN** none SHALL direct the agent to import from, deduplicate against, prefer Rembric over, or otherwise reason about parallel memory tools
- **AND** each SHALL describe Rembric's memory protocol on its own terms, without comparison to other agent memory systems

#### Scenario: README warns about parallel installations without naming alternatives

- **WHEN** the plugin README is rendered (e.g. on GitHub)
- **THEN** the operator guidance about parallel-tool drift SHALL state that this plugin is the sole memory layer and SHALL warn against having another memory tool installed
- **AND** the guidance SHALL NOT name any specific third-party memory tool by name
