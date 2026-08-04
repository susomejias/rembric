## MODIFIED Requirements

### Requirement: `POST /api/<slug>/sessions` MUST create or upsert a session by client-provided id

The endpoint SHALL accept a JSON body `{ id: string, cwd?: string, agent?: string, description?: string }`. The `id` field is REQUIRED and SHALL match the regex `^[A-Za-z0-9_-]{8,128}$`. On a request whose `(token_id, id)` tuple does not yet exist, the server SHALL insert a new `agent_sessions` row with `status='active'`, `started_at=now`, the resolved `project_id` from the path slug, the provided `agent`/`description` (default `agent='unknown'`), and a placeholder `title` of the form `basename(cwd) · HH:MM UTC` (or `session · HH:MM UTC` if `cwd` is omitted/unparseable) with `title_final = false`. On a request whose `(token_id, id)` tuple already exists, the server SHALL return the existing row unchanged (idempotent ensure-session pattern, safe for hook re-fires).

The server SHALL respond `200 OK` on both insert and upsert paths with body `{ ok: true, sessionId: <id>, scope: 'project', projectId: string, startedAt: string, title: string, created: boolean }`. The `created` field SHALL be `true` for fresh inserts, `false` for idempotent hits.

`scope` SHALL be the literal `'project'` and `projectId` SHALL be non-null: this endpoint is reachable only under a path slug, so it always resolves a project. The previous `'project'|'global'` union and nullable `projectId` described a state this route could not produce even before the global scope was retired, and a field with one reachable value carries no information — but the key is retained rather than removed, because the plugin clients of all four supported agents read this response body and a removed key is a breaking change to a shipped HTTP contract for no gain. Its type narrows; its presence does not change.

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

### Requirement: `POST /api/<slug>/memory/recall` MUST return ranked memory context for per-turn prefetch

The endpoint SHALL accept a JSON body `{ query: string, limit?: number }`. The `query` field is REQUIRED and SHALL be a non-empty string. The `limit` field, when present, SHALL be clamped to `[1, 5]` (this endpoint feeds a per-turn context-injection budget, not exploratory search); when omitted it SHALL default to 5. The endpoint SHALL resolve scope via the same `authenticate({pathSlug})` helper used by the other `/api/<slug>/*` routes, so the same 401/403/404 error contract (`missing_token`, `token_invalid`, `project_not_found`, `forbidden`, `project_archived`) applies unchanged.

The endpoint SHALL delegate to the same `MemoryService.search()` path used by the MCP `memory.search` tool, with the project scope resolved from the path slug, so ranking (including any hybrid-search boost) is identical to the MCP-facing search. It searches the path-scoped project only; no argument on this endpoint widens the result set past it, and none is accepted. On success the server SHALL respond `200 OK` with body `{ ok: true, memories: [{ id: string, title: string, snippet: string }], formatted: string }`, where `memories` mirrors the ranked `memory.search` results (title + a content snippet capped the same way other context snippets are capped) and `formatted` is a ready-to-inject string of the shape `<memory-context>\n<one line per memory: "- {title}: {snippet}">\n</memory-context>`, or the empty string when `memories` is empty.

This endpoint SHALL NOT be exposed to any client other than the Hermes provider in this revision; it carries no client-identifying restriction at the HTTP layer (any valid token scoped to the slug may call it), but no other client's plugin code calls it yet.

#### Scenario: A successful recall returns ranked memories and a formatted block

- **GIVEN** a project with several `active` memories, at least one matching the query lexically or semantically
- **WHEN** a client POSTs `{ "query": "how do we handle auth tokens" }` to `/api/<slug>/memory/recall` with a valid token scoped to that slug
- **THEN** the response SHALL be `200 OK` with `ok: true`, a `memories` array ordered by the same ranking `memory.search` would produce for that query, and a non-empty `formatted` string when `memories` is non-empty

#### Scenario: No matching memories yields an empty formatted block

- **GIVEN** a project with no memories matching the query
- **WHEN** a client POSTs a query to `/api/<slug>/memory/recall`
- **THEN** the response SHALL be `200 OK` with `memories: []` and `formatted: ""`

#### Scenario: limit is clamped

- **WHEN** a client POSTs `{ "query": "...", "limit": 50 }`
- **THEN** the server SHALL clamp the effective limit to 5 rather than reject the request

#### Scenario: Missing query is rejected

- **WHEN** a client POSTs a body without a `query` field, or with an empty string
- **THEN** the server SHALL respond with a `400`-class validation error and SHALL NOT execute a search

#### Scenario: Auth and scope errors match the existing `/api/<slug>/*` contract

- **WHEN** a client POSTs to `/api/<slug>/memory/recall` without a valid bearer token, or with a token scoped to a different project, or against an unknown or archived slug
- **THEN** the response SHALL match the corresponding scenario already specified for `POST /api/<slug>/sessions` (401 `missing_token`/`token_invalid`, 403 `forbidden`, 404 `project_not_found`, 403 `project_archived`)

#### Scenario: No result comes from outside the path-scoped project

- **GIVEN** memories in the path-scoped project and memories in the default project sharing the query's vocabulary
- **WHEN** a client POSTs a query to `/api/<slug>/memory/recall`
- **THEN** every returned memory SHALL belong to the path-scoped project
