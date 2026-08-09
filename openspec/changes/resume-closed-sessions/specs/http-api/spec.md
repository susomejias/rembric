## MODIFIED Requirements

### Requirement: `POST /api/<slug>/sessions` MUST create or upsert a session by client-provided id

The endpoint SHALL accept a JSON body `{ id: string, cwd?: string, agent?: string, description?: string }`. The `id` field is REQUIRED and SHALL match the regex `^[A-Za-z0-9_-]{8,128}$`. On a request whose `(token_id, id)` tuple does not yet exist, the server SHALL insert a new `agent_sessions` row with `status='active'`, `started_at=now`, the resolved `project_id` from the path slug, the provided `agent`/`description` (default `agent='unknown'`), and a placeholder `title` of the form `basename(cwd) · HH:MM UTC` (or `session · HH:MM UTC` if `cwd` is omitted/unparseable) with `title_final = false`. On a request whose `(token_id, id)` tuple already exists, the server SHALL return the existing row unchanged (idempotent ensure-session pattern, safe for hook re-fires).

"Unchanged" SHALL include `status` and `ended_at`. When the existing row is `ended` or `abandoned`, the endpoint SHALL return it in that state and SHALL NOT return it to `active`. Returning a session to `active` is reachable ONLY through an explicit, id-targeted resume: the `memory.session_resume` MCP tool (`mcp-api` capability) or `POST /api/<slug>/sessions/:id/resume` (below), both of which name the row in the request line and reach the same service verb (`sessions` capability, "`AgentSessionsService.resume()` MUST return a terminal session to `active`"). The activity touch this endpoint already applies to an existing row is NOT a lifecycle write and SHALL continue to apply irrespective of `status`.

The resume SHALL be a separate route rather than a field on this endpoint's body, and the reason is a property of this endpoint's schema rather than a preference. `sessionPostSchema` is a non-strict `z.object(...)`, so zod silently discards properties it does not declare: an `{ id, attach: true }` body sent to a server that predates the field, or with the field's name misspelled, would be accepted with `200` and `created: false` and would do nothing, and the response would be byte-identical to the correct-but-ignored case. The client cannot detect that. The same request sent to `POST /api/<slug>/sessions/:id/resume` on a server that does not implement it is refused by the router, which every client already reports through the one stderr diagnostic required by `plugin-session-protocol`'s failed-POST requirement. A loud failure was chosen over a silent one.

The server SHALL respond `200 OK` on both insert and upsert paths with body `{ ok: true, sessionId: <id>, scope: 'project', projectId: string, startedAt: string, title: string, created: boolean }`. The `created` field SHALL be `true` for fresh inserts, `false` for idempotent hits.

`scope` SHALL be the literal `'project'` and `projectId` SHALL be non-null: this endpoint is reachable only under a path slug, so it always resolves a project. The previous `'project'|'global'` union and nullable `projectId` described a state this route could not produce even before the global scope was retired, and a field with one reachable value carries no information — but the key is retained rather than removed, because the plugin clients of every supported agent read this response body and a removed key is a breaking change to a shipped HTTP contract for no gain. Its type narrows; its presence does not change.

#### Scenario: Fresh insert with valid id and cwd

- **WHEN** a client POSTs `{ id: 'sess-abc12345', cwd: '/home/u/project' }` to `/api/foo/sessions` at 22:14 UTC and no row exists for `(token_id, 'sess-abc12345')`
- **THEN** the server SHALL insert the row with `title = 'project · 22:14 UTC'`, `title_final = false`
- **AND** the response SHALL be `{ ok: true, sessionId: 'sess-abc12345', scope: 'project', projectId: '<foo.id>', startedAt: <iso>, title: 'project · 22:14 UTC', created: true }`

#### Scenario: Fresh insert without cwd

- **WHEN** a client POSTs `{ id: 'sess-abc12345' }` (no `cwd`)
- **THEN** the inserted row's `title` SHALL be `'session · HH:MM UTC'`

#### Scenario: Idempotent upsert with same id

- **WHEN** a client POSTs `{ id: 'sess-abc12345' }` twice to `/api/foo/sessions` with the same token
- **THEN** the second response SHALL return the same `startedAt` and `title` as the first, `created: false`, and the DB SHALL still have exactly one row

#### Scenario: Same id from a different token is rejected

- **WHEN** token A POSTs `{ id: 'shared-id-12345' }` to `/api/foo/sessions` (succeeds), then token B POSTs `{ id: 'shared-id-12345' }` to `/api/foo/sessions`
- **THEN** the second response SHALL be `409` with body `{ ok: false, code: 'id_collision', message }`
- **AND** the original row owned by token A SHALL be unchanged

#### Scenario: Missing id

- **WHEN** a client POSTs `{}` (no `id` field)
- **THEN** the server SHALL respond `400` with body `{ ok: false, code: 'invalid_input', message: <names the missing field> }`

#### Scenario: Malformed id

- **WHEN** a client POSTs `{ id: '<short>' }`, `{ id: '<char-with-spaces>' }`, or `{ id: 'A'.repeat(129) }`
- **THEN** the server SHALL respond `400` with body `{ ok: false, code: 'invalid_input', message: <names the regex contract> }`

#### Scenario: Endpoint hit on path-less `/api/sessions` without slug

- **WHEN** a client POSTs to `/api/sessions` (no slug segment)
- **THEN** the server SHALL respond `404` `{ ok: false, code: 'not_found' }`

#### Scenario: The response never reports a scope other than `project`

- **WHEN** the endpoint responds on any reachable path, insert or upsert
- **THEN** `scope` SHALL be `'project'` and `projectId` SHALL be non-null

#### Scenario: An ensure against a terminal row does not resume it

- **GIVEN** session `<S>` with `status='ended'` and `ended_at = E`, owned by the calling token
- **WHEN** the client POSTs `{ id: <S>, cwd, agent }` to `/api/<slug>/sessions` (the ordinary per-turn ensure)
- **THEN** the response SHALL carry `created: false` and the row SHALL still have `status='ended'` and `ended_at = E`
- **AND** the response SHALL NOT report the row as active

#### Scenario: An unknown property on the ensure body is discarded silently, which is why resume is a route

- **WHEN** a client POSTs `{ id: <S>, attach: true }` to `/api/<slug>/sessions` against a terminal row
- **THEN** the response SHALL be indistinguishable from the same request without the `attach` property — `200`, `created: false`, row still terminal
- **AND** no error SHALL be raised naming the unrecognised property

## ADDED Requirements

### Requirement: `POST /api/<slug>/sessions/:id/resume` MUST return a terminal session to `active`

The server SHALL expose `POST /api/<slug>/sessions/:id/resume`, the HTTP counterpart of the `memory.session_resume` MCP tool. It exists because the plugin clients — which are the processes that know a host conversation has been reopened — speak HTTP for session lifecycle and have no MCP session of their own (`plugin-session-protocol`, "Session lifecycle is HTTP").

The route SHALL apply the same gates as `POST /api/<slug>/sessions/:id/end`, in the same order:

1. An unresolvable `:slug` SHALL be refused `404` `{ ok: false, code: 'project_not_found', slug }`.
2. A token whose scope does not cover the resolved project SHALL be refused `403` `{ ok: false, code: 'forbidden', message }`. Resume is a `write` operation; a read-only token SHALL NOT reach it.
3. An absent row, a row owned by another token, or a row belonging to another project SHALL be refused `404` `{ ok: false, code: 'session_not_found', message }`. A project or token mismatch SHALL be masked as `session_not_found` rather than reported as `forbidden`, so the route never confirms that an id exists elsewhere.
4. A soft-deleted row SHALL be refused `409` `{ ok: false, code: 'session_deleted', message }`. An operator's Delete SHALL NOT be undone over HTTP any more than it can be over MCP.

The request body SHALL be an object carrying no properties, and its schema SHALL be **strict**: a body containing any property SHALL be refused `400` `{ ok: false, code: 'invalid_input', message }`. Both an absent body and `{}` SHALL be accepted, because the shared bash helper normalises an empty body argument to `{}` (`claude-code-plugin`, `rembric_post`). Strictness is the point of the route existing at all — see the ensure requirement above — so it SHALL NOT be relaxed to a permissive `z.object(...)` for convenience.

On success the server SHALL respond `200` with `{ ok: true, sessionId, status: 'active', startedAt, resumedAt, previousStatus, previousEndedAt, title }`, where `previousStatus` is the row's `status` immediately before the call and `previousEndedAt` is the ISO `ended_at` the call discarded, or `null` when the row was already `active`. Those two fields SHALL be present on every success response: they are the only report of a value the server does not retain (`sessions` capability). A row that is already `active` SHALL be a success no-op — `200`, `previousStatus: 'active'`, `previousEndedAt: null`, no `UPDATE` — so a client that resumes unconditionally after every ensure never sees an error for doing so.

This route SHALL NOT write the `SessionRouter` binding. The binding is keyed on `(tokenId, mcpSessionId)` and an HTTP request carries no `mcpSessionId`, so there is nothing to pin; pinning remains exclusive to `memory.session_resume` (`mcp-api` capability). The consequence SHALL be stated rather than hidden: a session resumed over HTTP is reachable by auto-attach through the sole-active-session lookup only, which declines to resolve when a second session is concurrently live for the same `(token, project)`. An agent that needs the unambiguous binding calls the MCP tool.

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

- **GIVEN** an MCP transport with no session binding, and a session `<S>` resumed over HTTP
- **WHEN** the `SessionRouter` entry for that transport is read
- **THEN** it SHALL still carry no session binding
- **AND** the control SHALL pass in the same run: `memory.session_resume` on the same row over the MCP transport DOES set it
