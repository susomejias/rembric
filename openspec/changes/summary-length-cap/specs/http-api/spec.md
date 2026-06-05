## MODIFIED Requirements

### Requirement: `POST /api/<slug>/sessions/:id/summary` MUST write a summary and close the session

The endpoint SHALL accept a JSON body `{ summary: string, title?: string, final?: boolean }`. The `summary` field SHALL be a string of length ≥1 and ≤20,000 chars at the zod transport boundary (kept as a wire DoS guard, distinct from the effective service-layer cap). The `title` field SHALL be a string of length ≤100 chars (when present, length ≥1). The `final` field SHALL default to `false`.

Before the service-layer call, the handler SHALL apply server-side truncation: if `summary.length > SUMMARY_MAX_CHARS` (2000), the handler SHALL replace `summary` with `summary.slice(0, SUMMARY_MAX_CHARS - SUFFIX.length) + '…[truncated]'` (where `SUFFIX = '…[truncated]'`, length 13 in JavaScript code units) before calling `agentSessions.writeSummary`. The resulting written length SHALL be exactly `SUMMARY_MAX_CHARS` when truncation fired. This truncation is silent at the HTTP boundary (response status remains `200 OK` and the truncated value is echoed back in the response body) because the HTTP clients are hook scripts (bash / Python / opencode plugin) that cannot react to an error — the suffix is the operator-visible signal.

The server SHALL resolve the session by `(token_id, id)` — token-mismatch SHALL surface as `session_not_found`. When the resolved row's `deleted_at IS NOT NULL`, the call SHALL be rejected with `session_deleted`.

For each provided field, the server SHALL apply the precedence rule:

- If `final` in body is `true`: write the field, set the `*_final` column to `true`, overwriting any prior value (last-final-wins).
- If `final` in body is `false` (or omitted) AND the row's `*_final` column is `false`: write the field, leave `*_final` unchanged.
- If `final` in body is `false` AND the row's `*_final` column is `true`: silently skip writing this field.

The endpoint SHALL NOT modify `status`, `ended_at`, or any other column. Successful response: `{ ok: true, sessionId, summary, title, summaryFinal, titleFinal }`.

Calls on an `ended` or `abandoned` session SHALL be rejected with `session_already_ended` and SHALL NOT mutate the row.

#### Scenario: Non-final summary write on an active session with no prior summary

- **WHEN** a client POSTs `{ summary: 'raw transcript', title: 'Fix bug' }` to `/api/foo/sessions/<S>/summary` on an active row whose `summary` is null and `summary_final` is `false` and `summary.length <= 2000`
- **THEN** the row SHALL have `summary = 'raw transcript'`, `title = 'Fix bug'`, `summary_final = false`, `title_final = false`
- **AND** `status` SHALL remain `'active'`
- **AND** the response SHALL be `{ ok: true, sessionId, summary, title, summaryFinal: false, titleFinal: false }`

#### Scenario: Oversized summary is truncated server-side

- **GIVEN** an active session row with `summary_final = false`
- **WHEN** a client POSTs `{ summary: 'A'.repeat(5000) }` to `/api/foo/sessions/<S>/summary`
- **THEN** the response SHALL be `200 OK` (NOT an error)
- **AND** the row's `summary` SHALL be of length exactly 2000
- **AND** the row's `summary` SHALL end with the literal suffix `…[truncated]`
- **AND** the response body's `summary` field SHALL echo the truncated value

#### Scenario: Wire-DoS guard at 20,001 chars

- **WHEN** a client POSTs `{ summary: 'A'.repeat(20001) }` (one char over the wire upper bound)
- **THEN** the server SHALL respond `400` with `{ ok: false, code: 'invalid_input' }` at the zod boundary, before the truncation helper runs

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

### Requirement: `POST /api/<slug>/sessions/:id/end` MUST close a session without a summary

The endpoint SHALL accept a JSON body `{ summary?: string, title?: string, final?: boolean }`. All fields are optional; an empty body `{}` is valid. The same wire-DoS bound (`summary` length ≤20,000 chars at the zod boundary) and the same `final` precedence rules as `/summary` apply when those fields are provided.

Before the service-layer call, the handler SHALL apply server-side truncation to the `summary` field, identical to `/summary`: when `summary` is present and `summary.length > SUMMARY_MAX_CHARS` (2000), the handler SHALL replace it with `summary.slice(0, SUMMARY_MAX_CHARS - SUFFIX.length) + '…[truncated]'` before calling `agentSessions.end`. The response remains `200 OK` with the truncated value echoed back.

The server SHALL resolve the session by `(token_id, id)` and, when active, atomically:

1. Apply any provided summary/title writes subject to the precedence rules (after the truncation helper has run on `summary`).
2. Set `ended_at = now` and `status = 'ended'`.

Soft-deleted rows SHALL be rejected with `session_deleted`. Already-ended rows SHALL be treated as an idempotent no-op: any summary/title fields in the body are still applied subject to precedence (with truncation), but `ended_at` and `status` SHALL NOT be re-written. The response SHALL be `{ ok: true, sessionId, endedAt, summary, title }`.

#### Scenario: Active session closed with no body

- **WHEN** a client POSTs `{}` to `/api/foo/sessions/<S>/end` on an active row
- **THEN** the server SHALL set `status='ended'`, `ended_at=now`, leave `summary`/`title` unchanged, and respond `{ ok: true, sessionId, endedAt, summary: <prior>, title: <prior> }`

#### Scenario: Active session closed atomically with summary and title

- **WHEN** a client POSTs `{ summary: 'raw transcript', title: 'Refactor auth', final: false }` to `/end` on an active row with no prior summary, with `summary.length <= 2000`
- **THEN** the server SHALL write summary and title (both `_final = false`), set `status='ended'`, set `ended_at=now` — in a single transaction
- **AND** the response SHALL include the written values

#### Scenario: Active session closed with an oversized summary is truncated server-side

- **GIVEN** an active session row with `summary_final = false`
- **WHEN** a client POSTs `{ summary: 'A'.repeat(5000), final: false }` to `/end`
- **THEN** the response SHALL be `200 OK`
- **AND** the row's `summary` SHALL be of length exactly 2000 with the literal suffix `…[truncated]`
- **AND** `status` SHALL be `'ended'` and `ended_at` SHALL be set

#### Scenario: End on already-ended session with new summary (write-once protected)

- **GIVEN** session `<S>` is `ended` with `summary_final = true`
- **WHEN** a client POSTs `{ summary: 'newer transcript', final: false }` to `/end`
- **THEN** the server SHALL respond `200 OK` with the unchanged row
- **AND** `summary`, `status`, `ended_at` SHALL all remain unchanged (idempotent end, summary write blocked by precedence)

#### Scenario: End on already-ended session with no summary, fallback fills it

- **GIVEN** session `<S>` is `ended` with `summary = null`, `summary_final = false`
- **WHEN** a client POSTs `{ summary: 'transcript', final: false }` to `/end` (e.g. a delayed bash hook race after Hermes already ended)
- **THEN** the server SHALL write the summary (`_final = false`, subject to the truncation helper), leave `ended_at`/`status` unchanged
- **AND** the response SHALL be `200 OK` with the now-non-null summary

#### Scenario: Session not found / wrong token / deleted

- **WHEN** the resolution rules apply
- **THEN** the server SHALL respond with the same error codes (`session_not_found`, `session_deleted`)
