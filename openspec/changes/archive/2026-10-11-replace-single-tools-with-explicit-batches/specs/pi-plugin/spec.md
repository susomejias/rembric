## MODIFIED Requirements

### Requirement: Tools are discovered at runtime over MCP and never enumerated in the plugin

The extension SHALL obtain its tool surface by calling `tools/list` against the running server and registering each returned tool with the harness, proxying each `execute` invocation to `tools/call`. The extension SHALL NOT contain a list, map, array, or switch of tool names, nor a copy of any tool's input schema.

Each registered tool SHALL carry the server's own `description` and `inputSchema` with their **structure** unaltered — no key added, removed, or reordered, no constraint weakened. The single transformation permitted is the tool-name spelling, and it SHALL be applied consistently: to the registered name, and to every model-facing string this client publishes that names a tool (the description, every `description` nested in the schema, and the injected nudges). Renaming the name while leaving the prose dotted would hand the model guidance that names tools its own registry does not contain — the client renames, so the client owns the renaming everywhere it speaks.

Tool **results** SHALL NOT be rewritten: a saved memory's content is the user's text and may legitimately contain a dotted name.

Consequently, adding, renaming, or removing a server tool SHALL require no change to this extension, and the plugin and server tool surfaces cannot desynchronise because only one of them describes the surface.

Because the `inputSchema` travels verbatim, the harness validates arguments against the same schema object the server enforces, so `additionalProperties: false` is applied twice — once before `execute` runs and once on the server. **Only the server-side half is reachable from this repository's suite, and the requirement below says so rather than crediting the suite with the other half.** Driving the harness's validator means importing `@earendil-works/pi-ai`, which carries five provider SDKs — the inbound cost design D7 refuses for this client — so the pre-`execute` half is evidenced **out of band**, by a real harness run, with its measurement recorded in `tasks.md` (3.8). What the suite carries is the server-side refusal, its passing control, and the forwarding assertions that make the two layers see the same schema; a test that calls `execute` directly bypasses the harness's `parameters` handling and therefore evidences the server, not the harness.

#### Scenario: Every server tool is registered with no per-tool plugin code

- **GIVEN** the server registers N tools (N is 23 at the time of writing, at `packages/mcp/src/server.ts`)
- **WHEN** the extension initialises against that server
- **THEN** exactly N tools SHALL be registered with the harness
- **AND** each registered tool SHALL correspond to exactly one server tool under the name mapping fixed by the provider-safe-names requirement, with no tool dropped and none invented

#### Scenario: The plugin source contains no tool inventory

- **WHEN** `apps/plugin/.pi-plugin/index.ts` is read at HEAD
- **THEN** it contains no occurrence of any server tool name as a literal (for example `memory.save`, `memory.search`, `memory.judge_batch`) outside of comments and test fixtures

#### Scenario: A proxied call reaches the database

- **GIVEN** a running server and an initialised extension
- **WHEN** the harness invokes the registered `memory.save` tool with a valid title and content
- **THEN** the proxied `tools/call` SHALL return a non-error result
- **AND** an independent `memory.get_batch({ ids: [id] })` SHALL return the saved row in `memories`
- **AND** the control — `memory.get_batch({ ids: [missingId] })` — SHALL return MCP `isError: true`, `memories: []` and an associated `not_found` error for `missingId`

#### Scenario: The forwarded schema is the one both layers enforce

- **WHEN** the value registered as the harness's `parameters` is compared with the server's own `inputSchema`
- **THEN** it SHALL be structurally identical, `$schema` and `additionalProperties: false` included, differing only in the tool-name spellings inside `description` strings
- **AND** a test SHALL go red if anything is stripped from it

#### Scenario: The server refuses a malformed payload (the in-suite half)

- **WHEN** a proxied `tools/call` carries an unknown property, an invalid enum member, or a missing required property
- **THEN** the server SHALL refuse each one against its own strict schema
- **AND** the control — the same call with a valid payload — SHALL succeed
- **AND** this is the boundary the suite exercises: it drives `execute`, so it evidences the server's enforcement and SHALL NOT be described as evidence about the harness

#### Scenario: The harness refuses before `execute` runs (measured out of band)

- **GIVEN** the harness's validator is unreachable from this repository's suite without adding `@earendil-works/pi-ai` and the five provider SDKs it carries
- **WHEN** a real harness run invokes a registered tool with an unknown property, an invalid enum member, or a missing required property
- **THEN** each SHALL be refused with the **harness's** own validation message, before `execute` runs
- **AND** the database SHALL hold no row from any refused call, which is what shows no `tools/call` was sent
- **AND** the evidence SHALL be recorded with its provenance in `tasks.md` rather than attributed to the suite

### Requirement: The shutdown reason decides whether the session is ended

The extension SHALL issue the session end **only** when `reason` is a member of the explicit end-set `{quit, new, resume, fork}`. On `reload` it SHALL NOT end the session, because `reload` is the same session continuing. An end issued on a surviving session costs `session_id = NULL` on every later `memory.save` and `session_not_found` from `memory.session_summary` until the next `before_agent_start` ensure-and-resume repairs it, and there is no reason to incur a repairable fault when the correct branch is free. The existence of the resume path SHALL NOT be treated as making a wrong end cheap: within a single agent turn nothing re-runs `before_agent_start`, so the writes made between the wrong end and the next turn are lost to `session_id = NULL` and are not recoverable afterwards.

`session_shutdown` is not a process-death signal. The harness declares `SessionShutdownEvent { type: "session_shutdown"; reason: "quit" | "reload" | "new" | "resume" | "fork"; targetSessionFile?: string }` (`dist/core/extensions/types.d.ts:462-468` of `@earendil-works/pi-coding-agent@0.84.1`), documented as "Fired before an extension runtime is torn down due to quit, reload, or session replacement", and four of the five reasons are session replacement inside a surviving process.

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

### Requirement: The Pi extension SHALL declare its session identity on the MCP transport

The extension SHALL therefore declare its identity on the MCP transport itself: once the host row exists for this process — that is, after the first successful `/sessions` `ensure` for that id — it SHALL call `memory.session_resume` with `{ sessionId: <host session id> }`, the id Pi itself generated (`ctx.sessionManager.getSessionId()`). The declaration is id-targeted, so it guesses nothing: it is the only form of session resolution that cannot be confounded by a second live row, and it makes the transport binding that `memory.session_start` consults first exist from turn zero rather than after the model happens to call something.

Today the extension tells the server which session it owns only over HTTP: the shared
core's `ensure` + single `/resume` register and revive the host-uuid row, and nothing on
the MCP channel ever names that row. The consequence is that every MCP write and every
model-initiated `memory.session_start` on the extension's own transport has to _infer_
which session it belongs to, by the windowed sole-active lookup the `sessions`
capability describes — an inference that goes wrong exactly when the operator runs
several Pi sessions in the same project at once, which is the load-bearing use case.

`memory.session_resume` is the mandated verb, and `memory.session_start` is prohibited
for this purpose. Resuming a row that is already `active` is a successful no-op on the
row and still (re-)establishes the transport binding — see the `mcp-api` capability,
"The MCP server MUST expose four session-lifecycle tools", pinned by the scenario
"`memory.session_resume` on an already-active session succeeds and re-pins" — which is
what makes an unconditional start-up call safe. `memory.session_start` is the one MCP
path that can _insert_ a row when the resolution is ambiguous, so using it to declare an
id would let the extension mint the very ghost rows this change exists to remove. The
extension SHALL NOT call `memory.session_start`, SHALL NOT mint a session row by any
means, and SHALL keep obtaining rows solely from the HTTP `ensure`.

The declaration SHALL be (re-)issued whenever the MCP transport is (re-)initialised in
this process, including the handshake that follows an extension reload. The server-side
binding is keyed by `(tokenId, mcpSessionId)` and lives in memory, so a fresh MCP
session id arrives with no binding: declaring once at process start is not enough, and
the re-declaration is what keeps a long-lived Pi conversation attached to its own row
across reloads.

The declaration SHALL be tolerant and silent. While the host row does not exist yet the
call returns `session_not_found`, which is an expected ordering fact rather than a
failure: the extension SHALL retry it after the `ensure` that creates the row. Any
declaration failure — `not_found` past the retry, an unreachable server, a token or
project mismatch — SHALL NOT be surfaced to the model, SHALL NOT be notified to the
user, and SHALL NOT abort the handler or the tool registration that shares the
handshake: an un-declared transport behaves exactly as it does today, resolving by the
published fallbacks. A nicety the extension may afford itself and nothing more: this is
an optimisation of the transport's own attachment, not a fact the agent needs to know.

The declaration is additive on the MCP channel and changes nothing in the HTTP
lifecycle: the single `POST /api/<slug>/sessions/<id>/resume` after the first `ensure`,
the per-turn `/turn` touch, and the end-on-shutdown rule remain as published.

The extension SHALL bound its consecutive declaration failures with a small constant,
and that budget SHALL be per transport: a transport that exhausted it has stopped being
asked, and a re-keyed transport SHALL start with a fresh budget rather than inheriting
the exhausted one. The bound is what keeps a permanently failing declaration from
costing one failed call per turn forever; resetting it on re-key is what keeps a new
transport from being condemned by the previous one's failures.

#### Scenario: A normal start binds the transport to the host row

- **GIVEN** a Pi session with host id `<H>` whose row has been registered over HTTP by the shared core's `ensure`
- **WHEN** the extension's MCP handshake has completed and the first `ensure` for `<H>` in this process has returned
- **THEN** the extension SHALL have called `memory.session_resume` with `{ sessionId: <H> }` on that transport
- **AND** the `sessions` row count for the connection's `(token, project)` SHALL be unchanged, which is the control that declaring identity costs no row
- **AND** no `memory.session_start` SHALL have been issued by the extension

#### Scenario: The row does not exist yet, so the declaration is retried silently

- **GIVEN** the MCP transport initialises before any `/sessions` `ensure` has run, so `<H>` names no row
- **WHEN** the extension issues its start-up `memory.session_resume({ sessionId: <H> })`
- **THEN** the `session_not_found` result SHALL be swallowed by the extension — no model-visible error, no `ctx.ui` notification, no aborted handshake, tools still registered
- **AND** after the first successful `ensure` for `<H>` the extension SHALL retry the declaration and the transport SHALL end up bound to `<H>`

#### Scenario: A transport re-init re-declares the binding

- **GIVEN** the extension's MCP transport has been re-initialised (an extension reload, or any new `initialize` handshake in this process), so the server holds a fresh MCP session id with no session bound to it
- **WHEN** the re-initialised transport is used again for a host id `<H>` already ensured in this process
- **THEN** the extension SHALL issue `memory.session_resume({ sessionId: <H> })` on the new transport
- **AND** writes on that transport SHALL attach to `<H>` rather than resolving by the sole-active heuristics

#### Scenario: The failure budget is per transport and resets when it re-keys

- **GIVEN** `memory.session_resume` has failed the extension's bounded number of consecutive times on one MCP transport, so that transport is no longer asked
- **WHEN** the transport re-initialises and the server hands out a new MCP session id
- **THEN** the extension SHALL attempt the declaration again on the new transport instead of inheriting the exhausted budget
- **AND** the cap SHALL remain per transport: a declaration that keeps failing still degrades to the published fallbacks rather than costing one failed call per turn forever

#### Scenario: A declaration that never succeeds degrades to today's behaviour

- **GIVEN** `memory.session_resume` fails for a reason that outlives the retry (server unreachable, token lacks the project, the row belongs to another project)
- **WHEN** the conversation continues
- **THEN** the extension SHALL behave exactly as it does today: sessions are still registered and touched over HTTP, summaries and ends still land, and MCP writes resolve through the published lookups
- **AND** the failure SHALL NOT be surfaced to the model or the operator, and SHALL NOT prevent any other part of the extension from working

#### Scenario: Two parallel Pi sessions in one project keep their own rows

- **GIVEN** two Pi processes are open in the same project, with host ids `<H1>` and `<H2>`, both rows `active`
- **WHEN** each process completes its own start-up declaration and the model in either one calls `memory.save` without a `sessionId`
- **THEN** the memory saved by the first process SHALL carry `session_id = <H1>` and the one saved by the second SHALL carry `session_id = <H2>`
- **AND** neither SHALL be attached by the windowed or sole-active fallback, which is the ambiguity this declaration exists to remove
