## MODIFIED Requirements

### Requirement: The server MUST publish OAuth authorization-server and protected-resource metadata

When OAuth is enabled, the server SHALL serve `GET /.well-known/oauth-authorization-server` and `GET /.well-known/oauth-protected-resource` as JSON. The authorization-server document SHALL advertise the `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, the supported `code_challenge_methods_supported` including `S256`, `grant_types_supported` including `authorization_code` and `refresh_token`, and `response_types_supported` including `code`. The protected-resource document SHALL advertise the protected resource and its `authorization_servers`.

Protected-resource metadata SHALL be published per connector. The root document `/.well-known/oauth-protected-resource` describes the path-less `/mcp` connector and SHALL advertise the issuer root as its `resource`. For every existing project, `/.well-known/oauth-protected-resource/mcp/<slug>` SHALL serve a document of the same shape whose `resource` is `<issuer>/mcp/<slug>`; a slug that names no project SHALL answer `404` with the same body as any other unknown authorization-server path. The `401` challenge on `/mcp/<slug>` SHALL carry `resource_metadata` pointing at that connector's document, and the challenge on the path-less `/mcp` SHALL keep pointing at the root document. A standard MCP client sends the advertised `resource` as its RFC 8707 `resource`, so a grant it obtains on `/mcp/<slug>` is bound to that project as "Issued OAuth tokens MUST map to the existing scope grammar" requires, and a grant it obtains on the path-less `/mcp` stays unbound.

#### Scenario: Authorization-server metadata advertises PKCE S256

- **WHEN** a client fetches `/.well-known/oauth-authorization-server`
- **THEN** the response SHALL list `S256` in `code_challenge_methods_supported` and SHALL NOT advertise `plain`

#### Scenario: Protected-resource metadata points back to the issuer

- **WHEN** a client fetches `/.well-known/oauth-protected-resource`
- **THEN** the response SHALL list the configured issuer in its `authorization_servers`

#### Scenario: A project connector has its own protected-resource document

- **GIVEN** a project with slug `a`
- **WHEN** a client fetches `/.well-known/oauth-protected-resource/mcp/a`
- **THEN** the response SHALL be `200` with `resource` equal to `<issuer>/mcp/a` and the configured issuer in its `authorization_servers`
- **AND** `/.well-known/oauth-protected-resource` SHALL still advertise the issuer root as its `resource`

#### Scenario: A slug with no project has no protected-resource document

- **GIVEN** no project with slug `missing`
- **WHEN** a client fetches `/.well-known/oauth-protected-resource/mcp/missing`
- **THEN** the response SHALL be `404` with the not-found body of the authorization-server surface

#### Scenario: The challenge names the connector's document

- **GIVEN** a request without credentials
- **WHEN** it is sent to `/mcp/a`
- **THEN** the `401` `WWW-Authenticate` challenge SHALL carry `resource_metadata="<issuer>/.well-known/oauth-protected-resource/mcp/a"`
- **AND** the same request sent to the path-less `/mcp` SHALL carry `resource_metadata="<issuer>/.well-known/oauth-protected-resource"`

#### Scenario: A standard client's project-connector grant is bound

- **GIVEN** an MCP SDK client that discovers authorization from the `401` challenge of `/mcp/a`
- **WHEN** it completes the authorization-code flow and the operator consents
- **THEN** the issued access token SHALL be bound to project `a`, SHALL authorize on `/mcp/a`, and SHALL be refused with `forbidden` on `/mcp/b`
- **AND** the same client completing the flow from the path-less `/mcp` SHALL receive an unbound token that authorizes on `/mcp/b`

### Requirement: The human MUST authenticate and consent before a code is issued

`GET /authorize` SHALL only issue an authorization code after the operator is authenticated via the existing dashboard session and has explicitly granted consent for the requesting client and scope. An unauthenticated operator SHALL be redirected into the existing dashboard login flow and returned to the consent step on success.

The consent screen SHALL show the project the grant will be bound to, by display name (or slug when it has none) together with its `/mcp/<slug>` connector, and SHALL state plainly when the grant is not bound to a project and will reach every project. An authorization request bound to a project that no longer exists SHALL NOT be offered for consent.

#### Scenario: Unauthenticated operator is sent to login

- **GIVEN** no valid dashboard session cookie is present
- **WHEN** the operator opens an `/authorize` URL
- **THEN** the server SHALL redirect to `/dashboard/login` and, after successful login, SHALL return to the consent screen for the original request

#### Scenario: Consent denied yields no code

- **GIVEN** an authenticated operator on the consent screen
- **WHEN** the operator denies consent
- **THEN** the server SHALL redirect back to the client's `redirect_uri` with an `access_denied` error and SHALL NOT issue an authorization code

#### Scenario: Consent names the bound project

- **GIVEN** an authorization request whose `resource` is `<issuer>/mcp/a`
- **WHEN** the operator opens the consent screen
- **THEN** the screen SHALL name project `a` and its `/mcp/a` connector, and SHALL state that the token reaches only that project

#### Scenario: Consent states an unbound grant

- **GIVEN** an authorization request without a `resource`, or whose `resource` is the issuer root or `<issuer>/mcp`
- **WHEN** the operator opens the consent screen
- **THEN** the screen SHALL state that the grant is not bound to a project and reaches every project

#### Scenario: Consent refuses a request bound to a vanished project

- **GIVEN** a signed authorization request bound to a project id that names no project
- **WHEN** the operator opens the consent screen
- **THEN** the screen SHALL show an error and SHALL NOT offer the authorize action

## ADDED Requirements

### Requirement: The authorization endpoint MUST refuse a `resource` that is not one of this server's MCP connectors

When OAuth is enabled and an `/authorize` request carries an RFC 8707 `resource`, the server SHALL accept it only when it has the issuer's origin, carries no user information, query or fragment, and its path (ignoring trailing slashes) is the root, `/mcp`, or `/mcp/<slug>` for an existing project. Any other `resource`, including `/mcp/<slug>` for a slug that names no project, SHALL be refused with the OAuth error `invalid_target`, and no authorization code SHALL be issued. Because the client and its `redirect_uri` have already been verified at that point, the refusal SHALL be delivered as an authorization error response (RFC 6749 §4.1.2.1, RFC 8707 §2): a redirect to the `redirect_uri` carrying `error=invalid_target` and the request's `state`. A request without a `resource` SHALL remain accepted and unbound.

#### Scenario: A resource naming no project is refused

- **GIVEN** a registered client and no project with slug `missing`
- **WHEN** it sends `/authorize` with `resource=<issuer>/mcp/missing`
- **THEN** the server SHALL redirect to the client's `redirect_uri` with `error=invalid_target` and the request's `state`, and SHALL NOT show the consent screen

#### Scenario: A resource outside this server's MCP surface is refused

- **GIVEN** a registered client
- **WHEN** it sends `/authorize` with a `resource` on another origin, on a path outside `/mcp`, below a project connector, or with a query or fragment
- **THEN** the server SHALL redirect to the client's `redirect_uri` with `error=invalid_target`

#### Scenario: A missing or path-less resource stays unbound

- **GIVEN** a registered client
- **WHEN** it sends `/authorize` without a `resource`, or with `resource` equal to the issuer root or `<issuer>/mcp`
- **THEN** the server SHALL proceed to the consent screen with no project binding
