## MODIFIED Requirements

### Requirement: Every MCP request MUST be authenticated

The server SHALL reject any request to `/mcp` that does not include a valid bearer token in the `Authorization` header. Tokens SHALL be matched against the `tokens` table by hash; revoked or expired tokens SHALL be rejected. The pre-auth failed-attempt lockout SHALL remain separate from the post-auth request limiter.

When `RATE_LIMIT_ENABLED` is `false` or unset, the authenticated MCP request limiter SHALL be disabled. When it is enabled, the server SHALL apply one `RateLimiterMemory` fixed-window quota per resolved token id after bearer verification succeeds and before body inspection, session resolution, or MCP transport dispatch. The limiter SHALL call the direct `consume(tokenId)` API with `points = RATE_LIMIT_BURST` and `duration = ceil(RATE_LIMIT_BURST / RATE_LIMIT_RPS * 1000) / 1000` seconds. Fractional durations SHALL be preserved. `RATE_LIMIT_RPS` SHALL default to `10` and accept positive values through `10,000`; `RATE_LIMIT_BURST` SHALL default to `30` and accept integers from `1` through `10,000`. A derived window SHALL be finite, a safe integer, and no greater than `2,147,483,647` ms; invalid values SHALL fail clearly rather than silently disabling or making the limiter unlimited.

This is a fixed-window policy, not a continuous token-bucket refill policy: a token may consume its full burst during one window, and its quota resets at the window boundary. Static bearer tokens SHALL use their resolved token row id. OAuth access tokens SHALL use the stable `oauth:<clientId>` identity, so access-token refresh rotation SHALL not create a new quota bucket for the same client.

When `consume` is rejected with a `RateLimiterRes`, the server SHALL return HTTP `429` with the existing JSON error code `rate_limited`, a numeric `retryAfterSeconds` field, and a `Retry-After` header equal to `ceil(msBeforeNext / 1000)`, clamped to at least one second. Unexpected limiter errors SHALL be rethrown, and the route SHALL fail closed with its generic internal error response. The original Web `Request` body SHALL remain untouched and SHALL be passed unchanged to the MCP surface when the request is allowed. No Express middleware adapter or runtime Express import is required by this capability.

#### Scenario: Missing token

- **WHEN** a request arrives at `/mcp` without an `Authorization` header
- **THEN** the response SHALL be `401 Unauthorized` and no MCP handshake SHALL be performed

#### Scenario: Revoked token

- **GIVEN** a token whose `revoked_at` is set
- **WHEN** a request arrives at `/mcp` with that token
- **THEN** the response SHALL be `401 Unauthorized`

#### Scenario: Expired token

- **GIVEN** a token whose `expires_at` is in the past
- **WHEN** a request arrives at `/mcp` with that token
- **THEN** the response SHALL be `401 Unauthorized`

#### Scenario: Authenticated requests are disabled by default

- **GIVEN** `RATE_LIMIT_ENABLED` is unset or `false` and a valid bearer token
- **WHEN** the client sends sequential authenticated MCP requests
- **THEN** the requests SHALL reach the MCP surface without a post-auth `429` quota response
- **AND** the pre-auth authentication lockout SHALL remain a separate mechanism for failed credentials

#### Scenario: The fixed window permits the configured burst then returns legacy 429 JSON

- **GIVEN** rate limiting is enabled with `RATE_LIMIT_RPS = 10` and `RATE_LIMIT_BURST = 2`
- **WHEN** one token sends three authenticated MCP requests inside the derived 200 ms window
- **THEN** the first two requests SHALL proceed to the MCP surface
- **AND** the third response SHALL be HTTP `429` with `code: 'rate_limited'`, a numeric `retryAfterSeconds`, and a `Retry-After` header
- **AND** the JSON message SHALL identify that the token exceeded its rate limit

#### Scenario: A token quota is isolated from another token

- **GIVEN** rate limiting is enabled and token A has consumed its burst
- **WHEN** token B sends an authenticated MCP request in the same window
- **THEN** token B's request SHALL proceed
- **AND** token A's quota SHALL remain exhausted

#### Scenario: A quota resets at the fixed-window boundary

- **GIVEN** rate limiting is enabled and a token has consumed its burst
- **WHEN** the fixed window expires and the token sends another authenticated MCP request
- **THEN** the request SHALL proceed
- **AND** the policy SHALL not claim continuous token-bucket refill semantics

#### Scenario: OAuth refresh rotation preserves the quota identity

- **GIVEN** two valid OAuth access tokens were issued for the same OAuth `clientId`, with the second produced by refresh rotation
- **WHEN** the first token consumes the configured burst and the refreshed token sends another authenticated MCP request in the same fixed window
- **THEN** the refreshed request SHALL receive the same token quota and SHALL be rate limited
- **AND** the two access-token secrets SHALL not create separate quota buckets

#### Scenario: Invalid configuration is rejected

- **GIVEN** `RATE_LIMIT_RPS` or `RATE_LIMIT_BURST` is malformed, outside its existing positive bounds, or produces a non-finite, unsafe, or greater-than-`2,147,483,647` ms derived window
- **WHEN** the rate limiter configuration is resolved
- **THEN** resolution SHALL throw a clear configuration error
- **AND** the server SHALL not silently run without the requested quota

#### Scenario: The limiter does not consume or replace an allowed request body

- **GIVEN** rate limiting is enabled and an authenticated MCP request has a body stream
- **WHEN** rate limiting allows the request
- **THEN** the limiter SHALL not receive or read the body
- **AND** the original request SHALL expose its untouched body to the MCP surface

#### Scenario: Unexpected limiter errors fail closed

- **GIVEN** the direct limiter rejects with an error other than `RateLimiterRes`
- **WHEN** the route invokes the post-auth limiter
- **THEN** the route SHALL return an internal error response
- **AND** it SHALL not dispatch the original request to the MCP surface
