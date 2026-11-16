## MODIFIED Requirements

### Requirement: A Pi session row reaches `ended` on a real close, and `abandonStale` remains the only net for the rest

A Pi session that shuts down for an end-set reason SHALL leave its row in `status = 'ended'` with `ended_at` set, so no second `active` row survives for the same `(token, project)`. This is what removes the transport ambiguity: session resolution is "sole match or nothing" (`sessions` capability), so while a replaced Pi session stays `active` alongside its successor, the successor resolves to nothing and every write that reaches the server without a `sessionId` records `session_id = NULL` for the whole staleness window. The extension names its own session on every call to a tool that declares `sessionId` (see "The Pi extension SHALL declare its session identity on every session-attaching tool call"), so its own writes through those tools no longer depend on this; the end still decides what the sole-active lookup resolves for every write that names no session.

The end SHALL be idempotent from the client's point of view: a second end on the same row returns success with the existing `ended_at` unchanged, and an end on a row the retirement sweep already flipped to `abandoned` SHALL leave it `abandoned` (see the `sessions` capability's terminal-write requirement). The extension SHALL NOT special-case either.

The following exits reach no handler and therefore end nothing; the row stays `active` until the server's stale-active retirement sweep flips it to `abandoned`. This SHALL be stated rather than implied, because a client that claims reliable termination it does not deliver is worse than one that claims none:

- `SIGKILL` and OS-level crashes.
- A single-press interrupt (the interrupt behaviour of this harness is described in this capability's session-close requirement and is not revisited here).
- Print mode receiving `SIGINT`, which it does not register as a signal.

No requirement in this capability SHALL assert that every Pi session reaches a terminal status.

#### Scenario: The successor session attributes its memories

- **GIVEN** a Pi session `A` registered for `(token, project)` and later replaced by session `B` on the same token and project
- **WHEN** `A`'s shutdown ended it and a `memory.save` for `(token, project)` then reaches the server without a `sessionId`
- **THEN** the saved row's `session_id` SHALL be `B`
- **AND** the count of memories attributed to `B` SHALL be non-zero

#### Scenario: The control — without the end, the successor attributes nothing

- **GIVEN** the same sequence with `A`'s shutdown NOT ending it, so `A` and `B` are both `active` within the staleness window
- **WHEN** a `memory.save` for `(token, project)` reaches the server without a `sessionId`
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

## ADDED Requirements

### Requirement: The Pi extension SHALL declare its session identity on every session-attaching tool call

The extension SHALL declare its identity on each MCP tool call rather than on the transport. For every discovered tool whose server-published `inputSchema` declares a `sessionId` property, when the arguments the model supplied carry no `sessionId`, the extension SHALL add `sessionId: <host session id>` — the id Pi itself generated (`ctx.sessionManager.getSessionId()`) — to the arguments it forwards to `tools/call`. A `sessionId` the model supplied SHALL be forwarded unchanged. The decision SHALL be taken from the discovered schema, never from a list of tool names, and SHALL leave the registered `inputSchema` exactly as the server published it (see "Tools are discovered at runtime over MCP and never enumerated in the plugin"). The argument is id-targeted, so it guesses nothing: it is the only form of session resolution that cannot be confounded by a second live row.

The extension tells the server which session it owns over HTTP: the shared core's `ensure` + single `/resume` register and revive the host-uuid row. Without an identifier on the MCP call, every MCP write on the extension's connection has to _infer_ which session it belongs to, by the windowed sole-active lookup the `sessions` capability describes — an inference that returns no session exactly when the operator runs several Pi sessions in the same project at once, which is the load-bearing use case. The server binds no session to an MCP connection, so the identifier SHALL travel on every call; there is nothing to declare once.

The extension SHALL NOT call `memory.session_resume` or `memory.session_start` on the MCP channel to declare its identity: neither binds a session to the connection, so such a call would declare nothing, and `memory.session_start` is the one MCP path that can _insert_ a row when the resolution is ambiguous. The extension SHALL NOT mint a session row by any means, and SHALL keep obtaining rows solely from the HTTP `ensure`.

The extension SHALL add the identifier only after the first successful `/sessions` `ensure` for that host id in this process. Before it, the row may not exist, and a write naming a row that does not exist is refused `session_not_found` by the server's explicit-id validation; leaving the argument out instead lets the call resolve by the published fallbacks, as it did before this requirement.

The injection is additive on the MCP channel and changes nothing in the HTTP lifecycle: the single `POST /api/<slug>/sessions/<id>/resume` after the first `ensure`, the per-turn `/turn` touch, and the end-on-shutdown rule remain as published.

#### Scenario: A write without a model-supplied `sessionId` carries the host id

- **GIVEN** a Pi session with host id `<H>` whose row has been registered over HTTP by the shared core's `ensure` in this process
- **WHEN** the model calls the provider-safe name of `memory.save` with arguments that carry no `sessionId`
- **THEN** the `tools/call` the extension sends SHALL carry `sessionId: <H>` and the saved row's `session_id` SHALL be `<H>`
- **AND** the extension SHALL have issued no `memory.session_resume` and no `memory.session_start` on the MCP channel
- **AND** the `sessions` row count for the connection's `(token, project)` SHALL be unchanged, which is the control that declaring identity costs no row

#### Scenario: A model-supplied `sessionId` is forwarded unchanged

- **GIVEN** a Pi session with host id `<H>` already ensured
- **WHEN** the model calls a tool that declares `sessionId` with `sessionId: <X>`, where `<X>` differs from `<H>`
- **THEN** the `tools/call` the extension sends SHALL carry `sessionId: <X>`

#### Scenario: A tool that declares no `sessionId` is forwarded untouched

- **GIVEN** a Pi session with host id `<H>` already ensured
- **WHEN** the model calls a tool whose `inputSchema` declares no `sessionId` property, such as `memory.search`
- **THEN** the `tools/call` arguments SHALL be exactly the model's arguments, with no `sessionId` added
- **AND** the server SHALL NOT refuse the call as carrying an unknown property

#### Scenario: Nothing is added before the host row exists

- **GIVEN** the MCP connection is used before any `/sessions` `ensure` has succeeded in this process
- **WHEN** the model calls a tool that declares `sessionId` without supplying one
- **THEN** the `tools/call` arguments SHALL carry no `sessionId`
- **AND** the call SHALL NOT be refused with `session_not_found` on account of the extension, and no model-visible error or `ctx.ui` notification SHALL be produced by the extension

#### Scenario: The registered schema is the server's

- **WHEN** the extension registers a discovered tool that declares `sessionId`
- **THEN** the registered `inputSchema` SHALL be structurally identical to the one `tools/list` returned, with `sessionId` still optional wherever the server declared it optional

#### Scenario: Two parallel Pi sessions in one project keep their own rows

- **GIVEN** two Pi processes are open in the same project, with host ids `<H1>` and `<H2>`, both rows `active` and both ensured in their own process
- **WHEN** the model in either one calls `memory.save` without a `sessionId`
- **THEN** the memory saved by the first process SHALL carry `session_id = <H1>` and the one saved by the second SHALL carry `session_id = <H2>`
- **AND** neither SHALL be attached by the windowed or sole-active fallback, which is the ambiguity the per-call identifier exists to remove

## REMOVED Requirements

### Requirement: The Pi extension SHALL declare its session identity on the MCP transport

**Reason**: The Pi extension no longer binds the MCP transport with a start-up `memory.session_resume`, because the server keeps no per-connection binding for that call to set. The bind loop, its silent retry, its per-transport failure budget and its re-declaration on a transport re-init are removed.

**Migration**: None required. The extension passes the host session id as `sessionId` on every discovered tool whose input schema declares it, as specified by "The Pi extension SHALL declare its session identity on every session-attaching tool call".
