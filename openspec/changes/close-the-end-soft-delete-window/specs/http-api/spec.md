## MODIFIED Requirements

### Requirement: `POST /api/<slug>/sessions/:id/end` MUST close a session without a summary

The endpoint SHALL accept a JSON body `{ summary?: string, title?: string, final?: boolean }`. All fields are optional; an empty body `{}` is valid. The same truncate-never-reject-by-length rule as `/summary` applies to `summary` and `title` when provided: the wire DoS guard has margin over the plugins' code-point cap (or is delegated to the request body-size bound), and the handler truncates `summary` (to `SUMMARY_MAX_CHARS`) and `title` (to `TITLE_MAX_LENGTH`) server-side rather than returning `invalid_input`. The same `final` precedence rules as `/summary` apply.

Before the service-layer call, the handler SHALL apply server-side truncation to `summary` (identical to `/summary`) and to `title` when present, then call `agentSessions.end`. The response remains `200 OK` with the truncated values echoed back.

The endpoint SHALL first check that the connected token's scope authorizes `write` on the connected project (the same `isAuthorized` check the sibling `POST /api/<slug>/sessions` and `/api/<slug>/memory/recall` routes apply), rejecting with `403 forbidden` before touching the session row. The server SHALL then resolve the session by `(token_id, project_id, id)` — a token-id mismatch OR a project-id mismatch SHALL surface identically as `session_not_found` — and, when active, atomically:

1. Apply any provided summary/title writes subject to the precedence rules (after the truncation helpers have run).
2. Set `ended_at = now` and `status = 'ended'`.

Soft-deleted rows SHALL be rejected with `session_deleted`, and that rejection SHALL carry HTTP status `409` — the same status `/summary` already specifies for the identical condition — whether the code is produced by the handler's own pre-body gate or thrown by `agentSessions.end`. The handler's gate runs before the request body is awaited, so it is advisory; the binding evaluation is the service's, taken against the row it re-reads immediately before writing (see "Sessions MAY be soft-deleted while preserving the audit trail" in the `sessions` capability). A row soft-deleted after the gate passed but before the write SHALL therefore be rejected rather than mutated, on the active branch and the terminal branch alike, and SHALL NOT surface as `500`. Rows in **either** terminal state (`ended` or `abandoned`) SHALL be treated as an idempotent no-op with respect to lifecycle: any summary/title fields in the body are still applied subject to precedence (with truncation), but `status`, `ended_at` and `last_activity_at` SHALL NOT be re-written — in particular an `abandoned` row SHALL NOT be promoted to `ended`, because `ended_at` is write-once and the sweep's classification is the audit record of how the session died. `session_already_ended` SHALL NOT be a possible response code for this endpoint. The response SHALL be `{ ok: true, sessionId, endedAt, summary, title }`.

#### Scenario: Active session closed with no body

- **WHEN** a client POSTs `{}` to `/api/foo/sessions/<S>/end` on an active row
- **THEN** the server SHALL set `status='ended'`, `ended_at=now`, leave `summary`/`title` unchanged, and respond `{ ok: true, sessionId, endedAt, summary: <prior>, title: <prior> }`

#### Scenario: Active session closed atomically with summary and title

- **WHEN** a client POSTs `{ summary: 'raw transcript', title: 'Refactor auth', final: false }` to `/end` on an active row with no prior summary, with `summary.length <= SUMMARY_MAX_CHARS`
- **THEN** the server SHALL write summary and title (both `_final = false`), set `status='ended'`, set `ended_at=now` — in a single transaction
- **AND** the response SHALL include the written values

#### Scenario: Active session closed with an oversized summary is truncated server-side

- **GIVEN** an active session row with `summary_final = false`
- **WHEN** a client POSTs `{ summary: 'A'.repeat(SUMMARY_MAX_CHARS + 2000), final: false }` to `/end`
- **THEN** the response SHALL be `200 OK`
- **AND** the row's `summary` SHALL be of length exactly `SUMMARY_MAX_CHARS` with the literal suffix `…[truncated]`
- **AND** `status` SHALL be `'ended'` and `ended_at` SHALL be set

#### Scenario: End with an emoji summary/title at the code-point cap is truncated, not rejected

- **GIVEN** an active session row
- **WHEN** a client POSTs to `/end` a `summary` (and/or `title`) whose code-point count is within the plugins' cap but whose UTF-16 length exceeds the old wire/field cap because of characters outside the BMP
- **THEN** the response SHALL be `200 OK`, the session SHALL be ended, and the summary/title SHALL be persisted (truncated as needed)
- **AND** the server SHALL NOT respond `400 invalid_input`

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

#### Scenario: End on an abandoned session applies the summary without promoting the status

- **GIVEN** session `<S>` is `abandoned` with `ended_at = E`, `last_activity_at = L`, `summary = null`, `summary_final = false`
- **WHEN** a client POSTs `{ summary: 'transcript', title: 'Fix the reaper', final: false }` to `/end`
- **THEN** the server SHALL respond `200 OK` with the written summary and title
- **AND** `status` SHALL remain `'abandoned'`, `ended_at` SHALL remain `E`, and `last_activity_at` SHALL remain `L`
- **AND** the server SHALL NOT respond `409 session_already_ended`

#### Scenario: Session not found / wrong token / deleted

- **WHEN** the resolution rules apply
- **THEN** the server SHALL respond with the same error codes (`session_not_found`, `session_deleted`)
- **AND** `session_not_found` SHALL carry status `404` and `session_deleted` SHALL carry status `409`

#### Scenario: Session soft-deleted after the gate but before the write

- **GIVEN** an `active` session `<S>` whose `deleted_at` is NULL when the handler's soft-delete gate runs
- **WHEN** `<S>` is soft-deleted (e.g. from the dashboard) while the handler is still awaiting the request body, and the body then completes
- **THEN** the server SHALL respond `409` with `{ ok: false, code: 'session_deleted' }`
- **AND** the row SHALL NOT be mutated: `status` SHALL remain `'active'`, `ended_at` SHALL remain NULL, and `summary`/`title` SHALL be unchanged
- **AND** when `<S>`'s status is `ended` or `abandoned` instead, the response SHALL likewise be `409` and NOT `500`

#### Scenario: Session belongs to a different project than the connected slug (archived-project bypass)

- **GIVEN** a session `<S>` whose `project_id` is project `P`, owned by token `T`, where `P` has since been archived
- **WHEN** token `T` POSTs to `/api/<other-non-archived-slug>/sessions/<S>/end`
- **THEN** the server SHALL respond `404` with `{ ok: false, code: 'session_not_found' }`
- **AND** the row SHALL NOT be mutated (status remains whatever it was, `ended_at` is not set)

#### Scenario: Token lacks write authorization for the connected project

- **WHEN** a token whose scope does not cover project `P` POSTs to `/api/<P-slug>/sessions/<any-id>/end`
- **THEN** the server SHALL respond `403` with `{ ok: false, code: 'forbidden' }` before resolving the session
