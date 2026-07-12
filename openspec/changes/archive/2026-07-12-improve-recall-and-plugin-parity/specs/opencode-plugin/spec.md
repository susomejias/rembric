## MODIFIED Requirements

### Requirement: Event handler set

The plugin module's returned object SHALL declare exactly the following event handler properties, no more and no fewer:

1. `event: async ({ event }) => ...` — a dispatcher that switches on `event.type` for `"session.created"`, `"session.deleted"`, `"server.instance.disposed"`, `"message.updated"`, and `"session.idle"`. Any other `event.type` values SHALL be silently ignored. `"message.updated"` and `"session.idle"` are dispatched here — NOT as separate top-level `Hooks` object keys — because neither name is a valid top-level `Hooks` key in the opencode plugin API; both are members of the `Event` union delivered exclusively through this dispatcher.
2. `"chat.message": async (input, output) => ...` — appends a `{role:'user', text}` entry to the per-session transcript accumulator (`sessionMessages` Map). The handler SHALL NOT POST any HTTP request.
3. `"experimental.session.compacting": async (input, output) => ...` — post-compaction reminder injection.

The plugin SHALL NOT register `"tool.execute.after"`. The corresponding `/api/<slug>/observations/passive` endpoint does not exist on Rembric's HTTP API; the handler has no work to do.

The plugin SHALL NOT register `experimental.chat.system.transform` (no system-prompt injection). The plugin SHALL NOT register `tool.execute.before` (no tool guards). The plugin SHALL NOT register `permission.asked` or `permission.replied`.

If Plan B of the cwd spike applies (see "cwd spike" requirement), the plugin SHALL additionally register `"shell.env": async (input, output) => { output.env.REMBRIC_PROJECT_DIR = ctx.directory }`. The hook SHALL be omitted otherwise.

The `chat.message` handler and the `event` dispatcher's `message.updated`/`session.idle` branches MUST treat the `sessionMessages` Map (and, for `session.idle`, the debounce-timer map) as their only side effects beyond the deliberate HTTP POST each performs. An invariant test (`apps/server/src/test/invariants.test.ts`) SHALL fail the build if the `chat.message` handler invokes `rembricPost`, `fetch`, or any other HTTP work (the `event` dispatcher's `message.updated` and `session.idle` branches are exempted from this specific invariant since `session.idle`'s HTTP POST is the intended primary flush mechanism — see "Session.idle handler (periodic flush)").

#### Scenario: Handler set is exactly the documented set

- **WHEN** the resolved value of `RembricPlugin(ctx)` is inspected
- **THEN** its own enumerable keys are exactly `["event", "chat.message", "experimental.session.compacting"]` plus `"shell.env"` if Plan B is active
- **AND** no other keys exist — in particular, `"message.updated"` and `"session.idle"` SHALL NOT appear as top-level keys

#### Scenario: message.updated and session.idle events reach the event dispatcher

- **WHEN** opencode emits an event of type `"message.updated"` or `"session.idle"`
- **THEN** the plugin's `event` hook SHALL receive it (since neither has its own top-level `Hooks` key) and route it to the corresponding branch described in "Message.updated handler accumulates assistant transcript" and "Session.idle handler (periodic flush)"

### Requirement: Message.updated handler accumulates assistant transcript

The `event` dispatcher's `"message.updated"` branch SHALL:

1. Return immediately if `input.sessionID` is in `subAgentSessions`.
2. Return immediately if `output.message.role !== 'assistant'`. The branch is a no-op for user messages (which are captured by `chat.message`) and any other roles.
3. Extract text from `output.message.parts` filtering text parts. Apply the same `stripPrivateTags` and truncate-to-2000 transforms as `chat.message`.
4. If the resulting text is empty, return.
5. Search `sessionMessages.get(input.sessionID)` for an existing entry whose `id` field equals `output.message.id`. If found, REPLACE its `text` (preserving the entry's position in the array). If not found, APPEND `{role:'assistant', text, id:<output.message.id>}` to the array.

The branch MUST be idempotent under streaming token updates: opencode may fire `message.updated` many times per assistant turn (token-by-token streaming). The id-keyed replacement ensures only one final-state entry per assistant message in the accumulator.

The 200-entry cap from `chat.message` applies here too — when appending a new assistant entry causes the array to exceed 200, the oldest entry is FIFO-evicted.

#### Scenario: Assistant text is appended on first sight, replaced on subsequent updates

- **GIVEN** `sessionMessages.get("s1")` is `[]`
- **WHEN** the `event` dispatcher receives `message.updated` with `output.message.id="m1"`, `role="assistant"`, accumulating parts that resolve to text `"Hello,"`
- **THEN** `sessionMessages.get("s1")` is `[{role:'assistant', text:'Hello,', id:'m1'}]`
- **WHEN** the dispatcher receives `message.updated` again with the SAME `output.message.id="m1"` and longer text `"Hello, working on it."`
- **THEN** the entry's text is replaced; the array length stays at 1; the entry's position is unchanged
- **WHEN** the dispatcher receives `message.updated` with a different `output.message.id="m2"`, text `"Done."`
- **THEN** `sessionMessages.get("s1")` is `[{role:'assistant', text:'Hello, working on it.', id:'m1'}, {role:'assistant', text:'Done.', id:'m2'}]`

#### Scenario: Non-assistant roles are ignored

- **WHEN** the `event` dispatcher receives `message.updated` with `output.message.role="user"` or `"system"` or `"tool"`
- **THEN** the branch returns without mutating `sessionMessages`

### Requirement: Session.idle handler (periodic flush)

The `event` dispatcher's `"session.idle"` branch is the PRIMARY mechanism that delivers the transcript to the server during the session lifetime. It fires once per agent turn (after the assistant response completes and before the next user prompt). The branch SHALL:

1. Return immediately if `input.sessionID` is in `subAgentSessions`.
2. Schedule a debounced flush for `input.sessionID` with a 500ms quiet period. If a prior debounce-timer is pending for the same session id, cancel it and schedule afresh. Implementation note: use `setTimeout` / `clearTimeout` plus a `Map<string, ReturnType<typeof setTimeout>>` to track per-session pending timers.
3. The debounced flush callback SHALL call `flushSessionSummary(sessionId)` (the shared helper used by `server.instance.disposed`), which POSTs `/api/<slug>/sessions/<id>/summary` with body `{summary, title?, final:false}`.

Rationale: opencode's `server.instance.disposed` is fire-and-forget at the runtime level (verified by spike — see design.md::Decision 4 resolved). Async POSTs from that handler don't land. The per-turn flush keeps the server's summary current at all times so that even if `server.instance.disposed` fails to deliver, the row is at-most-one-turn behind reality.

The debounce SHALL NOT exceed 2 seconds (don't accumulate too much state in-flight) and SHALL NOT be below 200ms (don't POST on every keystroke during streaming).

#### Scenario: session.idle fires periodic flush per turn

- **GIVEN** a session "s1" with three user prompts each followed by an assistant response, accumulator contains user+assistant turns
- **WHEN** the `event` dispatcher receives `session.idle` after the third assistant turn
- **THEN** within 500ms a POST to `/api/<slug>/sessions/s1/summary` is issued
- **AND** the body's `summary` contains all six turns

#### Scenario: Rapid-fire session.idle events debounce

- **GIVEN** the `event` dispatcher receives `session.idle` three times within 100ms for the same session id
- **WHEN** the debounce timer expires
- **THEN** exactly ONE POST is issued (the prior timers were cancelled)
