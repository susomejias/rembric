## MODIFIED Requirements

### Requirement: `POST /api/<slug>/sessions/:id/summary` MUST write a summary and close the session

The endpoint SHALL accept a JSON body `{ summary: string, title?: string }`. The `summary` field SHALL be a string of length ≥1 and ≤20,000 chars. The `title` field SHALL be a string of length ≤100 chars (when present, length ≥1). The body SHALL NOT contain a `final` field; the server SHALL treat all HTTP-path writes as `final:false` regardless of what the client sends. The `_final` flags (`summary_final` and `title_final`) SHALL only be lifted via the MCP tool `memory.session_summary`, which hard-codes `final:true` in its server-side handler.

The server SHALL resolve the session by `(token_id, id)` — token-mismatch SHALL surface as `session_not_found`. When the resolved row's `deleted_at IS NOT NULL`, the call SHALL be rejected with `session_deleted`.

For each provided field, the server SHALL apply the precedence rule (with `final` forced to `false`):

- If the row's `*_final` column is `false`: write the field, leave `*_final` unchanged (stays `false`).
- If the row's `*_final` column is `true`: silently skip writing this field (the curated value wins; the HTTP write cannot overwrite).

The endpoint SHALL NOT modify `status`, `ended_at`, or any other column. Successful response: `{ ok: true, sessionId, summary, title, summaryFinal, titleFinal }`.

Calls on an `ended` or `abandoned` session SHALL be rejected with `session_already_ended` and SHALL NOT mutate the row.

#### Scenario: Non-final summary write on an active session with no prior summary

- **WHEN** a client POSTs `{ summary: 'raw transcript', title: 'Fix bug' }` to `/api/foo/sessions/<S>/summary` on an active row whose `summary` is null and `summary_final` is `false`
- **THEN** the row SHALL have `summary = 'raw transcript'`, `title = 'Fix bug'`, `summary_final = false`, `title_final = false`
- **AND** `status` SHALL remain `'active'`
- **AND** the response SHALL be `{ ok: true, sessionId, summary, title, summaryFinal: false, titleFinal: false }`

#### Scenario: Curated summary blocks later HTTP write

- **GIVEN** session `<S>` whose `summary_final` is `true` (written by `memory.session_summary`)
- **WHEN** a client POSTs `{ summary: 'newer raw transcript' }`
- **THEN** the row's `summary` SHALL remain unchanged
- **AND** the response SHALL still be `200 OK` (silent skip is success, not error)

#### Scenario: HTTP body cannot lift `_final` flags

- **WHEN** a client POSTs `{ summary: 'raw transcript', title: 'Fix bug', final: true }` to `/api/foo/sessions/<S>/summary` on an active row with both `_final` flags at `false`
- **THEN** the server SHALL ignore the `final` field in the body (zod schema does not validate it; the handler hard-codes `false`)
- **AND** the row SHALL have `summary_final = false` and `title_final = false` after the write
- **AND** the response SHALL be `{ ok: true, …, summaryFinal: false, titleFinal: false }`

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

### Requirement: `POST /api/<slug>/sessions/:id/end` MUST close a session without a summary

The endpoint SHALL accept a JSON body `{ summary?: string, title?: string }`. All fields are optional; an empty body `{}` is valid. The body SHALL NOT contain a `final` field; the server SHALL treat all HTTP-path writes as `final:false`. The same length rules as `/summary` apply when those fields are provided.

The server SHALL resolve the session by `(token_id, id)` and, when active, atomically:

1. Apply any provided summary/title writes subject to the precedence rule (with `final` forced to `false`).
2. Set `ended_at = now` and `status = 'ended'`.

Soft-deleted rows SHALL be rejected with `session_deleted`. Already-ended rows SHALL be treated as an idempotent no-op: any summary/title fields in the body are still applied subject to precedence, but `ended_at` and `status` SHALL NOT be re-written. The response SHALL be `{ ok: true, sessionId, endedAt, summary, title }`.

#### Scenario: Active session closed with no body

- **WHEN** a client POSTs `{}` to `/api/foo/sessions/<S>/end` on an active row
- **THEN** the server SHALL set `status='ended'`, `ended_at=now`, leave `summary`/`title` unchanged, and respond `{ ok: true, sessionId, endedAt, summary: <prior>, title: <prior> }`

#### Scenario: Active session closed atomically with summary and title

- **WHEN** a client POSTs `{ summary: 'raw transcript', title: 'Refactor auth' }` to `/end` on an active row with no prior summary
- **THEN** the server SHALL write summary and title (both `_final = false`), set `status='ended'`, set `ended_at=now` — in a single transaction
- **AND** the response SHALL include the written values

#### Scenario: End on already-ended session with new summary (write-once protected)

- **GIVEN** session `<S>` is `ended` with `summary_final = true`
- **WHEN** a client POSTs `{ summary: 'newer transcript' }` to `/end`
- **THEN** the server SHALL respond `200 OK` with the unchanged row
- **AND** `summary`, `status`, `ended_at` SHALL all remain unchanged (idempotent end, summary write blocked by precedence)

#### Scenario: HTTP body cannot lift `_final` flags on /end

- **WHEN** a client POSTs `{ summary: 'transcript', title: 'fallback title', final: true }` to `/end` on an active row with both `_final` flags at `false`
- **THEN** the server SHALL ignore the `final` field
- **AND** the row SHALL have `summary_final = false`, `title_final = false`, `status = 'ended'`, `ended_at = now`
