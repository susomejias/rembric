## MODIFIED Requirements

### Requirement: Issued OAuth tokens MUST map to the existing scope grammar

The `/token` response and the stored grant SHALL express scope in the **advertised OAuth scope vocabulary** (`SUPPORTED_OAUTH_SCOPES`, e.g. `mcp`, `read`) — the granted scope SHALL be the requested scopes restricted to that advertised set, echoed verbatim in the token response so the client observes its requested scopes as granted. The internal `TokenScope` (`*`, `read:*`, `project:<id>`, `read:project:<id>`) used by `isAuthorized()` SHALL be **derived from the granted OAuth scope at authorization time**, not stored as the wire scope. The derivation SHALL fail closed: an absent, empty, or unrecognized requested scope SHALL yield least privilege (`read:*`); write access (`*`) SHALL be granted only when a write-capable scope is explicitly requested. Project restriction MAY additionally derive from the connector's request path (`/mcp/<slug>`) under the existing path-scoping contract.

#### Scenario: Token response echoes the requested OAuth scope vocabulary

- **GIVEN** a client that requested `scope=mcp read` (the advertised scopes)
- **WHEN** consent is granted and the code is exchanged at `/token`
- **THEN** the token response `scope` SHALL be `mcp read` (the advertised vocabulary), NOT the internal `TokenScope` (`*`)

#### Scenario: Internal authorization scope is derived at read time

- **GIVEN** an access token whose stored grant is `mcp read`
- **WHEN** the token authenticates a `/mcp` request
- **THEN** `isAuthorized()` SHALL receive a real `TokenScope` (`*`) derived from the granted OAuth scope, authorizing exactly as a static `*` token

#### Scenario: Unknown or empty requested scope fails closed

- **GIVEN** an authorization request whose `scope` is absent, empty, or unrecognized
- **WHEN** consent is granted
- **THEN** the derived authorization scope SHALL be least privilege (`read:*`), not full access

#### Scenario: Read-only OAuth grant cannot write

- **GIVEN** an access token minted from a grant consented as read-only (`read`)
- **WHEN** the token is used to invoke `memory.save`
- **THEN** the request SHALL be rejected with the same `403`-class authorization failure as a static `read:*` token
