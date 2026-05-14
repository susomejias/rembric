## ADDED Requirements

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

Every token SHALL carry a `scope` (either `*` for full access, `project:<id>` for project-restricted, or `read:*` for read-only) and SHALL optionally carry an `expires_at` timestamp. The MCP middleware SHALL enforce these on every request.

#### Scenario: Project-scoped token used for another project
- **GIVEN** a token with `scope = 'project:A'`
- **WHEN** the token is used to make an MCP call with `X-Rembric-Project: B`
- **THEN** the request SHALL be rejected with `403 Forbidden`

#### Scenario: Read-only token attempts to save
- **GIVEN** a token with `scope = 'read:*'`
- **WHEN** the token is used to invoke `memory.save`
- **THEN** the request SHALL be rejected with `403 Forbidden`

### Requirement: Revocation MUST take effect immediately

When a token is revoked, the server SHALL reject any further request using that token starting with the next request. There SHALL be no in-memory token cache with a TTL longer than a few seconds.

#### Scenario: Revoke and reuse
- **WHEN** an operator revokes a token at time T, and a client uses the token at T+1s
- **THEN** the client's request SHALL be rejected with `401 Unauthorized`

### Requirement: Dashboard sessions MUST be signed and revocable

Dashboard sessions SHALL be backed by a signed httpOnly cookie referencing a `dashboard_sessions` row. Deleting the row SHALL invalidate the session. The signing key SHALL be derived from `REMBRIC_ADMIN_TOKEN` or a dedicated `REMBRIC_SESSION_SECRET` env var when set.

#### Scenario: Tampering with the cookie
- **WHEN** a client sends a request with a cookie whose signature does not verify
- **THEN** the server SHALL reject the request and redirect to `/dashboard/login`

#### Scenario: Server-side session deletion
- **GIVEN** an active dashboard session
- **WHEN** the corresponding `dashboard_sessions` row is deleted
- **THEN** the next request bearing that cookie SHALL be treated as unauthenticated
