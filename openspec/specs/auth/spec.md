# auth Specification

## Purpose

Defines authentication and authorization requirements for Rembric, including bearer token issuance, hashing, scoping, expiration, revocation, and dashboard session management.

## Requirements

### Requirement: Bearer tokens MUST be hashed at rest

The `tokens` table SHALL store only a hash of the token (using argon2id or bcrypt with appropriate parameters). The plaintext token SHALL be returned to the operator exactly once at creation time and SHALL never be persisted or logged.

#### Scenario: Creating a token

- **WHEN** the operator creates a new token via the dashboard or CLI
- **THEN** the server SHALL generate a high-entropy random secret, store its hash, and return the plaintext value exactly once

#### Scenario: Token in logs

- **WHEN** a request log line is emitted for a `/mcp` call
- **THEN** the log SHALL NOT contain the plaintext token; if any token-related field is logged it SHALL be the token name, never the secret

### Requirement: The admin token MUST bootstrap from `REMBRIC_ADMIN_TOKEN`

On first startup, if no token row exists, the server SHALL require `REMBRIC_ADMIN_TOKEN` to be set, SHALL refuse to start otherwise, and SHALL create an `admin` token row with the hash of that value and scope `*`. Subsequent restarts SHALL NOT re-read `REMBRIC_ADMIN_TOKEN`.

#### Scenario: First start without admin token

- **GIVEN** the database has no token rows and `REMBRIC_ADMIN_TOKEN` is not set
- **WHEN** the server is started
- **THEN** the server SHALL exit with a non-zero code and a clear error message instructing the operator to set the env var

#### Scenario: Subsequent start with `REMBRIC_ADMIN_TOKEN` changed

- **GIVEN** the database already contains an admin token row
- **WHEN** the server is started with a different value of `REMBRIC_ADMIN_TOKEN`
- **THEN** the existing admin token row SHALL be preserved unchanged; the env var SHALL be ignored on this start

### Requirement: Tokens MUST support scope and expiration

Every token SHALL carry a `scope` (one of `*` for full access, `project:<id>` for project-restricted, `read:*` for read-only, or `read:project:<id>` for read-only project-restricted) and SHALL optionally carry an `expires_at` timestamp. The MCP middleware SHALL enforce these on every request: every tool call (except the data-free `memory.about`) SHALL pass an `isAuthorized(tokenScope, action, resolvedScope)` check, where `action` is the tool's read/write classification and `resolvedScope` is the connection's effective scope (or the tool's requested/target scope where the tool takes one).

#### Scenario: Project-scoped token used for another project

- **GIVEN** a token with `scope = 'project:A'`
- **WHEN** the token is used to make an MCP call on a connection scoped to project B (`/mcp/B`)
- **THEN** the request SHALL be rejected with `403 Forbidden`

#### Scenario: Read-only token attempts to save

- **GIVEN** a token with `scope = 'read:*'`
- **WHEN** the token is used to invoke `memory.save`
- **THEN** the request SHALL be rejected with `403 Forbidden`

#### Scenario: Read-only token attempts any write-classified tool

- **GIVEN** a token with `scope = 'read:*'` or `read:project:<id>`
- **WHEN** the token invokes any write-classified tool (`memory.save_prompt`, `memory.capture_passive`, `memory.session_start`, `memory.session_summary`, `memory.session_end`, `memory.confirm`, `memory.judge`)
- **THEN** the call SHALL be rejected with code `forbidden` and nothing SHALL be persisted

#### Scenario: Project-restricted token calls a read tool outside its project

- **GIVEN** a token with `scope = 'read:project:A'` or `project:A`
- **WHEN** the token invokes a read-classified tool on a connection whose effective scope is project B or global
- **THEN** the call SHALL be rejected with code `forbidden`

### Requirement: Revocation MUST take effect immediately

When a token is revoked, the server SHALL reject any further request using that token starting with the next request. The server MAY cache the mapping from a successfully-verified plaintext credential to its token id, so a repeat request from the same caller does not repeat the password-hash derivation — but SHALL NOT cache the authorization outcome (valid / revoked / expired) for any duration. Every authenticated request, whether or not it hits that lookup cache, SHALL re-read the token's current `revoked_at` / `expires_at` state from storage before authorizing it. A credential-lookup cache entry MAY persist indefinitely (bounded by capacity, not by time) precisely because it never substitutes for that fresh authorization check.

#### Scenario: Revoke and reuse

- **WHEN** an operator revokes a token at time T, and a client uses the token at T+1s
- **THEN** the client's request SHALL be rejected with `401 Unauthorized`

#### Scenario: Revoke and reuse with a warm credential-lookup cache

- **GIVEN** a token has been used successfully at least once, so its plaintext→id mapping may be cached
- **WHEN** an operator revokes that token, and the client immediately reuses the same plaintext
- **THEN** the client's request SHALL be rejected with `401 Unauthorized` — the cached lookup MUST NOT shortcut the revocation check
- **AND** this SHALL hold identically for expiry: a token that has since expired SHALL be rejected on its next use even if its lookup was cached before expiring

### Requirement: Dashboard sessions MUST be signed and revocable

Dashboard sessions SHALL be backed by a signed httpOnly cookie referencing a `dashboard_sessions` row. Deleting the row SHALL invalidate the session. The signing key SHALL be derived from `REMBRIC_ADMIN_TOKEN` or a dedicated `REMBRIC_SESSION_SECRET` env var when set.

#### Scenario: Tampering with the cookie

- **WHEN** a client sends a request with a cookie whose signature does not verify
- **THEN** the server SHALL reject the request and redirect to `/dashboard/login`

#### Scenario: Server-side session deletion

- **GIVEN** an active dashboard session
- **WHEN** the corresponding `dashboard_sessions` row is deleted
- **THEN** the next request bearing that cookie SHALL be treated as unauthenticated

### Requirement: OAuth-minted tokens MUST be hashed at rest

Access and refresh tokens issued by the OAuth authorization server SHALL be high-entropy random secrets (at least 256 bits) persisted only as a cryptographic hash (SHA-256 of the secret, stored in an indexed column for O(1) lookup), SHALL be returned to the client exactly once at issuance, and SHALL never be persisted or logged in plaintext. They SHALL be stored in dedicated `oauth_*` tables, leaving the static `tokens` table and its rows unchanged.

#### Scenario: OAuth access token stored hashed

- **WHEN** the `/token` endpoint issues an access token
- **THEN** the persisted row SHALL contain only a hash of the secret, and the plaintext SHALL appear only in the token response body

#### Scenario: OAuth token absent from logs

- **WHEN** a request log line is emitted for an OAuth `/token` or `/mcp` call
- **THEN** the log SHALL NOT contain the plaintext access or refresh token

### Requirement: OAuth access tokens MUST authenticate `/mcp` on the same path as static tokens

The MCP authentication step SHALL accept an OAuth-minted access token presented as `Authorization: Bearer <token>` and resolve it to the same `{ scope }` shape as a static token, after first attempting the static-token lookup. An OAuth access token and a static token SHALL NOT be confusable: a value that does not verify as a static token SHALL fall through to OAuth lookup, and vice versa, with constant-time comparison preserved.

#### Scenario: OAuth access token authenticates

- **GIVEN** a valid, unexpired, unrevoked OAuth access token with scope `*`
- **WHEN** it is used as the `/mcp` bearer to call `memory.search`
- **THEN** the call SHALL be authorized exactly as the same call with a static `*` token

#### Scenario: Static token path unchanged

- **GIVEN** a valid static operator token
- **WHEN** it is used as the `/mcp` bearer after this change ships
- **THEN** the token SHALL authenticate with identical behavior to before the change

### Requirement: OAuth access tokens MUST be short-lived and OAuth tokens MUST be revocable with immediate effect

OAuth access tokens SHALL carry a short expiry (default approximately one hour, tunable via env) and SHALL be rejected once expired. Revocation of an OAuth token (including family revocation triggered by refresh reuse) SHALL take effect on the next request, with no in-memory cache holding a revoked token valid for longer than a few seconds — the same immediate-revocation contract as static tokens.

#### Scenario: Expired OAuth access token rejected

- **GIVEN** an OAuth access token past its expiry
- **WHEN** it is presented to `/mcp`
- **THEN** the request SHALL be rejected with `401 Unauthorized`

#### Scenario: Revoked OAuth token rejected immediately

- **GIVEN** an OAuth access token whose grant family was revoked at time T
- **WHEN** the token is used at T+1s
- **THEN** the request SHALL be rejected with `401 Unauthorized`

### Requirement: Authentication attempts MUST be abuse-resistant

Every bearer-authenticated entry point (`/mcp`, `/api/<slug>/sessions*`, `/healthz`, `/admin/*`, and `POST /dashboard/login`) SHALL resist unauthenticated resource exhaustion. Repeated **failed** authentication attempts from the same pre-auth identity (source socket address, or the configured trusted-proxy forwarded first hop) SHALL be throttled BEFORE the token-hash verification runs, so a caller presenting invalid bearers cannot force the per-attempt hashing work. A single authentication attempt SHALL NOT block the server's event loop: the password-hash verification SHALL run without synchronously stalling other in-flight requests. A successful authentication SHALL reset the failure counter for that identity. The existing per-token rate limiter (keyed on the resolved token id) SHALL remain in place for authenticated fair-use and SHALL NOT be relied upon to throttle failed attempts (a failed attempt yields no token id).

#### Scenario: Repeated invalid bearers are throttled before hashing

- **GIVEN** a caller that has exceeded the failed-attempt threshold within the window from one pre-auth identity
- **WHEN** the caller sends another request with an invalid bearer to any authenticated endpoint
- **THEN** the server SHALL respond `429` without performing the token-hash scan for that request

#### Scenario: A single auth attempt does not block concurrent requests

- **GIVEN** a request whose bearer triggers a full token-hash verification
- **WHEN** the verification is running
- **THEN** other in-flight requests SHALL continue to be served (the verification SHALL NOT synchronously block the event loop)

#### Scenario: Successful auth clears the failure counter

- **GIVEN** a pre-auth identity with a non-zero failed-attempt counter below the threshold
- **WHEN** a request from that identity authenticates successfully
- **THEN** the failure counter for that identity SHALL reset to zero

### Requirement: Dashboard session cookies MUST set `Secure` on HTTPS deployments

When the deployment's external origin is HTTPS (the OAuth issuer `REMBRIC_PUBLIC_URL` is `https://…`), the `rembric_session` cookie SHALL be set with the `Secure` attribute so it is never transmitted over a plaintext connection. The `HttpOnly`, `SameSite=Lax`, and `Path=/dashboard` attributes SHALL be preserved. For an http loopback deployment (localhost / 127.0.0.1 dev or first-run), the cookie MAY omit `Secure` so login still works without TLS.

#### Scenario: Secure flag on an HTTPS deployment

- **GIVEN** the server is configured with an `https://` external origin
- **WHEN** the operator logs into `/dashboard/login` successfully
- **THEN** the `Set-Cookie` for `rembric_session` SHALL include `Secure`, `HttpOnly`, and `SameSite=Lax`

#### Scenario: No Secure flag on http loopback

- **GIVEN** the server is reached over `http://localhost`
- **WHEN** the operator logs in successfully
- **THEN** the `rembric_session` cookie MAY omit `Secure` so the plaintext-loopback login works

### Requirement: The dashboard login response MUST NOT reveal token validity

`POST /dashboard/login` SHALL return an indistinguishable response for a syntactically-valid but non-admin token and for an unrecognized token, so the endpoint is not a token-validity oracle. The response body and status SHALL NOT let an attacker distinguish "this token exists but lacks admin scope" from "this token does not exist".

#### Scenario: Valid non-admin token is indistinguishable from an invalid token

- **GIVEN** two login attempts: one with a real project-scoped token and one with a random invalid token
- **WHEN** both are POSTed to `/dashboard/login`
- **THEN** the server SHALL return the same status and the same error body for both

### Requirement: A read whose result set is widened past the effective scope MUST re-authorize against the wider scope

`isAuthorized(tokenScope, action, resolvedScope)` answers one question: may this token act on the connection's effective scope? A tool argument that widens the returned result set beyond that effective scope asks a second, different question, and the server SHALL authorize it separately. A token SHALL NOT receive rows from a scope it is not authorized to read, whatever argument requested them.

Specifically: where a read tool accepts an argument that admits `global` rows into a `project`-scoped result (`memory.search`'s `include_global`, and the entity-lookup widening `memory-entities` defines as mirroring it), the server SHALL evaluate `isAuthorized(tokenScope, 'read', { scope: 'global' })` before widening. When that check fails the widening SHALL be dropped and the project-scoped result served unchanged; the call SHALL NOT be rejected, because the caller is authorized for everything it actually receives.

This is distinct from the existing requirement that a project-restricted token invoking a read tool whose _effective scope_ is global be rejected with `forbidden`. That case concerns which scope the connection resolved to. This one concerns a result set widened past a scope the token legitimately holds.

#### Scenario: Project-restricted token requests global widening

- **GIVEN** a token with `scope = 'project:A'` or `read:project:A`, on a connection whose effective scope is project A
- **WHEN** the token calls `memory.search` with `include_global = true`
- **THEN** the response SHALL contain no memory whose `scope = 'global'`, and the call SHALL succeed rather than return `forbidden`

#### Scenario: Full-access token requests global widening

- **GIVEN** a token with `scope = '*'` or `read:*`, on a connection whose effective scope is a project reached via `project.use`
- **WHEN** the token calls `memory.search` with `include_global = true`
- **THEN** global memories SHALL be returned alongside the project's own

#### Scenario: The widening argument does not escalate a write

- **GIVEN** a token with `scope = 'read:project:A'`
- **WHEN** the token calls any write-classified tool
- **THEN** the call SHALL be rejected with code `forbidden`, unchanged by the presence or absence of any widening argument on any other tool

### Requirement: A persisted project-scoped token MUST be bound to the project row, enforced by the database

The scope grammar fixed by "Tokens MUST support scope and expiration" names the project by **id**. Nothing has bound the producer to that reading, and the only production writer of a persisted project-scoped token wrote a slug for the whole life of the feature — a token denied on its own project, on every endpoint. Convention is therefore not sufficient enforcement.

Every persisted token whose `scope` is `project:<id>` or `read:project:<id>` SHALL carry `tokens.project_id` equal to that same `<id>`, and `<id>` SHALL be the `projects.id` of an existing project. The database SHALL enforce both halves: the pre-existing foreign key from `tokens.project_id` to `projects(id)` rejects a value that is not a project id, and a `CHECK` constraint rejects a row whose scope string names a different project than `project_id` does.

The `TokenScope` string SHALL NOT be accepted from a caller for the project arm. The service that creates tokens SHALL compose it from a resolved project row together with a read/write access selection, so that a call site cannot supply `project:<slug>` — or any other project string — at all. Callers minting a non-project token (`*`, `read:*`) SHALL continue to supply the scope literal directly.

`tokens.project_id` SHALL be `NULL` for `*` and `read:*` tokens.

#### Scenario: A token minted for a project authorizes that project

- **GIVEN** an existing project `alpha`
- **WHEN** a token is created for `alpha` with write access
- **THEN** the persisted row SHALL have `scope = 'project:' || <id of alpha>` and `project_id = <id of alpha>`
- **AND** the token SHALL be authorized for read and write against project `alpha`

#### Scenario: A token minted for a project with read access authorizes reads only

- **GIVEN** an existing project `alpha`
- **WHEN** a token is created for `alpha` with read access
- **THEN** the persisted row SHALL have `scope = 'read:project:' || <id of alpha>` and `project_id = <id of alpha>`
- **AND** a read against `alpha` SHALL be authorized and a write against `alpha` SHALL be rejected with code `forbidden`

#### Scenario: The project segment cannot be supplied as a slug

- **WHEN** a call site attempts to create a token by passing a scope string in the `project:` or `read:project:` form
- **THEN** the attempt SHALL NOT compile — the token-creation input type SHALL admit only `*` and `read:*` as a caller-supplied scope, and SHALL require a resolved project row plus an access selection for the project arm

#### Scenario: A non-project value in `project_id` is rejected by the database

- **WHEN** a row is inserted into `tokens` whose `project_id` is not the id of an existing project
- **THEN** the write SHALL be rejected by the foreign key constraint

#### Scenario: A scope string disagreeing with `project_id` is rejected by the database

- **GIVEN** two existing projects with distinct ids `X` and `Y`
- **WHEN** a row is inserted into `tokens` with `project_id = X` and `scope = 'project:' || Y`
- **THEN** the write SHALL be rejected by the `CHECK` constraint
- **AND** a row with `project_id = X` and `scope = 'project:' || X`, and a row with `project_id = X` and `scope = 'read:project:' || X`, SHALL both be accepted

#### Scenario: A global token carries no project binding

- **WHEN** a token is created with scope `*` or `read:*`
- **THEN** the persisted row SHALL have `project_id IS NULL`

### Requirement: A token whose project binding does not resolve MUST authorize nothing and MUST NOT be repaired

Tokens created before the producer was corrected carry a scope string naming a project by slug and `project_id IS NULL`. Because the scope segment is compared against a project id, such a token is denied everywhere — it fails **closed**.

Such a token SHALL continue to authorize nothing, on every connection and every endpoint. No migration, boot-time repair, or lazy fix-up SHALL rewrite its `scope` or populate its `project_id`. Rewriting it would fail **open**: it would activate a credential the operator has never observed working, with no revocation event and no audit trail.

The server SHALL NOT resolve a project-scoped token's segment by slug as a fallback. The segment has exactly one reading — a project id — and a fallback would give the string two valid readings, which is the condition that produced the defect. Legacy project slugs are not shape-distinguishable from other values (see `projects` — "A legacy slug continues to function"), so no heuristic can safely separate them.

#### Scenario: A pre-existing malformed token is still denied after upgrade

- **GIVEN** a token row created before this change, with `scope = 'project:<slug-of-alpha>'` and `project_id IS NULL`
- **WHEN** the server is upgraded and the token is used against project `alpha`
- **THEN** the request SHALL be rejected with code `forbidden`, exactly as before the upgrade
- **AND** an admin `*` token SHALL succeed against the same endpoint

#### Scenario: The upgrade does not rewrite the row

- **GIVEN** a token row with `scope = 'project:<slug-of-alpha>'` and `project_id IS NULL`
- **WHEN** the server boots after the upgrade
- **THEN** every column of that row SHALL be byte-for-byte unchanged
