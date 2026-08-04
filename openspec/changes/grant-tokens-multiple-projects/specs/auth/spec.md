## MODIFIED Requirements

### Requirement: Tokens MUST support scope and expiration

Every token SHALL carry a `scope` (one of `*` for full access, `project:<id>` for project-restricted, `read:*` for read-only, `read:project:<id>` for read-only project-restricted, `projects` for a token whose reach is an explicit set of projects, or `read:projects` for a read-only token over an explicit set of projects) and SHALL optionally carry an `expires_at` timestamp. The MCP middleware SHALL enforce these on every request: every tool call (except the data-free `memory.about`) SHALL pass an `isAuthorized(tokenScope, action, resolvedScope)` check, where `action` is the tool's read/write classification and `resolvedScope` is the connection's effective scope (or the tool's requested/target scope where the tool takes one).

The two set arms SHALL NOT be spelled as a variant of `*` or `read:*`. A set token's reach comes from its membership set alone (see "A set-scoped token's scope string MUST authorize nothing on its own"), so a base scope that already reaches every project would make the set inert and silently grant more than the operator selected.

#### Scenario: Project-scoped token used for another project

- **GIVEN** a token with `scope = 'project:A'`
- **WHEN** the token is used to make an MCP call on a connection scoped to project B (`/mcp/B`)
- **THEN** the request SHALL be rejected with `403 Forbidden`

#### Scenario: Read-only token attempts to save

- **GIVEN** a token with `scope = 'read:*'`
- **WHEN** the token is used to invoke `memory.save`
- **THEN** the request SHALL be rejected with `403 Forbidden`

#### Scenario: Read-only token attempts any write-classified tool

- **GIVEN** a token with `scope = 'read:*'` or `read:project:<id>`
- **WHEN** the token invokes any write-classified tool (`memory.save_prompt`, `memory.capture_passive`, `memory.session_start`, `memory.session_summary`, `memory.session_end`, `memory.confirm`, `memory.judge`)
- **THEN** the call SHALL be rejected with code `forbidden` and nothing SHALL be persisted

#### Scenario: Project-restricted token calls a read tool outside its project

- **GIVEN** a token with `scope = 'read:project:A'` or `project:A`
- **WHEN** the token invokes a read-classified tool on a connection whose effective scope is project B or global
- **THEN** the call SHALL be rejected with code `forbidden`

#### Scenario: A set-scoped token reaches every project in its set

- **GIVEN** a token with `scope = 'projects'` whose membership set is `{A, C}`
- **WHEN** the token invokes a write-classified tool on a connection scoped to project A, and then on a connection scoped to project C
- **THEN** both calls SHALL be authorized

#### Scenario: A set-scoped token is denied a project outside its set

- **GIVEN** a token with `scope = 'projects'` whose membership set is `{A, C}` and an existing project B
- **WHEN** the token invokes any tool on a connection scoped to project B
- **THEN** the call SHALL be rejected with code `forbidden`

#### Scenario: A read-only set-scoped token cannot write inside its set

- **GIVEN** a token with `scope = 'read:projects'` whose membership set is `{A}`
- **WHEN** the token invokes a write-classified tool on a connection scoped to project A
- **THEN** the call SHALL be rejected with code `forbidden` and nothing SHALL be persisted
- **AND** a read-classified tool on the same connection SHALL be authorized

## ADDED Requirements

### Requirement: A set-scoped token's scope string MUST authorize nothing on its own

The scope strings `projects` and `read:projects` name no project. A token carrying one of them SHALL be denied every target and every action by scope-string evaluation alone; all of its reach SHALL come from its membership set.

This is what makes the union in "Authorization for a set-scoped token MUST be the additive union of scope reach and membership" safe: the base is fail-closed, so a reader that does not know about membership under-authorizes rather than over-authorizes. A set arm spelled as `*` or `read:*` plus a set would instead reach every project regardless of the set.

`tokens.project_id` SHALL be `NULL` for `projects` and `read:projects` tokens. The set arm names no single project, so a non-NULL binding would assert a pin the token does not have.

#### Scenario: The set scope string alone denies every target

- **GIVEN** a token with `scope = 'projects'` and an empty membership set
- **WHEN** the token is used against any project connection, the path-less connection, and any `/api/<slug>/*` endpoint, for both a read-classified and a write-classified operation
- **THEN** every request SHALL be rejected with code `forbidden`
- **AND** an admin `*` token SHALL succeed against the same endpoints

#### Scenario: A set-scoped token carries no single-project binding

- **WHEN** a token is created with the set arm over projects `{A, C}`
- **THEN** the persisted row SHALL have `project_id IS NULL`
- **AND** `token_projects` SHALL contain exactly one row per selected project for that token

### Requirement: Authorization for a set-scoped token MUST be the additive union of scope reach and membership

Authorization SHALL be evaluated as `authorized(scope, action, target) OR authorizedByMembership(token, action, target)`. The union SHALL be additive only: no membership rule SHALL be able to turn an authorization that the scope string grants into a refusal.

Because every token that exists before this capability lands has an empty membership set, the union SHALL be observably identical to scope-string evaluation for every such token, on every endpoint, in both HTTP status and structured error code.

A membership grant SHALL NOT widen the action verb. A `read:projects` token SHALL be authorized for read-classified operations on its member projects and refused write-classified ones; a `projects` token SHALL be authorized for both on its member projects.

#### Scenario: Pre-existing tokens are unchanged by the union

- **GIVEN** tokens with `scope` of `*`, `read:*`, `project:<id of A>`, and `read:project:<id of A>`, each with an empty membership set
- **WHEN** each is exercised against project A, project B, the path-less `/mcp` connection, and `/api/<slug>/sessions`, for both a read and a write operation
- **THEN** every outcome SHALL match the committed pre-change baseline in both status and structured error code
- **AND** at least one probe in the set SHALL succeed, so the comparison is not over an all-refused result set

#### Scenario: Membership does not narrow a global token

- **GIVEN** a token with `scope = '*'`
- **WHEN** the token is used against a project that is not in any membership set
- **THEN** the request SHALL be authorized

### Requirement: A token's project membership set MUST be authorization state, re-read on every authenticated request

The membership set SHALL be treated exactly as `revoked_at` and `expires_at` are treated by "Revocation MUST take effect immediately": the server SHALL re-read a token's current membership from storage before authorizing any authenticated request, and SHALL NOT cache the resulting authorization outcome for any duration.

Removing a project from a token's set SHALL take effect starting with that token's next request. The credential-lookup cache (plaintext → token id) SHALL NOT be extended to hold membership, because its permission to persist indefinitely rests on never substituting for the fresh authorization read.

#### Scenario: Removing a project takes effect on the next request

- **GIVEN** a token with `scope = 'projects'` whose membership set is `{A, B}`, which has just made a successful request against project B
- **WHEN** the operator removes project B from the token's set and the same credential is used against project B again
- **THEN** the request SHALL be rejected with code `forbidden`
- **AND** a request against project A SHALL still be authorized

#### Scenario: Removal takes effect with a warm credential-lookup cache

- **GIVEN** a token with `scope = 'projects'` and membership `{A, B}` whose plaintext has already been verified once, so the credential-lookup cache is warm for it
- **WHEN** project B is removed from the set and the same plaintext is used against project B
- **THEN** the request SHALL be rejected with code `forbidden`

### Requirement: A token reaching every project MUST NOT be an admin token

Admin authority SHALL remain a property of the literal scope string `*` and SHALL NOT be derived from the breadth of a membership set. A `projects` token whose set contains every existing project SHALL be refused the dashboard login, every `/admin/*` route, and every maintenance operation gated on admin authority.

Deriving admin from breadth would make creating a project a privilege-altering operation on unrelated tokens, and would make admin authority appear and disappear as the project table changes.

#### Scenario: A set token over every project is refused the dashboard login

- **GIVEN** a token with `scope = 'projects'` whose membership set contains the id of every existing project
- **WHEN** the token is submitted to `POST /dashboard/login`
- **THEN** the login SHALL be refused
- **AND** the same token SHALL be refused on every `/admin/*` route
- **AND** an admin `*` token SHALL succeed on both

#### Scenario: Creating a project does not escalate an existing set token

- **GIVEN** a token with `scope = 'projects'` whose set contains every existing project, and which is refused the dashboard login
- **WHEN** a new project is created and then archived
- **THEN** the token SHALL remain refused on `POST /dashboard/login` at every point
- **AND** the token SHALL be refused on the newly created project

### Requirement: A set-scoped token MUST NOT be able to create a project

A set names projects that exist. A `projects` or `read:projects` token SHALL be refused `project.use` with `autocreate: true` for a slug that does not resolve, with the structured code the existing autocreate gate returns, because the project it would create is by construction not a member of its set.

#### Scenario: Autocreate is refused for a set token

- **GIVEN** a token with `scope = 'projects'` whose membership set is `{A}`
- **WHEN** the token calls `project.use({ slug: 'brand-new', autocreate: true })`
- **THEN** the call SHALL be rejected with code `forbidden` and no `projects` row SHALL be created
- **AND** an admin `*` token making the same call SHALL create the project
