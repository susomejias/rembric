## ADDED Requirements

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
