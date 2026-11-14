## MODIFIED Requirements

### Requirement: Sessions registered via HTTP MUST be reachable by MCP tools through an explicit `sessionId` or the sole-active-session lookup

When a session row is created via `POST /api/<slug>/sessions`, MCP tool handlers SHALL reach it — when resolving the Rembric session for a request — through exactly two mechanisms, in this order: (1) an explicit `sessionId` argument naming the row, validated for ownership as the `mcp-api` capability specifies; (2) otherwise `findActiveForTransport(token_id, project_id)`, which returns the row only when it is the unambiguous `active` session for the caller's `(token_id, project_id)` (see the `sessions` capability, "`findActiveForTransport` MUST NOT guess under concurrent ambiguity"). The server SHALL NOT bind an HTTP-registered session to an MCP connection, and SHALL keep no per-connection session state for either mechanism to consult.

This is the bridge that makes `memory.save` calls (issued by the agent over MCP) attach `session_id` to the row that the hook created via HTTP.

#### Scenario: Hook creates session over HTTP, agent saves memory over MCP

- **GIVEN** a client POSTs `{ id: 'sess-abc12345' }` to `/api/foo/sessions` (HTTP) and the session row is created, and it is the only `active` row for `(token_id, foo.id)`
- **AND** the same agent then opens an MCP connection on `/mcp/foo` and calls `memory.save({ type: 'project', content: '...' })` without `sessionId`
- **WHEN** the server resolves the active session for that save call
- **THEN** the resolution SHALL find `sess-abc12345` and the saved memory's `session_id` SHALL equal `'sess-abc12345'`

#### Scenario: Multiple active sessions for the same (token, project)

- **GIVEN** two `status='active'` rows exist for `(token_id, foo.id)` (e.g. user has two Claude Code windows open), both inside the staleness window
- **WHEN** a memory save without `sessionId` attaches via fallback resolution
- **THEN** the save SHALL persist `session_id = NULL` rather than choosing either row by recency
- **AND** the same save carrying `sessionId` of either row SHALL attach to that row, which is how a client with concurrent sessions names its own
- **AND** neither row's eventual `ended_at` / `summary` is affected

### Requirement: `POST /api/<slug>/sessions/:id/resume` MUST return a terminal session to `active`

The server SHALL expose `POST /api/<slug>/sessions/:id/resume`, the HTTP counterpart of the `memory.session_resume` MCP tool. It exists because the plugin clients — which are the processes that know a host conversation has been reopened — speak HTTP for session lifecycle and have no MCP session of their own (`plugin-session-protocol`, "Session lifecycle is HTTP").

The route SHALL apply the same gates as `POST /api/<slug>/sessions/:id/end`, in the same order:

1. An unresolvable `:slug` SHALL be refused `404` `{ ok: false, code: 'project_not_found', slug }`.
2. A token whose scope does not cover the resolved project SHALL be refused `403` `{ ok: false, code: 'forbidden', message }`. Resume is a `write` operation; a read-only token SHALL NOT reach it.
3. An absent row, a row owned by another token, or a row belonging to another project SHALL be refused `404` `{ ok: false, code: 'session_not_found', message }`. A project or token mismatch SHALL be masked as `session_not_found` rather than reported as `forbidden`, so the route never confirms that an id exists elsewhere.
4. A soft-deleted row SHALL be refused `409` `{ ok: false, code: 'session_deleted', message }`. An operator's Delete SHALL NOT be undone over HTTP any more than it can be over MCP.

The request body SHALL be an object carrying no properties, and its schema SHALL be **strict**: a body containing any property SHALL be refused `400` `{ ok: false, code: 'invalid_input', message }`. Both an absent body and `{}` SHALL be accepted, because the shared bash helper normalises an empty body argument to `{}` (`claude-code-plugin`, `rembric_post`). Strictness is the point of the route existing at all — see the ensure requirement above — so it SHALL NOT be relaxed to a permissive `z.object(...)` for convenience.

On success the server SHALL respond `200` with `{ ok: true, sessionId, status: 'active', startedAt, resumedAt, previousStatus, previousEndedAt, title }`, where `previousStatus` is the row's `status` immediately before the call and `previousEndedAt` is the ISO `ended_at` the call discarded, or `null` when the row was already `active`. Those two fields SHALL be present on every success response: they are the only report of a value the server does not retain (`sessions` capability). A row that is already `active` SHALL be a success no-op — `200`, `previousStatus: 'active'`, `previousEndedAt: null`, no `UPDATE` — so a client that resumes unconditionally after every ensure never sees an error for doing so.

This route SHALL NOT bind the resumed session to any MCP connection, and neither does `memory.session_resume` (`mcp-api` capability): the server keeps no per-connection session state. The consequence SHALL be stated rather than hidden: a resumed session is reachable by auto-attach through the sole-active-session lookup only, which declines to resolve when a second session is concurrently live for the same `(token, project)`. A client that needs an unambiguous attachment passes the session's id as `sessionId` on each write.

The route SHALL NOT be reachable at `/api/sessions/:id/resume` (no slug segment), consistent with every other route in this capability.

#### Scenario: An ended session is returned to active

- **GIVEN** session `<S>` owned by the calling token under slug `foo`, with `status='ended'` and `ended_at = E`
- **WHEN** the client POSTs `{}` to `/api/foo/sessions/<S>/resume`
- **THEN** the response SHALL be `200` with `{ ok: true, sessionId: <S>, status: 'active', startedAt, resumedAt, previousStatus: 'ended', previousEndedAt: E, title }`
- **AND** the row SHALL have `status='active'` and `ended_at IS NULL`

#### Scenario: An abandoned session is returned to active identically

- **GIVEN** session `<S>` with `status='abandoned'` and `ended_at = E`
- **WHEN** the client POSTs `{}` to `/api/foo/sessions/<S>/resume`
- **THEN** the response SHALL differ from the `ended` case only in `previousStatus: 'abandoned'`
- **AND** the resulting row SHALL be indistinguishable in every column from the same row resumed out of `ended`

#### Scenario: Resuming an already-active session is a success no-op

- **GIVEN** session `<S>` with `status='active'` and a `last_activity_at` of `L`
- **WHEN** the client POSTs `{}` to `/api/foo/sessions/<S>/resume`
- **THEN** the response SHALL be `200` with `previousStatus: 'active'` and `previousEndedAt: null`
- **AND** `last_activity_at` SHALL still be `L` — the no-op path issues no `UPDATE`

#### Scenario: An unknown property is refused rather than discarded

- **WHEN** the client POSTs `{ epoch: 3 }` to `/api/foo/sessions/<S>/resume`
- **THEN** the response SHALL be `400` `{ ok: false, code: 'invalid_input', message }` naming the unrecognised property
- **AND** the row's `status` SHALL be unchanged
- **AND** the control SHALL pass in the same run: the same request with body `{}` SHALL succeed

#### Scenario: A soft-deleted session is refused

- **GIVEN** session `<S>` with `deleted_at` set
- **WHEN** the client POSTs `{}` to `/api/foo/sessions/<S>/resume`
- **THEN** the response SHALL be `409` `{ ok: false, code: 'session_deleted', message }`
- **AND** the row SHALL still have its `deleted_at` and its terminal `status`

#### Scenario: A session owned by another token is masked as not found

- **GIVEN** session `<S>` owned by token A
- **WHEN** token B POSTs `{}` to `/api/foo/sessions/<S>/resume`
- **THEN** the response SHALL be `404` `{ ok: false, code: 'session_not_found', message }`, never `403`
- **AND** the row SHALL be unchanged

#### Scenario: A session in another project is masked as not found

- **GIVEN** session `<S>` belongs to project `bar` and the calling token is authorised for both `foo` and `bar`
- **WHEN** the client POSTs `{}` to `/api/foo/sessions/<S>/resume`
- **THEN** the response SHALL be `404` `{ ok: false, code: 'session_not_found', message }`

#### Scenario: A read-only token cannot resume

- **GIVEN** a token authorised for project `foo` with read access only
- **WHEN** it POSTs `{}` to `/api/foo/sessions/<S>/resume`
- **THEN** the response SHALL be `403` `{ ok: false, code: 'forbidden', message }`
- **AND** the row SHALL be unchanged

#### Scenario: The route does not pin the SessionRouter

- **GIVEN** a session `<S>` resumed over HTTP and a second `active` session `<T>` for the same `(token, project)`
- **WHEN** the agent calls `memory.save` over MCP on `/mcp/foo` without `sessionId`, and then again with `sessionId: <S>`
- **THEN** the first saved row SHALL carry `session_id = NULL`, because the resume bound `<S>` to no connection and the `SessionRouter` it once declined to pin is removed
- **AND** the second saved row SHALL carry `session_id = <S>`, which is the control that the resumed session is reachable by its explicit id

### Requirement: The authenticated HTTP surface MUST bound request body size

Endpoints that read a request body — `/mcp` (POST) and `/api/<slug>/sessions*` — SHALL enforce a maximum raw body size and reject an over-large body with `413` (payload too large) instead of buffering it unboundedly in memory. The bound SHALL apply even to authenticated callers, so a valid token cannot exhaust process memory with a single large POST. The limit SHALL be generous enough for legitimate MCP payloads and MAY be configurable.

#### Scenario: Oversized MCP body is rejected

- **GIVEN** an authenticated client posting a body larger than the configured maximum to `/mcp`
- **WHEN** the server reads the request
- **THEN** the server SHALL stop reading and respond `413` without buffering the entire body

#### Scenario: Normal-sized body is accepted

- **GIVEN** an authenticated client posting a body within the configured maximum
- **WHEN** the server reads the request
- **THEN** the request SHALL be processed normally

### Requirement: The MCP transport MUST support configurable Host/Origin allow-lists

The Streamable HTTP transport SHALL accept operator-configured `Host` and `Origin` allow-lists (`REMBRIC_MCP_ALLOWED_HOSTS`, `REMBRIC_MCP_ALLOWED_ORIGINS`, comma-separated). Entries SHALL be matched by hostname: a port in a `Host` entry and a scheme or port in an `Origin` entry are accepted and ignored, so `rembric.example.com:443` and `https://rembric.example.com` both admit the hostname `rembric.example.com` on any port. When EITHER list is configured, DNS-rebinding protection SHALL be enabled and the transport SHALL reject a request whose `Host` hostname is not on the host allow-list, or whose `Origin` is present and its hostname not on the origin allow-list. The check SHALL run before authentication, the failed-attempt lockout and rate limiting, so a rebinding request is refused without its credentials being evaluated. When NEITHER is configured, protection SHALL be off (the current default): this is defense-in-depth layered on the mandatory bearer token — which already rejects any request without valid credentials — and the strict `Host` check would otherwise risk rejecting legitimate reverse-proxy setups. Protection is opt-in rather than always-on because the primary control is the bearer requirement.

#### Scenario: Unconfigured transport does not reject on Host/Origin

- **GIVEN** no `REMBRIC_MCP_ALLOWED_HOSTS` / `REMBRIC_MCP_ALLOWED_ORIGINS` configured
- **WHEN** a valid-bearer request arrives at `/mcp` with any `Host`
- **THEN** DNS-rebinding protection SHALL NOT reject it (behavior unchanged from before this change)

#### Scenario: Configured transport rejects an unlisted Host

- **GIVEN** `REMBRIC_MCP_ALLOWED_HOSTS` is configured with the deployment host
- **WHEN** a request arrives at `/mcp` with a `Host` header not on the allow-list
- **THEN** the transport SHALL reject the request

#### Scenario: Configured transport serves an allowed Host with a valid bearer

- **GIVEN** `REMBRIC_MCP_ALLOWED_HOSTS` includes the deployment host
- **WHEN** a request arrives at `/mcp` with an allowed `Host` and a valid bearer token
- **THEN** the request SHALL be handled normally

#### Scenario: A configured host:port entry admits its hostname on any port

- **GIVEN** `REMBRIC_MCP_ALLOWED_HOSTS` is `rembric.example.com:443`
- **WHEN** a request with a valid bearer arrives at `/mcp` with `Host: rembric.example.com` or `Host: rembric.example.com:443`
- **THEN** the request SHALL be handled normally

#### Scenario: A rebinding request is refused before its credentials are evaluated

- **GIVEN** `REMBRIC_MCP_ALLOWED_HOSTS` is configured with the deployment host
- **WHEN** a request with no bearer arrives at `/mcp` with a `Host` header not on the allow-list
- **THEN** the transport SHALL answer `403` rather than the `401` bearer challenge

## RENAMED Requirements

- FROM: `### Requirement: Sessions registered via HTTP MUST integrate with the SessionRouter so subsequent MCP tools attach memories to them`
- TO: `### Requirement: Sessions registered via HTTP MUST be reachable by MCP tools through an explicit `sessionId` or the sole-active-session lookup`
