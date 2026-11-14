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

#### Scenario: A session resumed over HTTP is reached by its explicit id under ambiguity

- **GIVEN** a session `<S>` resumed over HTTP and a second `active` session `<T>` for the same `(token, project)`
- **WHEN** the agent calls `memory.save` over MCP on `/mcp/foo` without `sessionId`, and then again with `sessionId: <S>`
- **THEN** the first saved row SHALL carry `session_id = NULL`
- **AND** the second saved row SHALL carry `session_id = <S>`, which is the control that the resumed session is reachable

## RENAMED Requirements

- FROM: `### Requirement: Sessions registered via HTTP MUST integrate with the SessionRouter so subsequent MCP tools attach memories to them`
- TO: `### Requirement: Sessions registered via HTTP MUST be reachable by MCP tools through an explicit `sessionId` or the sole-active-session lookup`
