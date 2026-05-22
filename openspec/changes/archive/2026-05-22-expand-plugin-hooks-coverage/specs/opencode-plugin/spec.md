## MODIFIED Requirements

### Requirement: Event handler set

The plugin module's returned object SHALL declare exactly the following event handler properties, no more and no fewer:

1. `event: async ({ event }) => ...` — a dispatcher that switches on `event.type` for `"session.created"`, `"session.deleted"`, `"server.instance.disposed"`, AND `"session.compacted"`. Any other `event.type` values SHALL be silently ignored. (Adds `session.compacted` to the previously documented three.)
2. `"chat.message": async (input, output) => ...` — appends a `{role:'user', text}` entry to the per-session transcript accumulator (`sessionMessages` Map) AND, when the user text matches the recall regex `/remember|recall|acordate|qué hicimos|what did we do/i`, appends a recall-nudge entry to `output.parts`. The handler SHALL NOT POST any HTTP request from either branch.
3. `"message.updated": async (input, output) => ...` — appends or replaces a `{role:'assistant', text}` entry keyed by `output.message.id` in `sessionMessages`. The handler SHALL NOT POST any HTTP request, and SHALL be a no-op for messages whose role is not `'assistant'`.
4. `"session.idle": async (input) => ...` — schedules a debounced summary flush for `input.sessionID`. PRIMARY mechanism for delivering transcript-to-server during the session. See `Session.idle handler (periodic flush)`.
5. `"experimental.session.compacting": async (input, output) => ...` — post-compaction reminder injection (with the `memory.context` clause added — see modified requirement below).

The plugin SHALL NOT register `"tool.execute.after"`. The corresponding `/api/<slug>/observations/passive` endpoint does not exist on Rembric's HTTP API; the handler has no work to do.

The plugin SHALL NOT register `experimental.chat.system.transform` (no system-prompt injection). The plugin SHALL NOT register `tool.execute.before` (no tool guards). The plugin SHALL NOT register `permission.asked` or `permission.replied`.

If Plan B of the cwd spike applies (see "cwd spike" requirement), the plugin SHALL additionally register `"shell.env": async (input, output) => { output.env.REMBRIC_PROJECT_DIR = ctx.directory }`. The hook SHALL be omitted otherwise.

The `chat.message` and `message.updated` handlers MUST treat the `sessionMessages` Map as their only state side effect — appending to `output.parts` in `chat.message` is permitted but is also non-HTTP. An invariant test (`apps/server/src/test/invariants.test.ts`) SHALL fail the build if either handler invokes `rembricPost`, `fetch`, or any other HTTP work.

#### Scenario: Handler set is exactly the documented set

- **WHEN** the resolved value of `RembricPlugin(ctx)` is inspected
- **THEN** its own enumerable keys are exactly `["event", "chat.message", "message.updated", "session.idle", "experimental.session.compacting"]` plus `"shell.env"` if Plan B is active
- **AND** no other keys exist

#### Scenario: event dispatcher handles session.compacted

- **WHEN** opencode fires `event.type === "session.compacted"` with `event.properties.sessionID = "s1"` (or equivalent payload — verified at implementation time against opencode's event schema)
- **THEN** the dispatcher's branch SHALL extract the session id
- **AND** SHALL await `flushSessionSummary(sessionId)` (reusing the same helper used by `session.idle`)
- **AND** SHALL skip the call if the id is in `subAgentSessions` or absent from `knownSessions`
- **AND** SHALL emit one stderr diagnostic of the form `[rembric] session.compacted sessionId=<id>` for observability paridad with the existing diagnostic discipline

## ADDED Requirements

### Requirement: Session.compacted handler flushes the accumulator at the compaction milestone

The `event` dispatcher SHALL handle `event.type === "session.compacted"` as the third opencode event (alongside `session.idle` and `server.instance.disposed`) that triggers a summary flush. Its purpose is to persist the rolling transcript at the moment opencode signals a compaction has completed.

The handler SHALL:

1. Extract the session id from `event.properties.sessionID` (or `event.properties.info.id` as a fallback, mirroring the existing `session.created` extraction pattern). If the id is empty, the handler SHALL return.
2. Skip if the id is in `subAgentSessions`. Skip if the id is NOT in `knownSessions` (we only flush sessions whose row was already registered).
3. Emit one stderr diagnostic of the form `[rembric] session.compacted sessionId=<id>`.
4. Await `flushSessionSummary(sessionId)` — the same helper used by `session.idle`. This builds the body via `buildSummaryBody(sessionId)` (joining the accumulator entries as `<role>: <text>` lines, truncating from the head at 19500 chars) and POSTs to `/api/<slug>/sessions/<id>/summary` with `final:false`.

The handler SHALL NOT reset, clear, or otherwise mutate `sessionMessages` for the affected session id. opencode's `session.compacted` is a notification event, not a content-delivery event — the in-memory accumulator persists across the compaction, so subsequent `session.idle` events MAY continue to flush a transcript that includes both pre-compact and post-compact turns.

opencode's `session.compacted` event does NOT deliver the model-authored compaction summary payload. The handler SHALL NOT attempt to extract one from the event. The PRIMARY signal we persist at this milestone is the in-memory accumulator's rolling transcript — the same content that `session.idle` would flush, just triggered by the explicit compaction event for milestone clarity.

#### Scenario: session.compacted flushes for a known top-level session

- **GIVEN** `knownSessions` contains `"s1"`, `sessionMessages.get("s1")` contains turns
- **WHEN** the dispatcher receives an event with `type === "session.compacted"` and a sessionID resolving to `"s1"`
- **THEN** the handler SHALL emit one stderr diagnostic naming the id
- **AND** SHALL await `flushSessionSummary("s1")` exactly once
- **AND** SHALL NOT mutate `sessionMessages.get("s1")`

#### Scenario: session.compacted is a no-op for sub-agent sessions

- **GIVEN** `subAgentSessions` contains `"sub-1"`
- **WHEN** the dispatcher receives a session.compacted event for `"sub-1"`
- **THEN** the handler SHALL NOT call `flushSessionSummary`
- **AND** SHALL NOT emit the standard diagnostic (the sub-agent skip is silent, matching the existing pattern for sub-agent filtering in other handlers)

#### Scenario: session.compacted is a no-op for unknown sessions

- **GIVEN** `knownSessions` does NOT contain `"s99"`
- **WHEN** the dispatcher receives a session.compacted event for `"s99"`
- **THEN** the handler SHALL NOT call `flushSessionSummary` (we only flush sessions whose row was previously registered)

## MODIFIED Requirements

### Requirement: Chat.message handler accumulates user transcript

The `"chat.message"` handler SHALL:

1. Return immediately if `input.sessionID` is in `subAgentSessions`.
2. Extract text from `output.parts` filtering `part.type === "text"`, joining with newlines, and trimming. If empty, fall back to `output.message.summary.title + "\n" + output.message.summary.body` if available.
3. If the resulting text is empty, return without mutating state.
4. Otherwise append `{role: 'user', text: <stripped+truncated>}` to `sessionMessages.get(input.sessionID)` (creating the array if it does not exist).
5. The handler SHALL pass the text through a `stripPrivateTags` helper that replaces `<private>...</private>` blocks (case-insensitive, multiline) with `[REDACTED]`. The handler SHALL truncate each entry to 2000 characters with a `"..."` suffix if longer.
6. The accumulator MUST cap each session's array at 200 entries. If the array reaches the cap, the oldest entry is shifted out (FIFO) before the new entry is appended. This protects against unbounded memory growth in long sessions.
7. **Recall nudge (new):** AFTER appending to the accumulator, the handler SHALL test the un-truncated user text against the case-insensitive regex `/remember|recall|acordate|qué hicimos|what did we do/i`. When the regex matches, the handler SHALL append `{type: "text", text: "rembric: User intent: recall. Call memory.search with the user keywords before responding."}` to `output.parts`. The appended nudge string SHALL be byte-identical to the stdout emitted by `apps/plugin/scripts/prompt-search.sh` (the shared `UserPromptSubmit` regex hook used by Claude Code and Codex CLI), preserving cross-client paridad.

The handler SHALL NOT POST any HTTP request from either the accumulator branch or the recall-nudge branch. The accumulated data flows out only via the `session.idle`, `session.compacted`, and `server.instance.disposed` flush paths.

The recall regex SHALL NOT be evaluated against sub-agent sessions (rule 1's early return covers this — the regex check happens AFTER the sub-agent skip).

#### Scenario: User text accumulates

(Unchanged from the prior spec.)

#### Scenario: Private tags are redacted before accumulation

(Unchanged from the prior spec.)

#### Scenario: Sub-agent prompts are skipped

(Unchanged from the prior spec.)

#### Scenario: Accumulator caps at 200 entries

(Unchanged from the prior spec.)

#### Scenario: Recall regex matches inject a nudge into output.parts

- **GIVEN** a top-level session "s1"
- **WHEN** `chat.message` fires with user text containing `"acordate cuando hicimos la auth?"`
- **THEN** the handler SHALL append the user text to `sessionMessages.get("s1")` as usual
- **AND** SHALL also append `{type: "text", text: "rembric: User intent: recall. Call memory.search with the user keywords before responding."}` to `output.parts`
- **AND** SHALL NOT POST any HTTP request

#### Scenario: Recall regex does NOT match — no nudge appended

- **WHEN** `chat.message` fires with user text `"please write a unit test for src/auth.ts"`
- **THEN** the handler SHALL append the user text to `sessionMessages.get("s1")`
- **AND** SHALL NOT append any new entry to `output.parts`

#### Scenario: Recall regex is case-insensitive and matches multiple keywords

- **WHEN** `chat.message` fires with user text `"What did we do yesterday?"`, `"Remember the bug we fixed"`, or `"qué hicimos con la migración?"`
- **THEN** in all three cases the handler SHALL append the recall nudge to `output.parts`

#### Scenario: Recall regex check applies AFTER private-tag stripping

- **WHEN** `chat.message` fires with user text `"<private>recall</private> nothing here"`
- **THEN** the accumulator receives `"[REDACTED] nothing here"` (private tags redacted)
- **AND** the regex SHALL be evaluated against the ORIGINAL un-redacted text (so `recall` still triggers the nudge) — rationale: the user's intent to recall is private content but the agent should still receive the nudge to act on it

## MODIFIED Requirements

### Requirement: Experimental.session.compacting handler

The `"experimental.session.compacting"` handler SHALL:

1. If `input.sessionID` is present, call `ensureSession(input.sessionID)`.
2. Push a single string onto `output.context` (the array opencode's compactor consumes) instructing the compactor that the next agent MUST call `memory.session_summary` immediately with the compacted summary content, preserving what was done before compaction. The instruction text SHALL be a single multi-line string ending with a sentence stating that without this step everything before compaction is lost from memory. The text SHALL name the project slug when one was resolved. **The text SHALL ALSO include a final sentence directing the post-compact agent to call `memory.context` if it needs detail beyond the compact summary (file paths, decisions, specific errors not in the compacted block).**

The handler SHALL NOT mutate `input.context` or `input.messages` directly. All effects SHALL be expressed as appends to `output.context`.

The handler SHALL NOT GET any `/context` or recall-context endpoint in v1 — no such endpoint exists on the HTTP API today. When the corresponding endpoint ships in a future OpenSpec change, the handler MAY be extended to prepend a server-returned recall block before the reminder; that prepend SHALL fail silently on any error and the reminder string (including the memory.context guidance) SHALL remain the last (always-present) entry.

#### Scenario: Reminder includes memory.session_summary AND memory.context guidance

- **WHEN** `experimental.session.compacting` fires with a valid `input.sessionID`
- **THEN** `ensureSession` runs (POST `/api/<slug>/sessions` once)
- **AND** exactly ONE string is pushed to `output.context`
- **AND** that string contains the substring `memory.session_summary`
- **AND** that string contains the substring `memory.context` (new requirement — the post-compact recovery path)
- **AND** that string contains the project slug when one was resolved from `.rembric`

#### Scenario: Compacting fires without sessionID

(Unchanged from the prior spec.)
