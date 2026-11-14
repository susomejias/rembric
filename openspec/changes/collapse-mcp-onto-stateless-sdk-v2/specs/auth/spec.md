## MODIFIED Requirements

### Requirement: Tokens MUST support scope and expiration

Every token SHALL carry a `scope` (one of `*` for full access, `project:<id>` for project-restricted, `read:*` for read-only, `read:project:<id>` for read-only project-restricted, `projects` for a token whose reach is an explicit set of projects, or `read:projects` for a read-only token over an explicit set of projects) and SHALL optionally carry an `expires_at` timestamp. The MCP middleware SHALL enforce these on every request: every tool call (except the data-free `memory.about`) SHALL pass an `isAuthorized(tokenScope, action, resolvedScope)` check, where `action` is the tool's read/write classification and `resolvedScope` is the connection's effective scope.

Because every connection now resolves to exactly one project, `resolvedScope` is always a project scope. A `*` or `read:*` token is **unbound** rather than global-scoped: it authorizes against every project, and it carries no project binding of its own.

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
- **WHEN** the token invokes a read-classified tool on a connection whose effective scope is any project other than A — including the default project on a path-less connection
- **THEN** the call SHALL be rejected with code `forbidden`
- **AND** the refusal SHALL name the pinned project and its `/mcp/<slug>` URL, and SHALL NOT name `project.use` (see the `mcp-api` requirement "MCP error messages MUST NOT instruct the agent to perform an action it cannot perform")

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

### Requirement: A read whose result set is widened past the effective scope MUST re-authorize against the wider scope

`isAuthorized(tokenScope, action, resolvedScope)` answers one question: may this token act on the connection's effective scope? A tool argument that widens the returned result set beyond that effective scope asks a second, different question, and the server SHALL authorize it separately. A token SHALL NOT receive rows from a scope it is not authorized to read, whatever argument requested them.

This requirement is the fix for **GHSA-cc4j-ch4r-9pf5** and it was deliberately **generalised rather than retired** when the concrete widening argument that occasioned it (`memory.search`'s `include_global`, and the entity-lookup widening `memory-entities` defined as mirroring it) was removed. **The principle outlived the argument, and a widening argument now exists again** — `memory.search`'s opt-in cross-project read — so this requirement is no longer a rule with no instance. A published security requirement SHALL NOT be deleted because its instances come and go: had it been, this widening would have arrived unconstrained and the advisory would have had to be rediscovered rather than cited.

Normatively: the server SHALL admit into a result set only rows belonging to a scope the token is authorized to read. Where a change proposes ANY argument, filter, flag or default that admits rows from a scope other than the resolved one, that change SHALL evaluate `isAuthorized(tokenScope, 'read', <the wider scope>)` before widening — once per project the widening would admit, never once for the widening as a whole — and SHALL be bound by this requirement from the moment it is proposed. Where the check fails for a project, that project SHALL be dropped from the widened set and the remaining result served, rather than the call being rejected, because the caller is authorized for everything it actually receives. Where the check fails for every project but the resolved one, the resolved-scope result SHALL be served unchanged.

**Because a dropped widening is served rather than refused, the caller cannot infer from the response alone how far the read actually reached.** The response SHALL therefore state which projects were searched, so "this is everything across the projects I may read" is distinguishable from "the widening was dropped".

The structural reason the advisory was possible SHALL also be recorded, because it is a design constraint on any widening: a widening flag that travels beside the resolved scope as a bare boolean cannot tell any layer that carries it whether anyone was authorized to set it. Any widening SHALL therefore carry its authorization decision with it, or be constructed at exactly one site that has already made that decision. A request-level flag arriving from the client is not that decision: the value the lower layers receive SHALL be the authorized set itself, and SHALL be of a type no write path can hold.

This is distinct from the requirement that a project-restricted token invoking a read tool whose _effective scope_ is a project it does not hold be rejected with `forbidden`. That case concerns which scope the connection resolved to. This one concerns a result set widened past a scope the token legitimately holds.

#### Scenario: Project-restricted token requests global widening

The title predates this change: the global widening it names is removed; a different, authorized one now exists, and this scenario pins that it changes nothing for a project-restricted token.

- **GIVEN** a token with `scope = 'project:A'` or `read:project:A`, on a connection whose effective scope is project A
- **WHEN** the token calls `memory.search` with the widening argument
- **THEN** the response SHALL contain only project A's memories, and the call SHALL NOT be rejected
- **AND** an argument named `include_global` SHALL still be refused by the input schema as unrecognized rather than silently ignored

#### Scenario: Full-access token requests global widening

The title predates this change: there is no global scope, but a full-access token does now have a wider scope to be widened into — every project it may read.

- **GIVEN** a token with `scope = '*'` or `read:*`, on a connection whose effective scope is a project reached via its `/mcp/<slug>` URL, and memories in a second project
- **WHEN** the token calls `memory.search` **without** the widening argument
- **THEN** the response SHALL contain only that project's memories
- **AND** **WHEN** it calls `memory.search` **with** the widening argument, the response MAY contain the second project's memories and SHALL name both projects as searched

#### Scenario: The widening argument does not escalate a write

- **GIVEN** a token with `scope = 'read:project:A'`
- **WHEN** the token calls any write-classified tool
- **THEN** the call SHALL be rejected with code `forbidden`, unchanged by the presence or absence of any widening argument on any other tool

#### Scenario: An unauthorized widening is dropped, not refused

- **GIVEN** projects A and B and a token authorized to read A only, on a connection resolved to A
- **WHEN** the token calls `memory.search` with the widening argument against a query both projects match
- **THEN** the call SHALL succeed with status and structured shape identical to the same call without the argument
- **AND** the response SHALL contain no row from B, and SHALL name only A among the projects searched
- **AND** a control call by a token authorized for both SHALL return rows from both, so the exclusion is attributable to authorization rather than to an empty corpus

#### Scenario: A newly proposed widening is bound by this requirement

- **GIVEN** a change proposing an argument, filter or default that would admit rows from a scope other than the one the connection resolved to
- **WHEN** that change is reviewed
- **THEN** it SHALL evaluate authorization against each project the widening would admit before widening, SHALL drop the unauthorized projects rather than reject the call, SHALL NOT construct its widening decision outside the single site that made it, and SHALL report which scopes were actually read

### Requirement: A set-scoped token MUST NOT be able to create a project

A set names projects that exist. No MCP tool creates a project — projects are created from the dashboard only — so a `projects` or `read:projects` token SHALL have no path to create one, and a connection naming a slug outside its set SHALL NOT create the project it names.

#### Scenario: A set token cannot create a project by naming it

- **GIVEN** a token with `scope = 'projects'` whose membership set is `{A}`, and no project with slug `brand-new`
- **WHEN** the token connects at `/mcp/brand-new` and calls `project.list`, `project.current` and every scope-resolving tool
- **THEN** every scope-resolving call SHALL be refused with `project_not_found`, and no `projects` row SHALL be created
- **AND** an admin `*` token making the same calls SHALL likewise create no project, which is the control that the absence of a row comes from the removed creation path and not from the set
