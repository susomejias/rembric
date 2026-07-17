## MODIFIED Requirements

### Requirement: `POST /api/<slug>/sessions/:id/summary` MUST write a summary and close the session

The endpoint SHALL accept a JSON body `{ summary: string, title?: string, final?: boolean }`. The `summary` field SHALL be a non-empty string (length ≥1); the `title` field, when present, SHALL be non-empty (length ≥1). The `final` field SHALL default to `false`.

The HTTP path is used by non-interactive writers (bash / Python / opencode hook scripts) that cannot react to an `invalid_input` rejection. Therefore, for the length-bounded fields, the endpoint SHALL **truncate, never reject by length**:

- The server MAY keep a wire-level DoS guard, but that guard SHALL have enough margin that a body which respects the plugins' own character cap can never be rejected by it. Specifically: because plugins truncate by Unicode **code points** while the server measures string length in **UTF-16 code units**, a `summary` of up to the plugins' code-point cap can measure up to ~2× that many UTF-16 units. The wire guard (if expressed as a character `max`) SHALL therefore sit at ≥ that worst-case expansion (or be delegated to the request body-size bound), so a compliant plugin body is NEVER rejected via the code-point↔UTF-16 mismatch. A `summary` at exactly the plugins' code-point cap that contains characters outside the BMP (e.g. emoji) SHALL be accepted and truncated, NOT rejected.
- Before the service-layer call, the handler SHALL apply server-side truncation to `summary`: if `summary.length > SUMMARY_MAX_CHARS`, replace it with `summary.slice(0, SUMMARY_MAX_CHARS - SUFFIX.length) + '…[truncated]'` (`SUFFIX = '…[truncated]'`, length 13 in JavaScript code units). The cut point SHALL NOT split a UTF-16 surrogate pair: if the character immediately before the cut is a high surrogate, the cut SHALL back off by one further code unit, dropping the whole trailing character rather than leaving an unpaired surrogate (which downstream storage can corrupt). The written length SHALL be exactly `SUMMARY_MAX_CHARS` when truncation fires, EXCEPT in the rare case where the surrogate-pair back-off applies, in which case it SHALL be `SUMMARY_MAX_CHARS - 1`.
- Before the service-layer call, the handler SHALL apply server-side truncation to `title` when present: if `title.length > TITLE_MAX_LENGTH` (100), the handler SHALL hard-cut it to `TITLE_MAX_LENGTH` UTF-16 units before calling `agentSessions.writeSummary`, applying the same surrogate-pair back-off as `summary` (so the result may be `TITLE_MAX_LENGTH - 1` in that rare case). An over-length `title` SHALL NOT produce `invalid_input` on the HTTP path.

Both truncations are silent at the HTTP boundary (response status remains `200 OK` and the truncated values are echoed back) — the summary suffix is the operator-visible signal. (The MCP path, `memory.session_summary`, is the interactive counterpart and CONTINUES to reject over-cap input so the agent can retry.)

The endpoint SHALL first check that the connected token's scope authorizes `write` on the connected project (the same `isAuthorized` check the sibling `POST /api/<slug>/sessions` and `/api/<slug>/memory/recall` routes apply), rejecting with `403 forbidden` before touching the session row. The server SHALL then resolve the session by `(token_id, project_id, id)` — a token-id mismatch OR a project-id mismatch (the session belongs to a different project than the one the request is connected to) SHALL surface identically as `session_not_found`, so the response never confirms whether a session with that id exists under a different project. When the resolved row's `deleted_at IS NOT NULL`, the call SHALL be rejected with `session_deleted`.

For each provided field, the server SHALL apply the precedence rule:

- If `final` in body is `true`: write the field, set the `*_final` column to `true`, overwriting any prior value (last-final-wins).
- If `final` in body is `false` (or omitted) AND the row's `*_final` column is `false`: write the field, leave `*_final` unchanged.
- If `final` in body is `false` AND the row's `*_final` column is `true`: silently skip writing this field.

The endpoint SHALL NOT modify `status`, `ended_at`, or any other column. Successful response: `{ ok: true, sessionId, summary, title, summaryFinal, titleFinal }`.

Calls on an `ended` or `abandoned` session SHALL be rejected with `session_already_ended` and SHALL NOT mutate the row.

#### Scenario: Non-final summary write on an active session with no prior summary

- **WHEN** a client POSTs `{ summary: 'raw transcript', title: 'Fix bug' }` to `/api/foo/sessions/<S>/summary` on an active row whose `summary` is null and `summary_final` is `false` and `summary.length <= SUMMARY_MAX_CHARS`
- **THEN** the row SHALL have `summary = 'raw transcript'`, `title = 'Fix bug'`, `summary_final = false`, `title_final = false`
- **AND** `status` SHALL remain `'active'`
- **AND** the response SHALL be `{ ok: true, sessionId, summary, title, summaryFinal: false, titleFinal: false }`

#### Scenario: Oversized summary is truncated server-side

- **GIVEN** an active session row with `summary_final = false`
- **WHEN** a client POSTs `{ summary: 'A'.repeat(SUMMARY_MAX_CHARS + 2000) }` to `/api/foo/sessions/<S>/summary`
- **THEN** the response SHALL be `200 OK` (NOT an error)
- **AND** the row's `summary` SHALL be of length exactly `SUMMARY_MAX_CHARS`
- **AND** the row's `summary` SHALL end with the literal suffix `…[truncated]`
- **AND** the response body's `summary` field SHALL echo the truncated value

#### Scenario: Emoji summary at the code-point cap is truncated, not rejected (UTF-16 mismatch)

- **GIVEN** an active session row with `summary_final = false`
- **WHEN** a client POSTs a `summary` whose Unicode code-point count equals the plugins' truncation cap but whose UTF-16 `.length` exceeds it because it contains characters outside the BMP (e.g. a transcript ending in emoji)
- **THEN** the response SHALL be `200 OK` and the summary SHALL be persisted (at most `SUMMARY_MAX_CHARS` UTF-16 units, per the truncation rule above)
- **AND** the server SHALL NOT respond `400 invalid_input` for that body

#### Scenario: Truncation never splits a surrogate pair

- **GIVEN** an active session row
- **WHEN** a client POSTs a `summary` (or `title`) whose truncation cut point would otherwise land between the two UTF-16 code units of a single character outside the BMP (e.g. an emoji)
- **THEN** the handler SHALL back the cut off by one further code unit, dropping the whole character rather than persisting an unpaired surrogate
- **AND** the persisted value SHALL NOT contain an unpaired surrogate (which downstream storage can otherwise corrupt into multiple garbage characters on read-back)

#### Scenario: Oversized title is truncated server-side, not rejected

- **GIVEN** an active session row
- **WHEN** a client POSTs `{ summary: '…', title: 'A'.repeat(150) }` (or a 100-code-point title whose UTF-16 length exceeds 100 via emoji)
- **THEN** the response SHALL be `200 OK`
- **AND** the persisted `title` SHALL be at most `TITLE_MAX_LENGTH` (100) UTF-16 units
- **AND** the server SHALL NOT respond `400 invalid_input` for the title length

#### Scenario: Wire body-size guard still applies

- **WHEN** a client POSTs a body far beyond any plausible transcript (e.g. exceeding the authenticated-surface request body-size bound)
- **THEN** the server SHALL still reject it at the transport/DoS boundary — the truncate-don't-reject rule covers plausible transcript overflow, not unbounded payloads

#### Scenario: Final write blocks later non-final write

- **GIVEN** session `<S>` whose `summary_final` is `true` (written by `memory.session_summary`)
- **WHEN** a client POSTs `{ summary: 'newer raw transcript', final: false }`
- **THEN** the row's `summary` SHALL remain unchanged
- **AND** the response SHALL still be `200 OK` (silent skip is success, not error)

#### Scenario: Empty summary

- **WHEN** a client POSTs `{ summary: '' }` or `{ summary: '   ' }`
- **THEN** the server SHALL respond `400` with `{ ok: false, code: 'invalid_input' }` and SHALL NOT mutate the row

#### Scenario: Session not found / wrong token

- **WHEN** a client POSTs to `/api/foo/sessions/never-existed/summary` OR to a session id owned by a different token
- **THEN** the server SHALL respond `404` with `{ ok: false, code: 'session_not_found' }`

#### Scenario: Session belongs to a different project than the connected slug

- **GIVEN** a session `<S>` whose `project_id` is project `P`, owned by token `T`, where `P` has since been archived
- **WHEN** token `T` POSTs to `/api/<other-non-archived-slug>/sessions/<S>/summary` (a slug resolving to a project other than `P`)
- **THEN** the server SHALL respond `404` with `{ ok: false, code: 'session_not_found' }` — identical to the wrong-token case
- **AND** the row SHALL NOT be mutated
- **AND** this SHALL hold even though `T` is authenticated and owns `<S>`, because the archived-project write-freeze must not be bypassable by connecting through an unrelated slug

#### Scenario: Token lacks write authorization for the connected project

- **WHEN** a token whose scope does not cover project `P` POSTs to `/api/<P-slug>/sessions/<any-id>/summary`
- **THEN** the server SHALL respond `403` with `{ ok: false, code: 'forbidden' }` before resolving the session

#### Scenario: Session already ended

- **WHEN** a client POSTs a summary for a row whose `status = 'ended'` or `'abandoned'`
- **THEN** the server SHALL respond `409` with `{ ok: false, code: 'session_already_ended' }` and SHALL NOT mutate the row

#### Scenario: Session soft-deleted

- **WHEN** a client POSTs a summary for a row whose `deleted_at IS NOT NULL`
- **THEN** the server SHALL respond `409` with `{ ok: false, code: 'session_deleted' }`

### Requirement: `POST /api/<slug>/sessions/:id/end` MUST close a session without a summary

The endpoint SHALL accept a JSON body `{ summary?: string, title?: string, final?: boolean }`. All fields are optional; an empty body `{}` is valid. The same truncate-never-reject-by-length rule as `/summary` applies to `summary` and `title` when provided: the wire DoS guard has margin over the plugins' code-point cap (or is delegated to the request body-size bound), and the handler truncates `summary` (to `SUMMARY_MAX_CHARS`) and `title` (to `TITLE_MAX_LENGTH`) server-side rather than returning `invalid_input`. The same `final` precedence rules as `/summary` apply.

Before the service-layer call, the handler SHALL apply server-side truncation to `summary` (identical to `/summary`) and to `title` when present, then call `agentSessions.end`. The response remains `200 OK` with the truncated values echoed back.

The endpoint SHALL first check that the connected token's scope authorizes `write` on the connected project (the same `isAuthorized` check the sibling `POST /api/<slug>/sessions` and `/api/<slug>/memory/recall` routes apply), rejecting with `403 forbidden` before touching the session row. The server SHALL then resolve the session by `(token_id, project_id, id)` — a token-id mismatch OR a project-id mismatch SHALL surface identically as `session_not_found` — and, when active, atomically:

1. Apply any provided summary/title writes subject to the precedence rules (after the truncation helpers have run).
2. Set `ended_at = now` and `status = 'ended'`.

Soft-deleted rows SHALL be rejected with `session_deleted`. Already-ended rows SHALL be treated as an idempotent no-op: any summary/title fields in the body are still applied subject to precedence (with truncation), but `ended_at` and `status` SHALL NOT be re-written. The response SHALL be `{ ok: true, sessionId, endedAt, summary, title }`.

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

#### Scenario: Session not found / wrong token / deleted

- **WHEN** the resolution rules apply
- **THEN** the server SHALL respond with the same error codes (`session_not_found`, `session_deleted`)

#### Scenario: Session belongs to a different project than the connected slug (archived-project bypass)

- **GIVEN** a session `<S>` whose `project_id` is project `P`, owned by token `T`, where `P` has since been archived
- **WHEN** token `T` POSTs to `/api/<other-non-archived-slug>/sessions/<S>/end`
- **THEN** the server SHALL respond `404` with `{ ok: false, code: 'session_not_found' }`
- **AND** the row SHALL NOT be mutated (status remains whatever it was, `ended_at` is not set)

#### Scenario: Token lacks write authorization for the connected project

- **WHEN** a token whose scope does not cover project `P` POSTs to `/api/<P-slug>/sessions/<any-id>/end`
- **THEN** the server SHALL respond `403` with `{ ok: false, code: 'forbidden' }` before resolving the session
