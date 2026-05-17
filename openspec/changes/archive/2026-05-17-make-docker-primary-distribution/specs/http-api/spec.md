## ADDED Requirements

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
