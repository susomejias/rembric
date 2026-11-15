## ADDED Requirements

### Requirement: `POST /api/<slug>/sessions/<id>/file-recall` MUST return file-anchored recall lines synchronously

The server SHALL expose `POST /api/<slug>/sessions/<id>/file-recall`. It is the HTTP surface of the `file-anchored-recall` capability.

**Authentication and authorisation**
- The route SHALL authenticate the bearer token exactly as `recall-hints` does.
- It SHALL answer `project_not_found` for an unknown slug.
- It SHALL require `read` authorisation on that project.
- It SHALL refuse a soft-deleted session the way every session-scoped route does.

**Request body:** a JSON object `{ "path": string, "siblings"?: string[] }`.
- `path` SHALL be at most 1024 characters.
- `siblings`, when present, SHALL hold at most 64 strings of at most 1024 characters each.
- Unknown properties SHALL be ignored, as `recall-hints` ignores them. A newer plugin that sends an extra field to a slightly older server must not lose its notes to a `400`.
- A body that fails these rules SHALL be answered `400 invalid_input`.
- An empty `path` is valid and yields no lines.

**Response:** `200` with `{ "ok": true, "lines": string[], "exhausted": boolean }`.
- `lines` is the rendered block split on newlines, empty when nothing matched.
- `exhausted` is `true` once the session's per-session cap has been reached.

The route SHALL do no work beyond one service call and the usage counter. It SHALL NOT be rate-limited more strictly than `recall-hints`, because it shares that route's latency role: a client waits on it before a tool runs.

#### Scenario: A matching file returns lines

- **GIVEN** project `foo`, a registered session `S` and an eligible memory linked to `packages/db/src/migrate.ts`
- **WHEN** a client POSTs `{"path":"packages/db/src/migrate.ts","siblings":["packages/db/src/migrate.ts"]}` to `/api/foo/sessions/S/file-recall` with a token that can read `foo`
- **THEN** the response SHALL be `200` with `ok: true`, a `lines` array whose first element is `rembric: memories about packages/db/src/migrate.ts:`, and `exhausted: false`

#### Scenario: Invalid bodies are refused

- **WHEN** the body is `{"path": 7}`, `{"path":"a.ts","siblings":"a.ts"}`, or carries 65 siblings
- **THEN** each request SHALL be answered `400` with code `invalid_input`
- **AND** the control SHALL pass in the same run: `{"path":"a.ts","extra":1}` is answered `200`

#### Scenario: Authorisation is enforced

- **WHEN** a token without read access to project `foo` POSTs a valid body to `/api/foo/sessions/S/file-recall`
- **THEN** the response SHALL be `403 forbidden`
- **AND** the control SHALL pass in the same run: the same request with a token that can read `foo` is answered `200`

#### Scenario: Only POST is served

- **WHEN** a client sends `GET /api/foo/sessions/S/file-recall`
- **THEN** the response SHALL be the same method-not-allowed answer every POST-only API route gives
