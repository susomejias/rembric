## ADDED Requirements

### Requirement: The widened search set MUST be the token's read reach, and reaching every project MUST NOT confer admin

The set of projects an authorized widening admits SHALL be exactly the projects for which `isAuthorized(token, 'read', { scope: 'project', projectId })` holds, evaluated once per candidate project against the live project list, excluding archived projects. It SHALL NOT be derived from a scope-string comparison, from a privilege class, or from any test other than the one that already governs every other read.

The consequences of that definition are the specification, not incidental outcomes:

- a `*` or `read:*` token widens to every project, which is the former "admin only" behaviour arriving as a special case rather than as a rule;
- a `projects` or `read:projects` token widens to its membership set;
- a `project:<id>` or `read:project:<id>` token widens to one project, so its widened search is identical to its narrow search.

**Widening SHALL confer no privilege whatsoever.** A token whose read reach happens to be every project SHALL remain non-admin: the literal `scope !== '*'` gates that guard dashboard login and the `/admin/*` routes SHALL NOT consult the widened set, SHALL NOT consult `isAuthorized`, and SHALL NOT be reachable by breadth of reach. A rule of the form "reaches all N projects implies admin" would make creating a project a privilege operation on unrelated tokens.

Widening SHALL NOT change any action verb. A read-classified widening SHALL NOT authorize a write anywhere, and no write-classified operation SHALL accept a widened scope.

#### Scenario: A set token widens to exactly its members

- **GIVEN** projects A, B and C, and a token whose membership set is `{A, B}`
- **WHEN** it issues a widened search on a connection resolved to A
- **THEN** the projects searched SHALL be exactly A and B
- **AND** rows SHALL be returned from both, so the assertion is not satisfied by an empty set

#### Scenario: A full-access token widens to every project

- **GIVEN** projects A, B and C and a token with scope `*` or `read:*`
- **WHEN** it issues a widened search
- **THEN** all three projects SHALL be searched

#### Scenario: A project-pinned token's widened search is its narrow search

- **GIVEN** a token with scope `project:A` or `read:project:A`
- **WHEN** it issues a widened search on a connection resolved to A
- **THEN** the result SHALL be identical to the same search without the widening argument, and no other project SHALL be named among the projects searched

#### Scenario: Widening every project is still not admin

- **GIVEN** a token whose read reach is every existing project, by any scope arm
- **WHEN** it attempts `POST /dashboard/login` or any `/admin/*` route
- **THEN** every such request SHALL be refused exactly as it is today
- **AND** a control request with an actual `*`-scoped dashboard credential SHALL succeed, so the refusal is attributable to the gate rather than to a broken probe

#### Scenario: A read-only widening does not authorize a write

- **GIVEN** a token with scope `read:*` or `read:projects`
- **WHEN** it invokes any write-classified tool, with or without any widening argument present on any other tool
- **THEN** the call SHALL be rejected with code `forbidden` and nothing SHALL be persisted

## MODIFIED Requirements

### Requirement: A read whose result set is widened past the effective scope MUST re-authorize against the wider scope

`isAuthorized(tokenScope, action, resolvedScope)` answers one question: may this token act on the connection's effective scope? A tool argument that widens the returned result set beyond that effective scope asks a second, different question, and the server SHALL authorize it separately. A token SHALL NOT receive rows from a scope it is not authorized to read, whatever argument requested them.

This requirement is the fix for **GHSA-cc4j-ch4r-9pf5** and it was deliberately **generalised rather than retired** when the concrete widening argument that occasioned it (`memory.search`'s `include_global`, and the entity-lookup widening `memory-entities` defined as mirroring it) was removed. **The principle outlived the argument, and a widening argument now exists again** — `memory.search`'s opt-in cross-project read — so this requirement is no longer a rule with no instance. A published security requirement SHALL NOT be deleted because its instances come and go.

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

- **GIVEN** a token with `scope = '*'` or `read:*`, on a connection whose effective scope is a project reached via `project.use`, and memories in a second project
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
