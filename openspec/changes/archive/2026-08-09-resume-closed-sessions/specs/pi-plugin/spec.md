## MODIFIED Requirements

### Requirement: The shutdown reason decides whether the session is ended

`session_shutdown` is not a process-death signal. The harness declares `SessionShutdownEvent { type: "session_shutdown"; reason: "quit" | "reload" | "new" | "resume" | "fork"; targetSessionFile?: string }` (`dist/core/extensions/types.d.ts:462-468` of `@earendil-works/pi-coding-agent@0.84.1`), documented as "Fired before an extension runtime is torn down due to quit, reload, or session replacement", and four of the five reasons are session replacement inside a surviving process.

The extension SHALL issue the session end **only** when `reason` is a member of the explicit end-set `{quit, new, resume, fork}`. On `reload` it SHALL NOT end the session, because `reload` is the same session continuing. An end issued on a surviving session costs `session_id = NULL` on every later `memory.save` and `session_not_found` from `memory.session_summary` until the next `before_agent_start` ensure-and-resume repairs it, and there is no reason to incur a repairable fault when the correct branch is free. The existence of the resume path SHALL NOT be treated as making a wrong end cheap: within a single agent turn nothing re-runs `before_agent_start`, so the writes made between the wrong end and the next turn are lost to `session_id = NULL` and are not recoverable afterwards.

The extension SHALL NOT branch its resume on `reason`, `session_start`, or any other host signal; it SHALL issue exactly one `POST /api/<slug>/sessions/<id>/resume` after the FIRST `/sessions` ensure for that id in the process, which for this client is the shared core's registration entry point called from `before_agent_start` (`plugin-session-protocol`). Conditioning on a signal is not merely unnecessary here, it is unavailable: Pi's cold-start resume is reported as `reason: "startup"` on the `session_start` event — the harness substitutes `{ type: "session_start", reason: "startup" }` when no explicit event is supplied (`dist/core/agent-session.js:152` of `@earendil-works/pi-coding-agent@0.84.1`, reached from `dist/main.js:569-570` where the initial runtime passes `sessionStartEvent: undefined`) — so `pi -r`, `pi -c` and `pi --session <file>` are indistinguishable from a clean start, and `getEntries()` does not separate them either, since a persisted header-only session file yields zero entries exactly as a new session does.

The earlier prohibition on this mapping rested on a conflation that SHALL NOT be reintroduced: resuming on `startup` would revive "an unrelated terminal row" only if the row were selected by a heuristic. It is not. The resume names the id the ensure immediately before it named, and that id comes from the session file header Pi itself read (`SessionManager` sets `this.sessionId = header?.id ?? createSessionId()`, `dist/core/session-manager.js:632`), so the target is always the conversation the host is actually running. Pi's stable id is what makes this client the one where the whole loop is demonstrable end to end: `CLOSING_SHUTDOWN_REASONS` includes `quit`, so a quit genuinely ends the row, and the next `pi -r` of that conversation genuinely returns it to `active`.

The gate SHALL be expressed as membership in the end-set, NOT as an exclusion of `reload`. The two are equivalent for the five reasons that exist and diverge the moment the harness adds a sixth: exclusion would end on an unknown reason, membership does not. A `reason` that is absent, empty, or not a member of the end-set SHALL therefore NOT end the session. The extension's local type declaration for the event SHALL type `reason` as an optional string rather than the harness's five-member union, so the non-member branch remains reachable instead of being typed out of existence.

The extension SHALL additionally suppress the end when the shutdown is a replacement by the session it already holds. Resuming the currently-open session emits `reason: "resume"` and returns the SAME session id (`dist/core/session-manager.js:632`, `this.sessionId = header?.id ?? createSessionId()`, which reads the id from the resumed file's header), so the reason alone does not distinguish replacement-by-another from replacement-by-itself. The suppression SHALL compare `event.targetSessionFile` against `ctx.sessionManager.getSessionFile()` **only when `targetSessionFile` is a non-empty string**. A bare inequality comparison SHALL NOT be used: on `quit` the field is absent, so if `getSessionFile()` also returns `undefined` an unguarded comparison evaluates `undefined !== undefined` → false and suppresses the end on the most important reason.

`getSessionFile` SHALL be treated as optionally present, consistent with how the extension already treats the harness's `ui` channel: the extension is installed into whatever harness version the operator has. When the context does not expose it, the end SHALL proceed for every end-set reason — the same recoverable-versus-unrecoverable trade as above, resolved toward the failure a user can see.

Whichever branch runs, the extension SHALL still perform its awaited summary write and its MCP client close, and SHALL still forget the session's in-memory accumulator afterwards. No shutdown SHALL leave the accumulator unflushed and no shutdown SHALL leave a pending debounce timer alive.

#### Scenario: A closing reason ends the session

- **GIVEN** a registered Pi session with at least one accumulated turn
- **WHEN** `session_shutdown` fires with `reason` equal to `quit`, `new`, `resume` or `fork` and no `targetSessionFile` naming the current session file
- **THEN** the extension SHALL POST the session-end path for that session id
- **AND** the row SHALL have `status = 'ended'` with `ended_at` set

#### Scenario: `reload` does not end the session (the discriminating control)

- **GIVEN** a registered Pi session with at least one accumulated turn
- **WHEN** `session_shutdown` fires with `reason: "reload"`
- **THEN** the extension SHALL NOT POST the session-end path
- **AND** the row SHALL still have `status = 'active'` with `ended_at` unset
- **AND** the accumulated transcript SHALL still have been written, via the summary path

#### Scenario: Self-resume does not end the session

- **GIVEN** a registered Pi session whose session manager reports session file `F`
- **WHEN** `session_shutdown` fires with `reason: "resume"` and `targetSessionFile` equal to `F`
- **THEN** the extension SHALL NOT POST the session-end path
- **AND** the row SHALL still have `status = 'active'`

#### Scenario: An unrecognised reason does not end the session

- **WHEN** `session_shutdown` fires with `reason` absent, empty, or a value outside the end-set
- **THEN** the extension SHALL NOT POST the session-end path
- **AND** the row SHALL still have `status = 'active'`, left for the server's stale-active retirement sweep

#### Scenario: A quit-and-reopen round trip returns the row to active

- **GIVEN** a Pi session `<S>` with at least one accumulated turn, closed with `reason: "quit"` so its row is `ended`
- **WHEN** the operator reopens that persisted conversation (`pi -r`, `pi -c`, or `pi --session <file>`), the extension registers `<S>` on the first `before_agent_start` of the new process, and the resume follows
- **THEN** the row SHALL be `status='active'` with `ended_at IS NULL`
- **AND** a subsequent `memory.save` on that process's MCP transport SHALL persist `session_id = <S>`
- **AND** the control SHALL pass in the same run: without the resume the row stays `ended` and the same save persists `session_id = NULL`

#### Scenario: The resume fires once per process regardless of turn count

- **GIVEN** a reopened Pi session that runs N agent turns
- **WHEN** `before_agent_start` fires on each of them
- **THEN** exactly one `POST /api/<slug>/sessions/<id>/resume` SHALL have been issued across the whole process
- **AND** the count SHALL be independent of N and of the `session_start` event's `reason`

#### Scenario: The gate is covered by tests that fail without it

- **WHEN** the reason gate is widened to always-true and the test suite is re-run
- **THEN** the `reload` scenario's test SHALL fail
- **AND** when the `targetSessionFile` comparison is removed, the self-resume scenario's test SHALL fail
