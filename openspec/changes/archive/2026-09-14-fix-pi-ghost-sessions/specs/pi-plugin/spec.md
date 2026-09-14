## ADDED Requirements

### Requirement: The Pi extension SHALL declare its session identity on the MCP transport

Today the extension tells the server which session it owns only over HTTP: the shared
core's `ensure` + single `/resume` register and revive the host-uuid row, and nothing on
the MCP channel ever names that row. The consequence is that every MCP write and every
model-initiated `memory.session_start` on the extension's own transport has to *infer*
which session it belongs to, by the windowed sole-active lookup the `sessions`
capability describes — an inference that goes wrong exactly when the operator runs
several Pi sessions in the same project at once, which is the load-bearing use case.

The extension SHALL therefore declare its identity on the MCP transport itself: once the
host row exists for this process — that is, after the first successful `/sessions`
`ensure` for that id — it SHALL call `memory.session_resume` with `{ sessionId: <host
session id> }`, the id Pi itself generated (`ctx.sessionManager.getSessionId()`). The
declaration is id-targeted, so it guesses nothing: it is the only form of session
resolution that cannot be confounded by a second live row, and it makes the transport
binding that `memory.session_start` consults first exist from turn zero rather than
after the model happens to call something.

`memory.session_resume` is the mandated verb, and `memory.session_start` is prohibited
for this purpose. Resuming a row that is already `active` is a successful no-op on the
row and still (re-)establishes the transport binding — see the `mcp-api` capability,
"The MCP server MUST expose four session-lifecycle tools", pinned by the scenario
"`memory.session_resume` on an already-active session succeeds and re-pins" — which is
what makes an unconditional start-up call safe. `memory.session_start` is the one MCP
path that can *insert* a row when the resolution is ambiguous, so using it to declare an
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
