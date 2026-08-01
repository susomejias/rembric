## ADDED Requirements

### Requirement: A read whose result set is widened past the effective scope MUST re-authorize against the wider scope

`isAuthorized(tokenScope, action, resolvedScope)` answers one question: may this token act on the connection's effective scope? A tool argument that widens the returned result set beyond that effective scope asks a second, different question, and the server SHALL authorize it separately. A token SHALL NOT receive rows from a scope it is not authorized to read, whatever argument requested them.

Specifically: where a read tool accepts an argument that admits `global` rows into a `project`-scoped result (`memory.search`'s `include_global`, and the entity-lookup widening `memory-entities` defines as mirroring it), the server SHALL evaluate `isAuthorized(tokenScope, 'read', { scope: 'global' })` before widening. When that check fails the widening SHALL be dropped and the project-scoped result served unchanged; the call SHALL NOT be rejected, because the caller is authorized for everything it actually receives.

This is distinct from the existing requirement that a project-restricted token invoking a read tool whose *effective scope* is global be rejected with `forbidden`. That case concerns which scope the connection resolved to. This one concerns a result set widened past a scope the token legitimately holds.

#### Scenario: Project-restricted token requests global widening

- **GIVEN** a token with `scope = 'project:A'` or `read:project:A`, on a connection whose effective scope is project A
- **WHEN** the token calls `memory.search` with `include_global = true`
- **THEN** the response SHALL contain no memory whose `scope = 'global'`, and the call SHALL succeed rather than return `forbidden`

#### Scenario: Full-access token requests global widening

- **GIVEN** a token with `scope = '*'` or `read:*`, on a connection whose effective scope is a project reached via `project.use`
- **WHEN** the token calls `memory.search` with `include_global = true`
- **THEN** global memories SHALL be returned alongside the project's own

#### Scenario: The widening argument does not escalate a write

- **GIVEN** a token with `scope = 'read:project:A'`
- **WHEN** the token calls any write-classified tool
- **THEN** the call SHALL be rejected with code `forbidden`, unchanged by the presence or absence of any widening argument on any other tool
