## ADDED Requirements

### Requirement: The authenticated HTTP surface MUST bound request body size

Endpoints that read a request body — `/mcp` (POST/DELETE) and `/api/<slug>/sessions*` — SHALL enforce a maximum raw body size and reject an over-large body with `413` (payload too large) instead of buffering it unboundedly in memory. The bound SHALL apply even to authenticated callers, so a valid token cannot exhaust process memory with a single large POST. The limit SHALL be generous enough for legitimate MCP payloads and MAY be configurable.

#### Scenario: Oversized MCP body is rejected

- **GIVEN** an authenticated client posting a body larger than the configured maximum to `/mcp`
- **WHEN** the server reads the request
- **THEN** the server SHALL stop reading and respond `413` without buffering the entire body

#### Scenario: Normal-sized body is accepted

- **GIVEN** an authenticated client posting a body within the configured maximum
- **WHEN** the server reads the request
- **THEN** the request SHALL be processed normally

### Requirement: The MCP transport MUST support configurable Host/Origin allow-lists

The Streamable HTTP transport SHALL accept operator-configured `Host` and `Origin` allow-lists (`REMBRIC_MCP_ALLOWED_HOSTS`, `REMBRIC_MCP_ALLOWED_ORIGINS`, comma-separated). When EITHER list is configured, DNS-rebinding protection SHALL be enabled and the transport SHALL reject a request whose `Host` is not on the host allow-list, or whose `Origin` is present and not on the origin allow-list. When NEITHER is configured, protection SHALL be off (the current default): this is defense-in-depth layered on the mandatory bearer token — which already rejects any request without valid credentials — and the strict `Host` check would otherwise risk rejecting legitimate reverse-proxy setups. Protection is opt-in rather than always-on because the underlying SDK options are deprecated and the primary control is the bearer requirement.

#### Scenario: Unconfigured transport does not reject on Host/Origin

- **GIVEN** no `REMBRIC_MCP_ALLOWED_HOSTS` / `REMBRIC_MCP_ALLOWED_ORIGINS` configured
- **WHEN** a valid-bearer request arrives at `/mcp` with any `Host`
- **THEN** DNS-rebinding protection SHALL NOT reject it (behavior unchanged from before this change)

#### Scenario: Configured transport rejects an unlisted Host

- **GIVEN** `REMBRIC_MCP_ALLOWED_HOSTS` is configured with the deployment host
- **WHEN** a request arrives at `/mcp` with a `Host` header not on the allow-list
- **THEN** the transport SHALL reject the request

#### Scenario: Configured transport serves an allowed Host with a valid bearer

- **GIVEN** `REMBRIC_MCP_ALLOWED_HOSTS` includes the deployment host
- **WHEN** a request arrives at `/mcp` with an allowed `Host` and a valid bearer token
- **THEN** the request SHALL be handled normally
