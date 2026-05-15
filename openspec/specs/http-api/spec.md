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

The endpoint SHALL accept a JSON body `{ id: string, cwd?: string, agent?: string, description?: string }`. The `id` field is REQUIRED and SHALL match the regex `^[A-Za-z0-9_-]{8,128}$`. On a request whose `(token_id, id)` tuple does not yet exist, the server SHALL insert a new `agent_sessions` row with `status='active'`, `started_at=now`, the resolved `project_id` from the path slug, and the provided `agent`/`description` (default `agent='unknown'`). On a request whose `(token_id, id)` tuple already exists, the server SHALL return the existing row unchanged (idempotent ensure-session pattern, safe for PostCompact re-fires).

The server SHALL respond `200 OK` on both insert and upsert paths with body `{ ok: true, sessionId: <id>, scope: 'project'|'global', projectId: string|null, startedAt: string, created: boolean }`. The `created` field SHALL be `true` for fresh inserts, `false` for idempotent hits.

#### Scenario: Fresh insert with valid id

- **WHEN** a client POSTs `{ id: 'sess-abc12345', cwd: '/home/u/project' }` to `/api/foo/sessions` and no row exists for `(token_id, 'sess-abc12345')`
- **THEN** the server SHALL insert the row and respond `{ ok: true, sessionId: 'sess-abc12345', scope: 'project', projectId: '<foo.id>', startedAt: <iso>, created: true }`

#### Scenario: Idempotent upsert with same id

- **WHEN** a client POSTs `{ id: 'sess-abc12345' }` twice to `/api/foo/sessions` with the same token
- **THEN** the second response SHALL return the same `startedAt` as the first, `created: false`, and the DB SHALL still have exactly one row

#### Scenario: Same id from a different token is rejected

- **WHEN** token A POSTs `{ id: 'shared-id-12345' }` to `/api/foo/sessions` (succeeds), then token B POSTs `{ id: 'shared-id-12345' }` to `/api/foo/sessions`
- **THEN** the second response SHALL be `409` with body `{ ok: false, code: 'id_collision', message }` (defense-in-depth for theoretical UUID collisions; in practice this never fires)
- **AND** the original row owned by token A SHALL be unchanged

#### Scenario: Missing id

- **WHEN** a client POSTs `{}` (no `id` field)
- **THEN** the server SHALL respond `400` with body `{ ok: false, code: 'invalid_input', message: <names the missing field> }`

#### Scenario: Malformed id

- **WHEN** a client POSTs `{ id: '<short>' }`, `{ id: '<char-with-spaces>' }`, or `{ id: 'A'.repeat(129) }`
- **THEN** the server SHALL respond `400` with body `{ ok: false, code: 'invalid_input', message: <names the regex contract> }`

#### Scenario: Endpoint hit on path-less `/api/sessions` without slug (no-op pivot note)

- **WHEN** a client POSTs to `/api/sessions` (no slug segment)
- **THEN** the server SHALL respond `404` `{ ok: false, code: 'not_found' }` — the API is path-scoped only in this change; global-scope sessions are out of scope

### Requirement: `POST /api/<slug>/sessions/:id/summary` MUST write a summary and close the session

The endpoint SHALL accept a JSON body `{ summary: string }` with `summary.length >= 1`. It SHALL resolve the session by `(token_id, id)` — token-mismatch SHALL surface as `session_not_found` (mirroring MCP behavior; no information disclosure). When the resolved row's `deleted_at IS NOT NULL`, the call SHALL be rejected with `session_deleted`. Otherwise the server SHALL set `summary`, `ended_at = now`, and `status = 'ended'` atomically. The response SHALL be `{ ok: true, sessionId, endedAt }`. Calls on an already-ended session SHALL be rejected with `session_already_ended` and SHALL NOT mutate the row.

#### Scenario: Summary written successfully

- **WHEN** a client POSTs `{ summary: '...' }` to `/api/foo/sessions/sess-abc12345/summary` for an active row
- **THEN** the server SHALL persist the summary and respond `{ ok: true, sessionId: 'sess-abc12345', endedAt: <iso> }`

#### Scenario: Empty summary

- **WHEN** a client POSTs `{ summary: '' }` or `{ summary: '   ' }`
- **THEN** the server SHALL respond `400` with `{ ok: false, code: 'invalid_input' }` and SHALL NOT mutate the row

#### Scenario: Session not found / wrong token

- **WHEN** a client POSTs to `/api/foo/sessions/never-existed/summary` OR to a session id owned by a different token
- **THEN** the server SHALL respond `404` with `{ ok: false, code: 'session_not_found' }`

#### Scenario: Session already ended

- **WHEN** a client POSTs a summary for a row whose `status = 'ended'`
- **THEN** the server SHALL respond `409` with `{ ok: false, code: 'session_already_ended' }` and SHALL NOT mutate the row

#### Scenario: Session soft-deleted

- **WHEN** a client POSTs a summary for a row whose `deleted_at IS NOT NULL`
- **THEN** the server SHALL respond `409` with `{ ok: false, code: 'session_deleted' }`

### Requirement: `POST /api/<slug>/sessions/:id/end` MUST close a session without a summary

The endpoint SHALL accept an empty body. It SHALL resolve the session by `(token_id, id)` and, when active, set `ended_at = now` and `status = 'ended'` atomically. Soft-deleted and already-ended rows SHALL be rejected with the same codes as the summary endpoint. The response SHALL be `{ ok: true, sessionId, endedAt }`.

#### Scenario: Active session closed

- **WHEN** a client POSTs to `/api/foo/sessions/sess-abc12345/end` on an active row
- **THEN** the server SHALL set `status='ended'`, `ended_at=now`, leave `summary` as null, and respond `{ ok: true, sessionId, endedAt }`

#### Scenario: Session not found / wrong token / already ended / deleted

- **WHEN** the resolution rules from the summary endpoint apply
- **THEN** the server SHALL respond with the same error codes (`session_not_found`, `session_already_ended`, `session_deleted`)

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
