## MODIFIED Requirements

### Requirement: `POST /api/<slug>/sessions` MUST create or upsert a session by client-provided id

The endpoint SHALL accept a JSON body `{ id: string, cwd?: string, agent?: string, description?: string }`. The `id` field is REQUIRED and SHALL match the regex `^[A-Za-z0-9_-]{8,128}$`. On a request whose `(token_id, id)` tuple does not yet exist, the server SHALL insert a new `agent_sessions` row with `status='active'`, `started_at=now`, the resolved `project_id` from the path slug, the provided `agent`/`description` (default `agent='unknown'`), and a placeholder `title` of the form `basename(cwd) · HH:MM UTC` (or `session · HH:MM UTC` if `cwd` is omitted/unparseable) with `title_final = false`. On a request whose `(token_id, id)` tuple already exists, the server SHALL return the existing row unchanged (idempotent ensure-session pattern, safe for hook re-fires).

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
