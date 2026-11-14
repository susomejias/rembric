## MODIFIED Requirements

### Requirement: Authentication attempts MUST be abuse-resistant

Every bearer-authenticated entry point (`/mcp`, `/api/<slug>/sessions*`, `/healthz`, `/admin/*`, and `POST /dashboard/login`) SHALL resist unauthenticated resource exhaustion. Repeated **failed** authentication attempts from the same pre-auth identity SHALL be throttled BEFORE the token-hash verification runs, so a caller presenting invalid bearers cannot force the per-attempt hashing work. A single authentication attempt SHALL NOT block the server's event loop: the password-hash verification SHALL run without synchronously stalling other in-flight requests. A successful authentication SHALL reset the failure counter for that identity. The existing per-token rate limiter (keyed on the resolved token id) SHALL remain in place for authenticated fair-use and SHALL NOT be relied upon to throttle failed attempts (a failed attempt yields no token id).

The pre-auth identity SHALL be the source socket address unless the operator declares trusted reverse proxies with `REMBRIC_TRUSTED_PROXY_HOPS=<n>`, a non-negative integer that defaults to `0`; an invalid value SHALL be treated as `0` and reported once on stderr at startup. The identity SHALL be the entry `n` places left of the socket address in the chain formed by the `X-Forwarded-For` entries followed by the socket address, or the left-most entry of that chain when it holds fewer than `n + 1` entries. A forwarded value that is not an IP address SHALL map every such request to one shared fallback identity. The same identity SHALL key the per-address rate limits of the OAuth endpoints.

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

#### Scenario: A client-sent `X-Forwarded-For` does not choose the identity

- **GIVEN** `REMBRIC_TRUSTED_PROXY_HOPS` unset and a client connecting directly that has exceeded the failed-attempt threshold
- **WHEN** the client sends another request with an invalid bearer and `X-Forwarded-For: 203.0.113.9`, an address it has not used before
- **THEN** the pre-auth identity SHALL still be the client's socket address
- **AND** the server SHALL respond `429`

#### Scenario: One trusted proxy hop identifies the client the proxy saw

- **GIVEN** `REMBRIC_TRUSTED_PROXY_HOPS=1` and a request arriving from the proxy with `X-Forwarded-For: 203.0.113.9, 198.51.100.7`, where the proxy appended `198.51.100.7`
- **WHEN** the server derives the pre-auth identity
- **THEN** the identity SHALL be `198.51.100.7`
- **AND** failed attempts recorded for it SHALL NOT throttle a request the same proxy forwards for another client address

#### Scenario: An invalid hop count trusts no proxy

- **GIVEN** `REMBRIC_TRUSTED_PROXY_HOPS=two`
- **WHEN** the server starts
- **THEN** it SHALL write one warning naming `REMBRIC_TRUSTED_PROXY_HOPS` to stderr
- **AND** the pre-auth identity SHALL be the socket address, as with `0`

#### Scenario: An invalid bearer on `/mcp` counts toward the lockout

- **GIVEN** the failure threshold is `N` and an identity has presented `N` invalid or unknown bearer tokens to `/mcp` within the window
- **WHEN** the same identity presents a valid token to `/mcp`
- **THEN** the request SHALL be refused as rate-limited before the token is verified, exactly as on `/api`, `/healthz` and the dashboard login
- **AND** a `/mcp` request that presents no credential (the OAuth discovery step that receives the `401` challenge) SHALL NOT count as a failed attempt

#### Scenario: A forwarded request with no trusted proxy is reported once

- **GIVEN** `REMBRIC_TRUSTED_PROXY_HOPS` is `0` (or unset) and the production launcher is running
- **WHEN** requests arrive carrying `X-Forwarded-For`
- **THEN** the launcher SHALL print one warning, for the first of them only, naming the connection address the forwarded clients share and the variable to set
- **AND** at startup it SHALL print the hop count in use, so an operator can confirm the configuration from the container log
