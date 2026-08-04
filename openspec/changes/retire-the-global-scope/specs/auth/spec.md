## MODIFIED Requirements

### Requirement: A read whose result set is widened past the effective scope MUST re-authorize against the wider scope

`isAuthorized(tokenScope, action, resolvedScope)` answers one question: may this token act on the connection's effective scope? A tool argument that widens the returned result set beyond that effective scope asks a second, different question, and the server SHALL authorize it separately. A token SHALL NOT receive rows from a scope it is not authorized to read, whatever argument requested them.

This requirement is the fix for **GHSA-cc4j-ch4r-9pf5** and it is deliberately **generalised rather than retired**. The concrete widening argument that occasioned it (`memory.search`'s `include_global`, and the entity-lookup widening `memory-entities` defined as mirroring it) no longer exists: with one kind of scope there is nothing to widen into, and the argument is removed from the published tool contract. **The principle outlives the argument.** A published security requirement SHALL NOT be deleted because its single known instance was removed — a future widening argument would otherwise arrive unconstrained, and the advisory would have to be rediscovered rather than cited.

Normatively, therefore: the server SHALL admit into a result set only rows belonging to the scope the connection resolved to. Where a change proposes ANY argument, filter, flag or default that admits rows from a scope other than the resolved one, that change SHALL evaluate `isAuthorized(tokenScope, 'read', <the wider scope>)` before widening, and SHALL be bound by this requirement from the moment it is proposed. Where the check fails, the widening SHALL be dropped and the resolved-scope result served unchanged rather than the call being rejected, because the caller is authorized for everything it actually receives.

The structural reason the advisory was possible SHALL also be recorded, because it is a design constraint on any future widening: a widening flag that travels beside the resolved scope as a bare boolean cannot tell any layer that carries it whether anyone was authorized to set it. Any future widening SHALL therefore carry its authorization decision with it, or be constructed at exactly one site that has already made that decision.

This is distinct from the requirement that a project-restricted token invoking a read tool whose _effective scope_ is a project it does not hold be rejected with `forbidden`. That case concerns which scope the connection resolved to. This one concerns a result set widened past a scope the token legitimately holds.

#### Scenario: Project-restricted token requests global widening

- **GIVEN** a token with `scope = 'project:A'` or `read:project:A`, on a connection whose effective scope is project A
- **WHEN** the token calls `memory.search` with any argument, including one named `include_global`
- **THEN** the response SHALL contain only project A's memories, and an argument named `include_global` SHALL be rejected by the input schema as unrecognized rather than silently ignored
- **AND** the scenario title predates this change: the argument it names is removed, and this scenario now pins that no argument reintroduces widening

#### Scenario: Full-access token requests global widening

- **GIVEN** a token with `scope = '*'` or `read:*`, on a connection whose effective scope is a project reached via `project.use`
- **WHEN** the token calls `memory.search` with any argument
- **THEN** the response SHALL contain only that project's memories, and no argument SHALL admit rows from any other project — a full-access token gains reach by switching scope with `project.use`, never by widening one read
- **AND** the scenario title predates this change: there is no wider scope for a full-access token to be widened into

#### Scenario: The widening argument does not escalate a write

- **GIVEN** a token with `scope = 'read:project:A'`
- **WHEN** the token calls any write-classified tool
- **THEN** the call SHALL be rejected with code `forbidden`, unchanged by the presence or absence of any widening argument on any other tool

#### Scenario: A newly proposed widening is bound by this requirement

- **GIVEN** a change proposing an argument, filter or default that would admit rows from a scope other than the one the connection resolved to
- **WHEN** that change is reviewed
- **THEN** it SHALL evaluate authorization against the wider scope before widening, SHALL drop the widening rather than reject the call when that check fails, and SHALL NOT construct its widening decision outside the single site that made it

### Requirement: Tokens MUST support scope and expiration

Every token SHALL carry a `scope` (one of `*` for full access, `project:<id>` for project-restricted, `read:*` for read-only, or `read:project:<id>` for read-only project-restricted) and SHALL optionally carry an `expires_at` timestamp. The MCP middleware SHALL enforce these on every request: every tool call (except the data-free `memory.about`) SHALL pass an `isAuthorized(tokenScope, action, resolvedScope)` check, where `action` is the tool's read/write classification and `resolvedScope` is the connection's effective scope.

Because every connection now resolves to exactly one project, `resolvedScope` is always a project scope. A `*` or `read:*` token is **unbound** rather than global-scoped: it authorizes against every project, and it carries no project binding of its own.

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
- **WHEN** the token invokes a read-classified tool on a connection whose effective scope is any project other than A — including the default project on a path-less connection
- **THEN** the call SHALL be rejected with code `forbidden`
- **AND** the refusal SHALL name the pinned project and `project.use` (see the `mcp-api` requirement "MCP error messages MUST NOT instruct the agent to perform an action it cannot perform")

### Requirement: A persisted project-scoped token MUST be bound to the project row, enforced by the database

The scope grammar fixed by "Tokens MUST support scope and expiration" names the project by **id**. Nothing has bound the producer to that reading, and the only production writer of a persisted project-scoped token wrote a slug for the whole life of the feature — a token denied on its own project, on every endpoint. Convention is therefore not sufficient enforcement.

Every persisted token whose `scope` is `project:<id>` or `read:project:<id>` SHALL carry `tokens.project_id` equal to that same `<id>`, and `<id>` SHALL be the `projects.id` of an existing project. The database SHALL enforce both halves: the pre-existing foreign key from `tokens.project_id` to `projects(id)` rejects a value that is not a project id, and a `CHECK` constraint rejects a row whose scope string names a different project than `project_id` does.

The `TokenScope` string SHALL NOT be accepted from a caller for the project arm. The service that creates tokens SHALL compose it from a resolved project row together with a read/write access selection, so that a call site cannot supply `project:<slug>` — or any other project string — at all. Callers minting a non-project token (`*`, `read:*`) SHALL continue to supply the scope literal directly.

`tokens.project_id` SHALL be `NULL` for `*` and `read:*` tokens. That null is **not** a retired global scope and SHALL NOT be migrated: it records that the token is unbound — authorized against every project — and the `CHECK` constraint's first disjunct depends on it.

#### Scenario: A token minted for a project authorizes that project

- **GIVEN** an existing project `alpha`
- **WHEN** a token is created for `alpha` with write access
- **THEN** the persisted row SHALL have `scope = 'project:' || <id of alpha>` and `project_id = <id of alpha>`
- **AND** the token SHALL be authorized for read and write against project `alpha`

#### Scenario: A token minted for a project with read access authorizes reads only

- **GIVEN** an existing project `alpha`
- **WHEN** a token is created for `alpha` with read access
- **THEN** the persisted row SHALL have `scope = 'read:project:' || <id of alpha>` and `project_id = <id of alpha>`
- **AND** a read against `alpha` SHALL be authorized and a write against `alpha` SHALL be rejected with code `forbidden`

#### Scenario: The project segment cannot be supplied as a slug

- **WHEN** a call site attempts to create a token by passing a scope string in the `project:` or `read:project:` form
- **THEN** the attempt SHALL NOT compile — the token-creation input type SHALL admit only `*` and `read:*` as a caller-supplied scope, and SHALL require a resolved project row plus an access selection for the project arm

#### Scenario: A non-project value in `project_id` is rejected by the database

- **WHEN** a row is inserted into `tokens` whose `project_id` is not the id of an existing project
- **THEN** the write SHALL be rejected by the foreign key constraint

#### Scenario: A scope string disagreeing with `project_id` is rejected by the database

- **GIVEN** two existing projects with distinct ids `X` and `Y`
- **WHEN** a row is inserted into `tokens` with `project_id = X` and `scope = 'project:' || Y`
- **THEN** the write SHALL be rejected by the `CHECK` constraint
- **AND** a row with `project_id = X` and `scope = 'project:' || X`, and a row with `project_id = X` and `scope = 'read:project:' || X`, SHALL both be accepted

#### Scenario: A global token carries no project binding

- **WHEN** a token is created with scope `*` or `read:*`
- **THEN** the persisted row SHALL have `project_id IS NULL`
- **AND** that null SHALL survive the migration that retires the global scope, because it records an unbound token rather than a scope
- **AND** the scenario title predates this change: such a token is unbound, not global
