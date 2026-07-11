## MODIFIED Requirements

### Requirement: Issued OAuth tokens MUST map to the existing scope grammar

The `/token` response and the stored grant SHALL express scope in the **advertised OAuth scope vocabulary** (`SUPPORTED_OAUTH_SCOPES`, e.g. `mcp`, `read`) — the granted scope SHALL be the requested scopes restricted to that advertised set, echoed verbatim in the token response so the client observes its requested scopes as granted. The internal `TokenScope` (`*`, `read:*`, `project:<id>`, `read:project:<id>`) used by `isAuthorized()` SHALL be **derived from the granted OAuth scope at authorization time**, not stored as the wire scope. The derivation SHALL fail closed: an absent, empty, or unrecognized requested scope SHALL yield least privilege (`read:*`); write access SHALL be granted only when a write-capable scope is explicitly requested.

An OAuth grant SHALL be bound to the project it was consented for, and that binding SHALL be a property of the minted token, not merely of the connection URL. When the authorization request arrives on a project connector path (`/mcp/<slug>`), the resolved project SHALL be carried through the signed authorization hand-off, the consent, the issued authorization code, and the access/refresh tokens (persisted on the grant). An access token bound to a project SHALL authorize as the project-restricted `TokenScope` (`project:<id>` for a write grant, `read:project:<id>` for a read grant) — so it SHALL be rejected when used against a different project or against global scope, exactly as a static `project:<id>` / `read:project:<id>` token is. A grant consented on the path-less `/mcp` connection SHALL be global (`*` or `read:*`). The project restriction SHALL NOT be forgeable by the client changing its connection URL after the token is issued.

#### Scenario: Token response echoes the requested OAuth scope vocabulary

- **GIVEN** a client that requested `scope=mcp read` (the advertised scopes)
- **WHEN** consent is granted and the code is exchanged at `/token`
- **THEN** the token response `scope` SHALL be `mcp read` (the advertised vocabulary), NOT the internal `TokenScope`

#### Scenario: Internal authorization scope is derived at read time

- **GIVEN** an access token whose stored grant is `mcp read` bound to project `p`
- **WHEN** the token authenticates a `/mcp/p` request
- **THEN** `isAuthorized()` SHALL receive a real project-restricted `TokenScope` (`project:<id-of-p>`) derived from the grant

#### Scenario: Unknown or empty requested scope fails closed

- **GIVEN** an authorization request whose `scope` is absent, empty, or unrecognized
- **WHEN** consent is granted
- **THEN** the derived authorization scope SHALL be least privilege (`read:*`, or `read:project:<id>` when project-bound), not full access

#### Scenario: Read-only OAuth grant cannot write

- **GIVEN** an access token minted from a grant consented as read-only (`read`)
- **WHEN** the token is used to invoke `memory.save`
- **THEN** the request SHALL be rejected with the same `403`-class authorization failure as a static read-only token

#### Scenario: Project-bound OAuth token cannot reach another project

- **GIVEN** an access token consented for project `a` (connector `/mcp/a`)
- **WHEN** the same token is presented to `/mcp/b` or to a path-less `/mcp` and used to read or write
- **THEN** the request SHALL be rejected with a `403`-class authorization failure, because the token's scope is bound to project `a` and does not authorize project `b` or global scope

#### Scenario: Path-less OAuth grant is global

- **GIVEN** an authorization request consented on the path-less `/mcp` connection with a write-capable scope
- **WHEN** the token is issued
- **THEN** the token SHALL authorize as global `*`, and no project binding SHALL be recorded

### Requirement: The token endpoint MUST exchange codes and verify PKCE

When OAuth is enabled, `POST /token` SHALL support `grant_type=authorization_code`. It SHALL recompute the SHA-256 of the presented `code_verifier`, compare it to the stored `code_challenge`, and reject the exchange with `invalid_grant` on mismatch, on a missing `code_verifier`, on a `redirect_uri` that does not match the one bound to the code, or on a `client_id` mismatch. When the authorization code was issued with a bound `redirect_uri`, the exchange SHALL require the request to carry that same `redirect_uri` and SHALL reject with `invalid_grant` if it is absent or different — the check SHALL NOT be skipped merely because the client omitted the parameter. On success it SHALL issue a short-lived opaque access token and a refresh token.

#### Scenario: Successful code exchange

- **GIVEN** a valid unexpired authorization code and the matching `code_verifier`, `redirect_uri`, and `client_id`
- **WHEN** the client POSTs them to `/token`
- **THEN** the server SHALL respond with an `access_token`, a `token_type` of `Bearer`, an `expires_in`, and a `refresh_token`

#### Scenario: PKCE verifier mismatch

- **GIVEN** a valid authorization code
- **WHEN** the client POSTs a `code_verifier` whose SHA-256 does not equal the bound `code_challenge`
- **THEN** the server SHALL reject the exchange with `invalid_grant`

#### Scenario: Omitted redirect_uri does not bypass the binding

- **GIVEN** an authorization code issued with a bound `redirect_uri`
- **WHEN** the client POSTs the exchange WITHOUT a `redirect_uri` parameter
- **THEN** the server SHALL reject the exchange with `invalid_grant` (the omission SHALL NOT be treated as a match)

## ADDED Requirements

### Requirement: Token revocation MUST verify client ownership

When OAuth is enabled, `POST /revoke` SHALL revoke the token family only when the presented token belongs to the authenticated/requesting client. A revocation request for a token owned by a different client SHALL NOT revoke that other client's token; per RFC 7009 the endpoint SHALL still respond as success (no error, no action). Revocation of the client's own valid token SHALL take effect immediately across the whole token family.

#### Scenario: Client cannot revoke another client's token

- **GIVEN** a token issued to client `A` and a revocation request presenting that token but originating from client `B`
- **WHEN** client `B` POSTs it to `/revoke`
- **THEN** the server SHALL respond success WITHOUT revoking client `A`'s token family

#### Scenario: Client revokes its own token

- **GIVEN** a valid access token issued to client `A`
- **WHEN** client `A` POSTs it to `/revoke`
- **THEN** the entire token family SHALL be revoked and subsequent use of any token in that family SHALL be rejected immediately
