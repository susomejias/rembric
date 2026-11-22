## ADDED Requirements

### Requirement: Consent MUST offer project administration as a separate, explicit choice

When the consent screen is rendered for a path-less authorization request whose granted scope derives `*`, it SHALL offer one additional choice to also grant the connector project administration (creating projects and binding repositories), unselected by default and described separately from data access. It SHALL NOT offer that choice for a read-only request or a project-bound request. Approving without selecting it SHALL issue a grant with unbound `*` data reach and no administrative capability (see the `auth` capability).

The choice SHALL be recorded on the authorization code and carried unchanged into every access and refresh token of the family, including through refresh rotation. It SHALL NOT change the wire scope echoed by `/token`. The consent endpoint SHALL refuse with `invalid_request`, issuing no code, a submission that selects administration when the consenting session's credential lacks administrative capability or when the request is one for which the choice is not offered; it SHALL NOT drop such a selection silently.

#### Scenario: Approving without administration grants data access only

- **GIVEN** a path-less authorization request with `scope=mcp` and an administering dashboard session
- **WHEN** the operator approves without selecting administration and the client redeems the code
- **THEN** the issued access token SHALL succeed on `memory.save` at `/mcp` and at `/mcp/<slug>` of any existing project
- **AND** it SHALL be refused `project.create` with `admin_token_required`, and no `projects` row SHALL be created

#### Scenario: Approving with administration lets the connector administer

- **GIVEN** a path-less authorization request with `scope=mcp` and an administering dashboard session
- **WHEN** the operator approves with administration selected and the client redeems the code
- **THEN** `project.create({ slug: 'acme' })` with the issued access token SHALL succeed
- **AND** an access token obtained by refreshing that family SHALL also succeed on `project.create`
- **AND** the `/token` response `scope` SHALL be `mcp`

#### Scenario: The choice is not offered where it cannot apply

- **GIVEN** a read-only authorization request, or one bound to a project connector `/mcp/<slug>`
- **WHEN** the consent screen renders
- **THEN** it SHALL NOT offer the administration choice
- **AND** a consent submission for that request that selects administration SHALL be refused with `invalid_request` and no authorization code SHALL be issued

### Requirement: OAuth grants issued before the user layer MUST NOT carry administrative capability

Every authorization code and OAuth token persisted before the migration that introduces users SHALL be treated as issued without administration: it SHALL keep the scope, project binding, expiry and family it had, and SHALL have no administrative capability, and neither SHALL any token its family mints by refresh afterwards. Re-authorizing the connector with administration selected SHALL be the way to restore it.

#### Scenario: A pre-upgrade path-less grant keeps data access and loses administration

- **GIVEN** a path-less write OAuth grant issued before the migration, whose access token could call `project.create`
- **WHEN** the migration runs and the access token is used again
- **THEN** `memory.save` SHALL succeed
- **AND** `project.create` SHALL be refused with `admin_token_required`, and no `projects` row SHALL be created
- **AND** the same SHALL hold for an access token obtained by refreshing that family after the migration

## MODIFIED Requirements

### Requirement: Issued OAuth tokens MUST map to the existing scope grammar

The `/token` response and the stored grant SHALL express scope in the **advertised OAuth scope vocabulary** (`SUPPORTED_OAUTH_SCOPES`, e.g. `mcp`, `read`) — the granted scope SHALL be the requested scopes restricted to that advertised set, echoed verbatim in the token response so the client observes its requested scopes as granted. The internal `TokenScope` (`*`, `read:*`, `project:<id>`, `read:project:<id>`) used by `isAuthorized()` SHALL be **derived from the granted OAuth scope at authorization time**, not stored as the wire scope. The derivation SHALL fail closed: an absent, empty, or unrecognized requested scope SHALL yield least privilege (`read:*`); write access SHALL be granted only when a write-capable scope is explicitly requested.

An OAuth grant SHALL be bound to the project it was consented for, and that binding SHALL be a property of the minted token, not merely of the connection URL. When the authorization request arrives on a project connector path (`/mcp/<slug>`), the resolved project SHALL be carried through the signed authorization hand-off, the consent, the issued authorization code, and the access/refresh tokens (persisted on the grant). An access token bound to a project SHALL authorize as the project-restricted `TokenScope` (`project:<id>` for a write grant, `read:project:<id>` for a read grant) — so it SHALL be rejected when used against any other project, exactly as a static `project:<id>` / `read:project:<id>` token is. The project restriction SHALL NOT be forgeable by the client changing its connection URL after the token is issued.

**A grant consented on the path-less `/mcp` connection SHALL remain unbound** (`*` or `read:*`), NOT bound to the default project. This is deliberate and is the one place the default project is not simply "whatever `/mcp` resolves to". A path-less consent screen shows the operator no project, so binding the token to the default project would record a restriction the operator never saw and never agreed to — and it would then deny that token everywhere else, on a credential the operator believes is unrestricted. An unbound token authorizes against every project, which is what the consent screen's absence of a project means. Its CONNECTIONS still resolve to the default project like anyone else's, so it reads and writes there by default without being confined to it. Its unbound `*` is data reach only: the grant SHALL have administrative capability only when the operator granted administration at consent (see "Consent MUST offer project administration as a separate, explicit choice").

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
- **AND** the refusal SHALL name the slug `a` and the `/mcp/a` URL, and SHALL NOT name `project.use`, so the operator learns the one connection URL that reaches the token's own project

#### Scenario: Path-less OAuth grant is global

- **GIVEN** an authorization request consented on the path-less `/mcp` connection with a write-capable scope
- **WHEN** the token is issued
- **THEN** the token SHALL authorize as the unbound `*` scope, and no project binding SHALL be recorded
- **AND** a connection made with that token at path-less `/mcp` SHALL resolve to the default project, without the token being confined to it
- **AND** the scenario title predates this change: such a grant is unbound, not global
- **AND** the token SHALL be refused `project.create` and `project.bind_repository` with `admin_token_required` unless administration was granted at consent
