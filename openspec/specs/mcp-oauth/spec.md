# mcp-oauth Specification

## Purpose

TBD - created by archiving change oauth2-resource-server-for-remote-mcp. Update Purpose after archive.

## Requirements

### Requirement: OAuth is opt-in via `REMBRIC_PUBLIC_URL`

The OAuth 2.1 authorization-server surface SHALL be enabled if and only if `REMBRIC_PUBLIC_URL` is set to a non-empty absolute URL, which SHALL serve as the OAuth `issuer` and the base for every absolute URL in the metadata documents. The issuer SHALL use the `https` scheme, except that an `http` scheme SHALL be accepted only for loopback hosts (`localhost`, `127.0.0.1`, `[::1]`) to support local testing (the RFC 8414 loopback exemption). When `REMBRIC_PUBLIC_URL` is unset, the server SHALL NOT expose any OAuth endpoint and SHALL NOT alter any existing behavior (including the `/mcp` `401` response).

#### Scenario: OAuth disabled by default

- **GIVEN** the server is started without `REMBRIC_PUBLIC_URL`
- **WHEN** a client requests `/.well-known/oauth-authorization-server`, `/authorize`, `/token`, or `/register`
- **THEN** the server SHALL respond `404 Not Found` and the static-token `/mcp` path SHALL behave exactly as before this change

#### Scenario: OAuth enabled with issuer

- **GIVEN** the server is started with `REMBRIC_PUBLIC_URL=https://rembric.example.com`
- **WHEN** a client fetches `/.well-known/oauth-authorization-server`
- **THEN** the response SHALL be a JSON metadata document whose `issuer` equals `https://rembric.example.com` and whose endpoint URLs are absolute under that issuer

#### Scenario: Non-HTTPS issuer on a public host rejected at startup

- **GIVEN** `REMBRIC_PUBLIC_URL` is set to an `http://` URL on a non-loopback host (e.g. `http://rembric.example.com`)
- **WHEN** the server starts
- **THEN** the server SHALL refuse to start with a clear error, because OAuth 2.1 requires the issuer to be served over TLS off-loopback

#### Scenario: Loopback http issuer accepted for local testing

- **GIVEN** `REMBRIC_PUBLIC_URL` is set to `http://localhost:8788` (or `http://127.0.0.1:8788`)
- **WHEN** the server starts
- **THEN** the server SHALL start with OAuth enabled, the issuer set to that loopback origin

### Requirement: The server MUST publish OAuth authorization-server and protected-resource metadata

When OAuth is enabled, the server SHALL serve `GET /.well-known/oauth-authorization-server` and `GET /.well-known/oauth-protected-resource` as JSON. The authorization-server document SHALL advertise the `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, the supported `code_challenge_methods_supported` including `S256`, `grant_types_supported` including `authorization_code` and `refresh_token`, and `response_types_supported` including `code`. The protected-resource document SHALL advertise the protected resource and its `authorization_servers`.

#### Scenario: Authorization-server metadata advertises PKCE S256

- **WHEN** a client fetches `/.well-known/oauth-authorization-server`
- **THEN** the response SHALL list `S256` in `code_challenge_methods_supported` and SHALL NOT advertise `plain`

#### Scenario: Protected-resource metadata points back to the issuer

- **WHEN** a client fetches `/.well-known/oauth-protected-resource`
- **THEN** the response SHALL list the configured issuer in its `authorization_servers`

### Requirement: The server MUST support Dynamic Client Registration for public clients

When OAuth is enabled, `POST /register` SHALL accept an OAuth Dynamic Client Registration request and SHALL create a public client: it SHALL return a generated `client_id`, SHALL NOT issue a `client_secret`, and SHALL record `token_endpoint_auth_method: none`. The server SHALL persist the registered `redirect_uris` and reject later authorization requests whose `redirect_uri` is not among them.

#### Scenario: Registering a public client

- **WHEN** a client POSTs valid registration metadata including one or more `redirect_uris` to `/register`
- **THEN** the server SHALL respond `201 Created` with a `client_id`, no `client_secret`, and `token_endpoint_auth_method` of `none`

#### Scenario: Authorization with an unregistered redirect URI

- **GIVEN** a registered client whose `redirect_uris` do not include `https://evil.example/cb`
- **WHEN** an `/authorize` request arrives with `redirect_uri=https://evil.example/cb`
- **THEN** the server SHALL reject the request and SHALL NOT redirect to that URI

### Requirement: Authorization Code flow MUST require PKCE S256

When OAuth is enabled, `GET /authorize` SHALL implement the Authorization Code flow and SHALL require a `code_challenge` with `code_challenge_method=S256`. Requests without a `code_challenge`, or with `code_challenge_method=plain`, SHALL be rejected. Issued authorization codes SHALL be single-use, SHALL expire within 120 seconds, and SHALL be bound to the `code_challenge`, the `redirect_uri`, the `client_id`, and the granted scope.

#### Scenario: Authorize without PKCE is rejected

- **WHEN** an `/authorize` request omits `code_challenge`
- **THEN** the server SHALL reject the request with an `invalid_request` error

#### Scenario: Plain PKCE method is rejected

- **WHEN** an `/authorize` request supplies `code_challenge_method=plain`
- **THEN** the server SHALL reject the request with an `invalid_request` error

#### Scenario: Authorization code is single-use

- **GIVEN** an authorization code already exchanged once at `/token`
- **WHEN** the same code is presented to `/token` a second time
- **THEN** the server SHALL reject the exchange with `invalid_grant` and SHALL NOT issue a token

#### Scenario: Authorization code expires

- **GIVEN** an authorization code issued more than 120 seconds ago
- **WHEN** it is presented to `/token`
- **THEN** the server SHALL reject the exchange with `invalid_grant`

### Requirement: The human MUST authenticate and consent before a code is issued

`GET /authorize` SHALL only issue an authorization code after the operator is authenticated via the existing dashboard session and has explicitly granted consent for the requesting client and scope. An unauthenticated operator SHALL be redirected into the existing dashboard login flow and returned to the consent step on success.

#### Scenario: Unauthenticated operator is sent to login

- **GIVEN** no valid dashboard session cookie is present
- **WHEN** the operator opens an `/authorize` URL
- **THEN** the server SHALL redirect to `/dashboard/login` and, after successful login, SHALL return to the consent screen for the original request

#### Scenario: Consent denied yields no code

- **GIVEN** an authenticated operator on the consent screen
- **WHEN** the operator denies consent
- **THEN** the server SHALL redirect back to the client's `redirect_uri` with an `access_denied` error and SHALL NOT issue an authorization code

### Requirement: The token endpoint MUST exchange codes and verify PKCE

When OAuth is enabled, `POST /token` SHALL support `grant_type=authorization_code`. It SHALL recompute the SHA-256 of the presented `code_verifier`, compare it to the stored `code_challenge`, and reject the exchange with `invalid_grant` on mismatch, on a missing `code_verifier`, on a `redirect_uri` that does not match the one bound to the code, or on a `client_id` mismatch. On success it SHALL issue a short-lived opaque access token and a refresh token.

#### Scenario: Successful code exchange

- **GIVEN** a valid unexpired authorization code and the matching `code_verifier`, `redirect_uri`, and `client_id`
- **WHEN** the client POSTs them to `/token`
- **THEN** the server SHALL respond with an `access_token`, a `token_type` of `Bearer`, an `expires_in`, and a `refresh_token`

#### Scenario: PKCE verifier mismatch

- **GIVEN** a valid authorization code
- **WHEN** the client POSTs a `code_verifier` whose SHA-256 does not equal the bound `code_challenge`
- **THEN** the server SHALL reject the exchange with `invalid_grant`

### Requirement: Refresh tokens MUST rotate with reuse detection

When OAuth is enabled, `POST /token` SHALL support `grant_type=refresh_token`. A successful refresh SHALL issue a new access token AND a new refresh token, and SHALL mark the presented refresh token consumed. Presenting an already-consumed refresh token SHALL be treated as compromise: the server SHALL revoke the entire token family (the access/refresh tokens descended from the original grant).

#### Scenario: Refresh issues a rotated pair

- **GIVEN** a valid, unconsumed refresh token
- **WHEN** the client POSTs it with `grant_type=refresh_token`
- **THEN** the server SHALL return a new `access_token` and a new `refresh_token`, and the presented refresh token SHALL no longer be accepted

#### Scenario: Refresh reuse revokes the family

- **GIVEN** a refresh token that has already been rotated once
- **WHEN** the same (now-consumed) refresh token is presented again
- **THEN** the server SHALL reject it with `invalid_grant` and SHALL revoke all access and refresh tokens in that grant family

### Requirement: Issued OAuth tokens MUST map to the existing scope grammar

The scope granted at consent SHALL be expressed in the existing `TokenScope` grammar (`*`, `read:*`, `project:<id>`, `read:project:<id>`) so that OAuth-minted tokens are authorized by the same `isAuthorized()` checks as static tokens. The mapping SHALL fail closed: an absent, empty, or unrecognized requested scope SHALL yield least privilege (`read:*`); write access (`*`) SHALL be granted only when write is explicitly requested. Project restriction MAY additionally derive from the connector's request path (`/mcp/<slug>`) under the existing path-scoping contract.

#### Scenario: Unknown or empty requested scope fails closed

- **GIVEN** an authorization request whose `scope` is absent, empty, or unrecognized
- **WHEN** consent is granted
- **THEN** the minted access token SHALL receive least privilege (`read:*`), not full access

#### Scenario: Read-only OAuth grant cannot write

- **GIVEN** an access token minted from a grant consented as read-only (`read:*`)
- **WHEN** the token is used to invoke `memory.save`
- **THEN** the request SHALL be rejected with the same `403`-class authorization failure as a static `read:*` token
