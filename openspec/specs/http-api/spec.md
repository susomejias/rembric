# http-api Specification

## Purpose

Defines Rembric's non-MCP HTTP session-lifecycle API at `/api`. The API is mounted in the Hono app sibling to `/mcp`, `/dashboard`, `/admin`, and `/healthz`, and is path-scoped on project slug so cross-scope leakage is impossible by construction. It exists so external surfaces (Claude Code hooks, Codex hooks, future integrations) can register, summarize, and close `agent_sessions` rows without speaking the MCP wire protocol. Sessions registered via this API are integrated with the MCP `SessionRouter` fallback so subsequent `memory.save` calls attach `session_id` automatically.

## Requirements

### Requirement: The server MUST expose an HTTP session-lifecycle API at `/api`

The Rembric server SHALL expose a non-MCP HTTP API mounted in the Hono app at the `/api` prefix, sibling to `/mcp`, `/dashboard`, `/admin`, and `/healthz`. The API SHALL be path-scoped on project slug: `POST /api/<slug>/sessions(*)` operations resolve scope via the same `authenticate({pathSlug})` helper used by `/mcp/<slug>` so cross-scope leakage is impossible by construction. Authentication SHALL use the same `Authorization: Bearer <token>` mechanism as `/mcp` — any token with scope covering the requested slug is accepted (admin tokens with `scope='*'` are honored as on `/mcp/<slug>`).

#### Scenario: Request without Authorization header

- **WHEN** a client POSTs to `/api/<slug>/sessions` without an `Authorization` header
- **THEN** the server SHALL respond `401` with body `{ ok: false, code: 'missing_token', message }`

#### Scenario: Request with an unrecognized bearer token

- **WHEN** a client POSTs with `Authorization: Bearer <unknown>`
- **THEN** the server SHALL respond `401` with body `{ ok: false, code: 'token_invalid', message }`

#### Scenario: Path slug does not resolve to a project

- **WHEN** a client POSTs to `/api/unknown-slug/sessions` with a valid token
- **THEN** the server SHALL respond `404` with body `{ ok: false, code: 'project_not_found', slug: 'unknown-slug' }`

#### Scenario: Token is project-scoped to a different project

- **WHEN** a client with a token scoped to project `foo` POSTs to `/api/bar/sessions`
- **THEN** the server SHALL respond `403` with body `{ ok: false, code: 'forbidden', message }`

#### Scenario: Path slug resolves to an archived project

- **WHEN** a client POSTs to `/api/<archived-slug>/sessions`
- **THEN** the server SHALL respond `403` with body `{ ok: false, code: 'project_archived', message }`

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

The endpoint SHALL accept the call **regardless of the row's `status`**. A row whose `status` is `ended` or `abandoned` SHALL be written exactly like an `active` one, subject to the same precedence rules, and SHALL NOT be rejected with `session_already_ended` — the terminal-row rule is stated once in the `sessions` capability ("Terminal session rows MUST accept late summary and title writes"). The stale-active retirement sweep can flip a still-live session to `abandoned` at any moment (24h default window, re-evaluated on every restart and every 30 minutes), so rejecting on `status` made the curated summary of a long-running conversation permanently unwritable. `session_already_ended` SHALL NOT be a possible response code for this endpoint.

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

#### Scenario: Summary write on an abandoned session succeeds

- **GIVEN** a row whose `status = 'abandoned'` with `ended_at = E` and `last_activity_at = L` (flipped by the retirement sweep while its client was still running), `summary_final = false`
- **WHEN** a client POSTs `{ summary: 'curated handoff', final: true }` to `/api/foo/sessions/<S>/summary`
- **THEN** the server SHALL respond `200 OK` with `{ ok: true, sessionId, summary: 'curated handoff', summaryFinal: true, … }`
- **AND** the row's `status` SHALL still be `'abandoned'`, `ended_at` SHALL still be `E`, and `last_activity_at` SHALL still be `L`

#### Scenario: Summary write on an ended session succeeds

- **GIVEN** a row whose `status = 'ended'` with `ended_at = E`, `summary_final = false`
- **WHEN** a client POSTs `{ summary: 'late transcript' }` to `/api/foo/sessions/<S>/summary`
- **THEN** the server SHALL respond `200 OK` and the summary SHALL be persisted
- **AND** `status` and `ended_at` SHALL be unchanged
- **AND** the server SHALL NOT respond `409 session_already_ended`

#### Scenario: A per-turn transcript sync on a terminal row does not clobber a curated summary

- **GIVEN** a row whose `status = 'abandoned'` with `summary_final = true`
- **WHEN** the `Stop`-hook transcript sync POSTs `{ summary: '<raw transcript>', final: false }` on every turn
- **THEN** each call SHALL respond `200 OK` and the row's `summary` SHALL remain the curated value
- **AND** no call SHALL respond `409` (the pre-change 409 was invisible to the hook, which suppresses output and exits 0)

#### Scenario: Session soft-deleted

- **WHEN** a client POSTs a summary for a row whose `deleted_at IS NOT NULL`
- **THEN** the server SHALL respond `409` with `{ ok: false, code: 'session_deleted' }`

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

### Requirement: Sessions registered via HTTP MUST integrate with the SessionRouter so subsequent MCP tools attach memories to them

When a session row is created via `POST /api/<slug>/sessions`, the server SHALL NOT eagerly populate the `SessionRouter` (the router is keyed by `(tokenId, mcpSessionId)` and the HTTP call has no `mcp-session-id`). Instead, the server SHALL ensure that MCP tool handlers — when resolving the active Rembric session for a request — fall back to the most-recently-active row in `agent_sessions` matching `(token_id, project_id)` whose `status = 'active'` when no `SessionRouter` entry exists.

This is the bridge that makes `memory.save` calls (issued by the agent over MCP) attach `session_id` to the row that the hook created via HTTP.

#### Scenario: Hook creates session over HTTP, agent saves memory over MCP

- **GIVEN** a client POSTs `{ id: 'sess-abc12345' }` to `/api/foo/sessions` (HTTP) and the session row is created
- **AND** the same agent then opens an MCP connection on `/mcp/foo` and calls `memory.save({ type: 'project', content: '...' })`
- **WHEN** the server resolves the active session for that save call
- **THEN** the resolution SHALL find `sess-abc12345` (most-recently-active for `(token_id, foo.id)`) and the saved memory's `session_id` SHALL equal `'sess-abc12345'`

#### Scenario: Multiple active sessions for the same (token, project)

- **GIVEN** two `status='active'` rows exist for `(token_id, foo.id)` (e.g. user has two Claude Code windows open)
- **WHEN** a memory save attaches via fallback resolution
- **THEN** the save SHALL attach to the row with the most recent `started_at`
- **AND** the older row's eventual `ended_at` / `summary` is unaffected

### Requirement: The server MUST expose a bearer-gated health endpoint at `/healthz`

The Rembric server SHALL expose `GET /healthz` as a bearer-gated availability probe, sibling to `/mcp`, `/api`, `/dashboard`, and `/admin`. The endpoint SHALL require `Authorization: Bearer <token>` using the same token-extraction and validation path as `/api`. Any token whose `scope` is recognised by `authenticate()` SHALL be accepted (including project-scoped tokens — availability is not a project-scoped concern). The endpoint SHALL NOT exempt itself from the rate limiter if the rate limiter is enabled.

On a request with a valid bearer token, the server SHALL execute `SELECT 1` against the SQLite connection used by the service layer. On query success, the server SHALL respond `200 OK` with body `{ ok: true, version: "<x.y.z>" }` where `<x.y.z>` is the running server's `package.json` version. On query failure (timeout, locked, IO error), the server SHALL respond `503 Service Unavailable` with body `{ ok: false, code: "db_unavailable" }`. The endpoint SHALL NOT include counters, schema version, embedding backlog, session counts, or any other field beyond `ok` and `version` (and `code` on failure).

The endpoint SHALL respond synchronously — there SHALL NOT be a caching layer between the route handler and the SQLite query.

#### Scenario: Request without Authorization header

- **WHEN** a client sends `GET /healthz` with no `Authorization` header
- **THEN** the server SHALL respond `401` with body `{ ok: false, code: "missing_token" }`

#### Scenario: Request with an unrecognized bearer token

- **WHEN** a client sends `GET /healthz` with `Authorization: Bearer <unknown>`
- **THEN** the server SHALL respond `401` with body `{ ok: false, code: "token_invalid" }`

#### Scenario: Request with a revoked or expired bearer token

- **WHEN** a client sends `GET /healthz` with a token whose row is revoked or whose `expires_at` is in the past
- **THEN** the server SHALL respond `401` with body `{ ok: false, code: "token_invalid" }`

#### Scenario: Request with a valid bearer token and a healthy database

- **GIVEN** the SQLite connection is open and `SELECT 1` succeeds
- **WHEN** a client sends `GET /healthz` with `Authorization: Bearer <admin-token>`
- **THEN** the server SHALL respond `200` with body `{ ok: true, version: "<x.y.z>" }`
- **AND** the response SHALL NOT contain any field other than `ok` and `version`

#### Scenario: Request with a valid bearer token and an unavailable database

- **GIVEN** the SQLite connection has been closed or `SELECT 1` raises an error
- **WHEN** a client sends `GET /healthz` with a valid token
- **THEN** the server SHALL respond `503` with body `{ ok: false, code: "db_unavailable" }`

#### Scenario: Request with a project-scoped bearer token

- **WHEN** a client sends `GET /healthz` with a token whose `scope` is `project:<id>`
- **THEN** the server SHALL respond `200` with body `{ ok: true, version: "<x.y.z>" }` (project-scoped tokens are valid for availability checks)

### Requirement: The authenticated HTTP surface MUST bound request body size

Endpoints that read a request body — `/mcp` (POST/DELETE) and `/api/<slug>/sessions*` — SHALL enforce a maximum raw body size and reject an over-large body with `413` (payload too large) instead of buffering it unboundedly in memory. The bound SHALL apply even to authenticated callers, so a valid token cannot exhaust process memory with a single large POST. The limit SHALL be generous enough for legitimate MCP payloads and MAY be configurable.

#### Scenario: Oversized MCP body is rejected

- **GIVEN** an authenticated client posting a body larger than the configured maximum to `/mcp`
- **WHEN** the server reads the request
- **THEN** the server SHALL stop reading and respond `413` without buffering the entire body

#### Scenario: Normal-sized body is accepted

- **GIVEN** an authenticated client posting a body within the configured maximum
- **WHEN** the server reads the request
- **THEN** the request SHALL be processed normally

### Requirement: The MCP transport MUST support configurable Host/Origin allow-lists

The Streamable HTTP transport SHALL accept operator-configured `Host` and `Origin` allow-lists (`REMBRIC_MCP_ALLOWED_HOSTS`, `REMBRIC_MCP_ALLOWED_ORIGINS`, comma-separated). When EITHER list is configured, DNS-rebinding protection SHALL be enabled and the transport SHALL reject a request whose `Host` is not on the host allow-list, or whose `Origin` is present and not on the origin allow-list. When NEITHER is configured, protection SHALL be off (the current default): this is defense-in-depth layered on the mandatory bearer token — which already rejects any request without valid credentials — and the strict `Host` check would otherwise risk rejecting legitimate reverse-proxy setups. Protection is opt-in rather than always-on because the underlying SDK options are deprecated and the primary control is the bearer requirement.

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
