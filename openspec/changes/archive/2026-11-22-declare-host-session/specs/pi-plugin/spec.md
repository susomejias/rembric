## MODIFIED Requirements

### Requirement: The Pi extension SHALL declare its session identity on every session-attaching tool call

The extension SHALL declare its identity on each MCP tool call, in the request header and in the arguments. Once the host session is registered (below), every `tools/call` request SHALL carry `X-Rembric-Session: <host session id>`, whatever the tool's schema declares; the server attributes writes to an honoured declared session ahead of any `sessionId` argument. In addition, for every discovered tool whose server-published `inputSchema` declares a `sessionId` property, when the arguments the model supplied carry no `sessionId`, the extension SHALL add `sessionId: <host session id>` — the id Pi itself generated (`ctx.sessionManager.getSessionId()`) — to the arguments it forwards to `tools/call`. A `sessionId` the model supplied SHALL be forwarded unchanged in the arguments, while the header still carries the host id. The decision SHALL be taken from the discovered schema, never from a list of tool names, and SHALL leave the registered `inputSchema` exactly as the server published it (see "Tools are discovered at runtime over MCP and never enumerated in the plugin"). The argument is id-targeted, so it guesses nothing: it is the only form of session resolution that cannot be confounded by a second live row.

The extension tells the server which session it owns over HTTP: the shared core's `ensure` + single `/resume` register and revive the host-uuid row. Without an identifier on the MCP call, every MCP write on the extension's connection has to _infer_ which session it belongs to, by the windowed sole-active lookup the `sessions` capability describes — an inference that returns no session exactly when the operator runs several Pi sessions in the same project at once, which is the load-bearing use case. The server binds no session to an MCP connection, so the identifier SHALL travel on every call; there is nothing to declare once.

The extension SHALL NOT call `memory.session_resume` or `memory.session_start` on the MCP channel to declare its identity: neither binds a session to the connection, so such a call would declare nothing, and `memory.session_start` is the one MCP path that can _insert_ a row when the resolution is ambiguous. The extension SHALL NOT mint a session row by any means, and SHALL keep obtaining rows solely from the HTTP `ensure`.

The extension SHALL add the identifier, as the header and as the argument, only after the first successful `/sessions` `ensure` for that host id in this process. Requests sent before it, such as `initialize` and `tools/list` during discovery, carry no `X-Rembric-Session`. The extension publishes no host binding file: it is its own MCP client, so the header replaces the binding the stdio-bridge clients publish. Before it, the row may not exist, and a write naming a row that does not exist is refused `session_not_found` by the server's explicit-id validation; leaving the argument out instead lets the call resolve by the published fallbacks, as it did before this requirement.

The injection is additive on the MCP channel and changes nothing in the HTTP lifecycle: the single `POST /api/<slug>/sessions/<id>/resume` after the first `ensure`, the per-turn `/turn` touch, and the end-on-shutdown rule remain as published.

#### Scenario: A write without a model-supplied `sessionId` carries the host id

- **GIVEN** a Pi session with host id `<H>` whose row has been registered over HTTP by the shared core's `ensure` in this process
- **WHEN** the model calls the provider-safe name of `memory.save` with arguments that carry no `sessionId`
- **THEN** the `tools/call` the extension sends SHALL carry `sessionId: <H>` and `X-Rembric-Session: <H>`, and the saved row's `session_id` SHALL be `<H>`
- **AND** the extension SHALL have issued no `memory.session_resume` and no `memory.session_start` on the MCP channel
- **AND** the `sessions` row count for the connection's `(token, project)` SHALL be unchanged, which is the control that declaring identity costs no row

#### Scenario: A model-supplied `sessionId` is forwarded unchanged

- **GIVEN** a Pi session with host id `<H>` already ensured
- **WHEN** the model calls a tool that declares `sessionId` with `sessionId: <X>`, where `<X>` differs from `<H>`
- **THEN** the `tools/call` the extension sends SHALL carry `sessionId: <X>` and `X-Rembric-Session: <H>`
- **AND** the saved row's `session_id` SHALL be `<H>`, because the declared host session outranks the model's argument

#### Scenario: A tool that declares no `sessionId` is forwarded untouched

- **GIVEN** a Pi session with host id `<H>` already ensured
- **WHEN** the model calls a tool whose `inputSchema` declares no `sessionId` property, such as `memory.search`
- **THEN** the `tools/call` arguments SHALL be exactly the model's arguments, with no `sessionId` added
- **AND** the request SHALL still carry `X-Rembric-Session: <H>`
- **AND** the server SHALL NOT refuse the call as carrying an unknown property

#### Scenario: Nothing is added before the host row exists

- **GIVEN** the MCP connection is used before any `/sessions` `ensure` has succeeded in this process
- **WHEN** the model calls a tool that declares `sessionId` without supplying one
- **THEN** the `tools/call` arguments SHALL carry no `sessionId` and the request SHALL carry no `X-Rembric-Session`
- **AND** the call SHALL NOT be refused with `session_not_found` on account of the extension, and no model-visible error or `ctx.ui` notification SHALL be produced by the extension

#### Scenario: The registered schema is the server's

- **WHEN** the extension registers a discovered tool that declares `sessionId`
- **THEN** the registered `inputSchema` SHALL be structurally identical to the one `tools/list` returned, with `sessionId` still optional wherever the server declared it optional

#### Scenario: Two parallel Pi sessions in one project keep their own rows

- **GIVEN** two Pi processes are open in the same project, with host ids `<H1>` and `<H2>`, both rows `active` and both ensured in their own process
- **WHEN** the model in either one calls `memory.save` without a `sessionId`
- **THEN** the memory saved by the first process SHALL carry `session_id = <H1>` and the one saved by the second SHALL carry `session_id = <H2>`
- **AND** neither SHALL be attached by the windowed or sole-active fallback, which is the ambiguity the per-call identifier exists to remove
