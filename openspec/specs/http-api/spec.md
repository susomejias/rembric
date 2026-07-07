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

### Requirement: `POST /api/<slug>/sessions/:id/summary` MUST write a summary and close the session

The endpoint SHALL accept a JSON body `{ summary: string, title?: string, final?: boolean }`. The `summary` field SHALL be a string of length ≥1 and ≤20,000 chars at the zod transport boundary (kept as a wire DoS guard, distinct from the effective service-layer cap). The `title` field SHALL be a string of length ≤100 chars (when present, length ≥1). The `final` field SHALL default to `false`.

Before the service-layer call, the handler SHALL apply server-side truncation: if `summary.length > SUMMARY_MAX_CHARS`, the handler SHALL replace `summary` with `summary.slice(0, SUMMARY_MAX_CHARS - SUFFIX.length) + '…[truncated]'` (where `SUFFIX = '…[truncated]'`, length 13 in JavaScript code units) before calling `agentSessions.writeSummary`. The resulting written length SHALL be exactly `SUMMARY_MAX_CHARS` when truncation fired. This truncation is silent at the HTTP boundary (response status remains `200 OK` and the truncated value is echoed back in the response body) because the HTTP clients are hook scripts (bash / Python / opencode plugin) that cannot react to an error — the suffix is the operator-visible signal.

The server SHALL resolve the session by `(token_id, id)` — token-mismatch SHALL surface as `session_not_found`. When the resolved row's `deleted_at IS NOT NULL`, the call SHALL be rejected with `session_deleted`.

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

Before the service-layer call, the handler SHALL apply server-side truncation to the `summary` field, identical to `/summary`: when `summary` is present and `summary.length > SUMMARY_MAX_CHARS`, the handler SHALL replace it with `summary.slice(0, SUMMARY_MAX_CHARS - SUFFIX.length) + '…[truncated]'` before calling `agentSessions.end`. The response remains `200 OK` with the truncated value echoed back.

The server SHALL resolve the session by `(token_id, id)` and, when active, atomically:

1. Apply any provided summary/title writes subject to the precedence rules (after the truncation helper has run on `summary`).
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
