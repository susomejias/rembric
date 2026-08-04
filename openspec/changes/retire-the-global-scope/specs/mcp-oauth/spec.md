## MODIFIED Requirements

### Requirement: Issued OAuth tokens MUST map to the existing scope grammar

The `/token` response and the stored grant SHALL express scope in the **advertised OAuth scope vocabulary** (`SUPPORTED_OAUTH_SCOPES`, e.g. `mcp`, `read`) — the granted scope SHALL be the requested scopes restricted to that advertised set, echoed verbatim in the token response so the client observes its requested scopes as granted. The internal `TokenScope` (`*`, `read:*`, `project:<id>`, `read:project:<id>`) used by `isAuthorized()` SHALL be **derived from the granted OAuth scope at authorization time**, not stored as the wire scope. The derivation SHALL fail closed: an absent, empty, or unrecognized requested scope SHALL yield least privilege (`read:*`); write access SHALL be granted only when a write-capable scope is explicitly requested.

An OAuth grant SHALL be bound to the project it was consented for, and that binding SHALL be a property of the minted token, not merely of the connection URL. When the authorization request arrives on a project connector path (`/mcp/<slug>`), the resolved project SHALL be carried through the signed authorization hand-off, the consent, the issued authorization code, and the access/refresh tokens (persisted on the grant). An access token bound to a project SHALL authorize as the project-restricted `TokenScope` (`project:<id>` for a write grant, `read:project:<id>` for a read grant) — so it SHALL be rejected when used against any other project, exactly as a static `project:<id>` / `read:project:<id>` token is. The project restriction SHALL NOT be forgeable by the client changing its connection URL after the token is issued.

**A grant consented on the path-less `/mcp` connection SHALL remain unbound** (`*` or `read:*`), NOT bound to the default project. This is deliberate and is the one place the default project is not simply "whatever `/mcp` resolves to". A path-less consent screen shows the operator no project, so binding the token to the default project would record a restriction the operator never saw and never agreed to — and it would then deny that token everywhere else, on a credential the operator believes is unrestricted. An unbound token authorizes against every project, which is what the consent screen's absence of a project means. Its CONNECTIONS still resolve to the default project like anyone else's, so it reads and writes there by default without being confined to it.

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
- **WHEN** the same token is presented to `/mcp/b`, or to a path-less `/mcp` whose connection resolves to the default project, and used to read or write
- **THEN** the request SHALL be rejected with a `403`-class authorization failure, because the token's scope is bound to project `a` and does not authorize project `b` or the default project
- **AND** the refusal SHALL name `project.use` and the slug `a`, so the operator's own project is reachable in one call

#### Scenario: Path-less OAuth grant is global

- **GIVEN** an authorization request consented on the path-less `/mcp` connection with a write-capable scope
- **WHEN** the token is issued
- **THEN** the token SHALL authorize as the unbound `*` scope, and no project binding SHALL be recorded
- **AND** a connection made with that token at path-less `/mcp` SHALL resolve to the default project, without the token being confined to it
- **AND** the scenario title predates this change: such a grant is unbound, not global
