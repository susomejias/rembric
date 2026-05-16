## MODIFIED Requirements

### Requirement: `POST /api/<slug>/sessions` MUST create or upsert a session by client-provided id

The endpoint SHALL accept a JSON body `{ id: string, cwd?: string, agent?: string, description?: string }`. The `id` field is REQUIRED and SHALL match the regex `^[A-Za-z0-9_-]{8,128}$`. On a request whose `(token_id, id)` tuple does not yet exist, the server SHALL insert a new `agent_sessions` row with `status='active'`, `started_at=now`, the resolved `project_id` from the path slug, the provided `agent`/`description` (default `agent='unknown'`), and a placeholder `title` of the form `basename(cwd) · HH:MM UTC` (or `session · HH:MM UTC` if `cwd` is omitted/unparseable) with `title_final = false`. On a request whose `(token_id, id)` tuple already exists, the server SHALL return the existing row unchanged (idempotent ensure-session pattern, safe for hook re-fires).

The server SHALL respond `200 OK` on both insert and upsert paths with body `{ ok: true, sessionId: <id>, scope: 'project'|'global', projectId: string|null, startedAt: string, title: string, created: boolean }`. The `created` field SHALL be `true` for fresh inserts, `false` for idempotent hits.

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

### Requirement: `POST /api/<slug>/sessions/:id/summary` MUST write summary/title without transitioning status

The endpoint SHALL accept a JSON body `{ summary: string, title?: string, final?: boolean }`. The `summary` field SHALL be a string of length ≥1 and ≤20,000 chars. The `title` field SHALL be a string of length ≤100 chars (when present, length ≥1). The `final` field SHALL default to `false`.

The server SHALL resolve the session by `(token_id, id)` — token-mismatch SHALL surface as `session_not_found`. When the resolved row's `deleted_at IS NOT NULL`, the call SHALL be rejected with `session_deleted`.

For each provided field, the server SHALL apply the precedence rule:
- If `final` in body is `true`: write the field, set the `*_final` column to `true`, overwriting any prior value (last-final-wins).
- If `final` in body is `false` (or omitted) AND the row's `*_final` column is `false`: write the field, leave `*_final` unchanged.
- If `final` in body is `false` AND the row's `*_final` column is `true`: silently skip writing this field.

The endpoint SHALL NOT modify `status`, `ended_at`, or any other column. Successful response: `{ ok: true, sessionId, summary, title, summaryFinal, titleFinal }`.

Calls on an `ended` or `abandoned` session SHALL be rejected with `session_already_ended` and SHALL NOT mutate the row.

#### Scenario: Non-final summary write on an active session with no prior summary

- **WHEN** a client POSTs `{ summary: 'raw transcript', title: 'Fix bug' }` to `/api/foo/sessions/<S>/summary` on an active row whose `summary` is null and `summary_final` is `false`
- **THEN** the row SHALL have `summary = 'raw transcript'`, `title = 'Fix bug'`, `summary_final = false`, `title_final = false`
- **AND** `status` SHALL remain `'active'`
- **AND** the response SHALL be `{ ok: true, sessionId, summary, title, summaryFinal: false, titleFinal: false }`

#### Scenario: Final write blocks later non-final write

- **GIVEN** session `<S>` whose `summary_final` is `true` (written by `memory.session_summary`)
- **WHEN** a client POSTs `{ summary: 'newer raw transcript', final: false }`
- **THEN** the row's `summary` SHALL remain unchanged
- **AND** the response SHALL still be `200 OK` (silent skip is success, not error)

#### Scenario: Empty summary

- **WHEN** a client POSTs `{ summary: '' }` or `{ summary: '   ' }`
- **THEN** the server SHALL respond `400` with `{ ok: false, code: 'invalid_input' }` and SHALL NOT mutate the row

#### Scenario: Title too long

- **WHEN** a client POSTs `{ summary: '…', title: 'A'.repeat(101) }`
- **THEN** the server SHALL respond `400` with `{ ok: false, code: 'invalid_input' }`

#### Scenario: Session not found / wrong token

- **WHEN** a client POSTs to `/api/foo/sessions/never-existed/summary` OR to a session id owned by a different token
- **THEN** the server SHALL respond `404` with `{ ok: false, code: 'session_not_found' }`

#### Scenario: Session already ended

- **WHEN** a client POSTs a summary for a row whose `status = 'ended'` or `'abandoned'`
- **THEN** the server SHALL respond `409` with `{ ok: false, code: 'session_already_ended' }` and SHALL NOT mutate the row

#### Scenario: Session soft-deleted

- **WHEN** a client POSTs a summary for a row whose `deleted_at IS NOT NULL`
- **THEN** the server SHALL respond `409` with `{ ok: false, code: 'session_deleted' }`

### Requirement: `POST /api/<slug>/sessions/:id/end` MUST close a session and optionally write summary/title

The endpoint SHALL accept a JSON body `{ summary?: string, title?: string, final?: boolean }`. All fields are optional; an empty body `{}` is valid. The same length and `final` precedence rules as `/summary` apply when those fields are provided.

The server SHALL resolve the session by `(token_id, id)` and, when active, atomically:
1. Apply any provided summary/title writes subject to the precedence rules.
2. Set `ended_at = now` and `status = 'ended'`.

Soft-deleted rows SHALL be rejected with `session_deleted`. Already-ended rows SHALL be treated as an idempotent no-op: any summary/title fields in the body are still applied subject to precedence, but `ended_at` and `status` SHALL NOT be re-written. The response SHALL be `{ ok: true, sessionId, endedAt, summary, title }`.

#### Scenario: Active session closed with no body

- **WHEN** a client POSTs `{}` to `/api/foo/sessions/<S>/end` on an active row
- **THEN** the server SHALL set `status='ended'`, `ended_at=now`, leave `summary`/`title` unchanged, and respond `{ ok: true, sessionId, endedAt, summary: <prior>, title: <prior> }`

#### Scenario: Active session closed atomically with summary and title

- **WHEN** a client POSTs `{ summary: 'raw transcript', title: 'Refactor auth', final: false }` to `/end` on an active row with no prior summary
- **THEN** the server SHALL write summary and title (both `_final = false`), set `status='ended'`, set `ended_at=now` — in a single transaction
- **AND** the response SHALL include the written values

#### Scenario: End on already-ended session with new summary (write-once protected)

- **GIVEN** session `<S>` is `ended` with `summary_final = true`
- **WHEN** a client POSTs `{ summary: 'newer transcript', final: false }` to `/end`
- **THEN** the server SHALL respond `200 OK` with the unchanged row
- **AND** `summary`, `status`, `ended_at` SHALL all remain unchanged (idempotent end, summary write blocked by precedence)

#### Scenario: End on already-ended session with no summary, fallback fills it

- **GIVEN** session `<S>` is `ended` with `summary = null`, `summary_final = false`
- **WHEN** a client POSTs `{ summary: 'transcript', final: false }` to `/end` (e.g. a delayed bash hook race after Hermes already ended)
- **THEN** the server SHALL write the summary (`_final = false`), leave `ended_at`/`status` unchanged
- **AND** the response SHALL be `200 OK` with the now-non-null summary

#### Scenario: Session not found / wrong token / deleted

- **WHEN** the resolution rules apply
- **THEN** the server SHALL respond with the same error codes (`session_not_found`, `session_deleted`)
