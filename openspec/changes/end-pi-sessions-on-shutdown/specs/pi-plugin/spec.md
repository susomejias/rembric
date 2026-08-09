## ADDED Requirements

### Requirement: The shutdown reason decides whether the session is ended

`session_shutdown` is not a process-death signal. The harness declares `SessionShutdownEvent { type: "session_shutdown"; reason: "quit" | "reload" | "new" | "resume" | "fork"; targetSessionFile?: string }` (`dist/core/extensions/types.d.ts:462-468` of `@earendil-works/pi-coding-agent@0.84.1`), documented as "Fired before an extension runtime is torn down due to quit, reload, or session replacement", and four of the five reasons are session replacement inside a surviving process.

The extension SHALL issue the session end **only** when `reason` is a member of the explicit end-set `{quit, new, resume, fork}`. On `reload` it SHALL NOT end the session, because `reload` is the same session continuing and the status FSM is terminal in one direction only (`sessions` capability: "No path SHALL transition a session back to `active`"). An end issued on a surviving session costs `session_id = NULL` on every later `memory.save` and `session_not_found` from `memory.session_summary` for the remaining life of that process.

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

#### Scenario: The gate is covered by tests that fail without it

- **WHEN** the reason gate is widened to always-true and the test suite is re-run
- **THEN** the `reload` scenario's test SHALL fail
- **AND** when the `targetSessionFile` comparison is removed, the self-resume scenario's test SHALL fail

### Requirement: A Pi session row reaches `ended` on a real close, and `abandonStale` remains the only net for the rest

A Pi session that shuts down for an end-set reason SHALL leave its row in `status = 'ended'` with `ended_at` set, so no second `active` row survives for the same `(token, project)`. This is what removes the transport ambiguity: session resolution is "sole match or nothing" (`sessions` capability), so while a replaced Pi session stays `active` alongside its successor, the successor resolves to nothing and every implicit `memory.save` writes `session_id = NULL` for the whole staleness window.

The end SHALL be idempotent from the client's point of view: a second end on the same row returns success with the existing `ended_at` unchanged, and an end on a row the retirement sweep already flipped to `abandoned` SHALL leave it `abandoned` (see the `sessions` capability's terminal-write requirement). The extension SHALL NOT special-case either.

The following exits reach no handler and therefore end nothing; the row stays `active` until the server's stale-active retirement sweep flips it to `abandoned`. This SHALL be stated rather than implied, because a client that claims reliable termination it does not deliver is worse than one that claims none:

- `SIGKILL` and OS-level crashes.
- A single-press interrupt (the interrupt behaviour of this harness is described in this capability's session-close requirement and is not revisited here).
- Print mode receiving `SIGINT`, which it does not register as a signal.

No requirement in this capability SHALL assert that every Pi session reaches a terminal status.

#### Scenario: The successor session attributes its memories

- **GIVEN** a Pi session `A` registered for `(token, project)` and later replaced by session `B` on the same token and project
- **WHEN** `A`'s shutdown ended it and the agent then saves a memory from `B` without naming a `sessionId`
- **THEN** the saved row's `session_id` SHALL be `B`
- **AND** the count of memories attributed to `B` SHALL be non-zero

#### Scenario: The control — without the end, the successor attributes nothing

- **GIVEN** the same sequence with `A`'s shutdown NOT ending it, so `A` and `B` are both `active` within the staleness window
- **WHEN** the agent saves a memory from `B` without naming a `sessionId`
- **THEN** the saved row's `session_id` SHALL be `NULL`
- **AND** the count of memories attributed to `B` SHALL be zero

#### Scenario: A second end changes nothing

- **GIVEN** a Pi session row already `ended` with `ended_at = E`
- **WHEN** the end path is issued again for that row
- **THEN** the call SHALL succeed and `ended_at` SHALL still be `E`

#### Scenario: SIGKILL leaves the row for the sweep

- **GIVEN** a registered Pi session
- **WHEN** the process is SIGKILLed
- **THEN** no shutdown handler SHALL run and no end SHALL be issued
- **AND** the row SHALL remain `active` until the stale-active retirement sweep flips it to `abandoned`

## MODIFIED Requirements

### Requirement: Session close is awaited, with the interrupt exception recorded

The harness awaits its session-shutdown handler without a timeout (measured against 0.84.1: a 300 ms awaited fetch completes, a 10 s one completes, and an MCP `tools/call` issued from inside the handler completes; SIGTERM and SIGHUP both reach it; the control — SIGKILL — runs nothing). This client SHALL therefore perform its final session flush as an **awaited** call and SHALL NOT use the fire-and-forget dispose flush the opencode client requires.

On a shutdown whose reason closes the session (see "The shutdown reason decides whether the session is ended"), that awaited call SHALL be **one** request: `POST /api/<slug>/sessions/<id>/end` with body `{summary, title, final:false}` built by the same summary-body builder the per-turn flush uses, or `{}` when that builder yields nothing because the transcript accumulator is empty. On a shutdown that does not close the session it SHALL remain the summary POST it is today.

The end SHALL NOT be split into a summary POST followed by an end POST. Because the handler is awaited, the risk this design manages is **exit latency**, not a dropped write: every POST is bounded by `POST_TIMEOUT_MS`, so two sequential POSTs double the worst case a quitting user waits on an unreachable server and exceed the teardown budget this capability's tests assert. One request also removes the question of what a half-completed pair means, and matches `apps/plugin/scripts/session-end.sh`, the one shutdown path in this repository with production mileage.

The end SHALL be the last write this client makes for that session. Precedence is asymmetric across the terminal boundary — active rows are last-final-wins, terminal rows are first-final-wins (see the `sessions` capability) — so a curated `memory.session_summary` arriving after an end is silently dropped. A client SHALL NOT end a session it may still write to.

The shared core SHALL expose both the awaited flush and the fire-and-forget variant so each client uses the one its host's shutdown semantics justify. Copying the fire-and-forget path into this client would discard a measured guarantee for symmetry alone and SHALL NOT be done.

**Known edge, recorded rather than assumed benign:** SIGINT does **not** trigger the shutdown handler in print mode — `dist/modes/print-mode.js:32` reads `const signals = ["SIGTERM"]`, with SIGHUP wired separately — so a Ctrl-C in print mode loses the session close. The interactive TUI behaves the same way, and this was measured rather than inferred: driving a real TUI under a pty with keys delivered at t=4 s and stdin held open until t=14 s, Ctrl-C left the shutdown handler running at **13.6 s** (i.e. the stdin EOF fired it, not the key), byte-identical to the no-keys control, while Ctrl-D fired it at **3.6 s**. The Ctrl-D arm proves the byte channel worked, so the interrupt byte arrived and was simply not treated as an exit. A first version of this probe reported Ctrl-C as working; it was an instrument artefact, because closing stdin ended the session regardless — the control that must fail is what exposed it.

Therefore: **Ctrl-C is not a reliable session-close path in either mode**; Ctrl-D, SIGTERM and SIGHUP are, and all three are awaited. The per-turn flush bounds the loss at one turn.

#### Scenario: Shutdown flush completes

- **GIVEN** a session with accumulated transcript entries
- **WHEN** the harness shuts the session down via its normal exit path or SIGTERM
- **THEN** the summary POST SHALL complete before the process exits
- **AND** the server SHALL hold a non-null summary for that session

#### Scenario: The closing shutdown issues exactly one request

- **GIVEN** a session with accumulated transcript entries
- **WHEN** the harness shuts the session down with a reason in the end-set
- **THEN** the extension SHALL issue exactly one session-write request, to the end path, carrying the accumulated summary and derived title with `final:false`
- **AND** it SHALL NOT also issue a request to the summary path for that session

#### Scenario: An empty transcript still ends the session

- **GIVEN** a registered session whose transcript accumulator is empty
- **WHEN** the harness shuts the session down with a reason in the end-set
- **THEN** the extension SHALL POST the end path with an empty JSON body
- **AND** the row SHALL have `status = 'ended'` with `summary` still null

#### Scenario: The teardown budget holds against an unreachable server

- **GIVEN** a server that accepts connections and never answers
- **WHEN** the harness shuts the session down with `reason: "quit"`
- **THEN** the elapsed teardown SHALL stay within the budget this capability's test asserts, measured as the end-to-end handler wall-clock rather than the timing of the request in isolation

#### Scenario: SIGKILL runs nothing (the discriminating control)

- **WHEN** the process receives SIGKILL
- **THEN** no shutdown handler SHALL run and no summary POST SHALL be issued

#### Scenario: Ctrl-C is documented as lossy in both modes

- **WHEN** the extension's README or the client documentation describes session capture
- **THEN** it SHALL state that a Ctrl-C does not trigger the session close in either print or interactive mode, that Ctrl-D does, and that the per-turn flush bounds the loss to one turn

### Requirement: The extension SHALL import shared session-protocol logic, never reimplement it

`apps/plugin/.pi-plugin/index.ts` SHALL obtain the nudge strings, `stripPrivateTags`, the truncation helpers, the stderr diagnostic, the session HTTP client, the transcript accumulator, the summary-body builder, the flush helpers and the session-end call from `apps/plugin/bin/rembric-plugin-core.mjs`. It SHALL NOT declare its own copy of any of them.

The session-end call SHALL live in the shared core even though this is the only client that invokes it, because the core is the single implementation of the session HTTP client (see the `plugin-session-protocol` capability) and a second `fetch` against a `/sessions/…` path written in a client file is a second copy of that client by construction.

The core module SHALL require `agent` as a mandatory parameter of session registration, with **no default value**. `sessions.agent` is written once per session and memory is append-only, so a defaulted value registers sessions under the wrong agent permanently, with no repair verb. The hand-written type declaration `apps/plugin/bin/rembric-plugin-core.d.mts` SHALL declare `agent` as a required property so an omission is a compile error in the TypeScript clients.

#### Scenario: The extension imports the core rather than copying it

- **WHEN** `apps/plugin/.pi-plugin/index.ts` is read at HEAD
- **THEN** it contains an import statement referencing `rembric-plugin-core.mjs`
- **AND** it declares no local `function stripPrivateTags`, no local nudge string constant, and no local session-POST helper

#### Scenario: The session-end call is imported, not written in the client

- **WHEN** `apps/plugin/.pi-plugin/index.ts` is read at HEAD
- **THEN** it SHALL contain no `fetch` call against a path containing `/sessions/`
- **AND** the end SHALL be reached through the core's exported session-end function

#### Scenario: Omitting `agent` is a compile error

- **WHEN** a call to the core's session-registration entry point omits `agent`
- **AND** `tsc` typechecks a TypeScript client against `rembric-plugin-core.d.mts`
- **THEN** typechecking SHALL fail
- **AND** no default agent value SHALL be substituted at runtime
