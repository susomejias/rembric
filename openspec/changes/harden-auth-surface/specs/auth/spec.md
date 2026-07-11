## ADDED Requirements

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
