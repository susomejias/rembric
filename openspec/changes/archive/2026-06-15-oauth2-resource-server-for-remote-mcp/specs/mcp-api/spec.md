## ADDED Requirements

### Requirement: The MCP endpoint MUST advertise the authorization server on `401` when OAuth is enabled

When OAuth is enabled (`REMBRIC_PUBLIC_URL` set), an unauthenticated or invalid-token request to `/mcp` or `/mcp/<slug>` SHALL respond `401` with a `WWW-Authenticate: Bearer` header that includes `resource_metadata="<issuer>/.well-known/oauth-protected-resource"`, enabling OAuth clients to discover the authorization server. When OAuth is disabled, the `401` response SHALL NOT include this header and SHALL be byte-compatible with the pre-change behavior.

#### Scenario: 401 advertises resource metadata when OAuth enabled

- **GIVEN** the server started with `REMBRIC_PUBLIC_URL=https://rembric.example.com`
- **WHEN** a request hits `/mcp` with no `Authorization` header
- **THEN** the response SHALL be `401` and SHALL carry `WWW-Authenticate: Bearer resource_metadata="https://rembric.example.com/.well-known/oauth-protected-resource"`

#### Scenario: 401 unchanged when OAuth disabled

- **GIVEN** the server started without `REMBRIC_PUBLIC_URL`
- **WHEN** a request hits `/mcp` with no `Authorization` header
- **THEN** the response SHALL be `401` and SHALL NOT include a `WWW-Authenticate` header

### Requirement: OAuth and static tokens MUST share the path-scoping contract

A connection authenticated by an OAuth access token SHALL be subject to the identical `/mcp` vs `/mcp/<slug>` path-scoping contract as a static-token connection: a path-scoped OAuth connection SHALL enforce strict project isolation, and a global OAuth connection SHALL behave as a global static-token connection. The authentication mechanism SHALL NOT change scope resolution.

#### Scenario: Path-scoped OAuth connection enforces isolation

- **GIVEN** a connection at `/mcp/foo` authenticated with an OAuth access token
- **WHEN** the client calls `memory.save` with `scope='global'`
- **THEN** the response SHALL be an MCP error with `code: 'scope_locked'`, identical to the static-token case

#### Scenario: Reserved OAuth paths do not shadow MCP slugs

- **GIVEN** OAuth is enabled
- **WHEN** the server routes requests for `/authorize`, `/token`, `/register`, and `/.well-known/oauth-*`
- **THEN** those SHALL resolve to the OAuth handlers and SHALL NOT be interpreted as `/mcp` project slugs, and `/mcp/<slug>` routing SHALL remain unchanged
