## MODIFIED Requirements

### Requirement: Tokens MUST support scope and expiration

Every token SHALL carry a `scope` (one of `*` for full access, `project:<id>` for project-restricted, `read:*` for read-only, or `read:project:<id>` for read-only project-restricted) and SHALL optionally carry an `expires_at` timestamp. The MCP middleware SHALL enforce these on every request: every tool call (except the data-free `memory.about`) SHALL pass an `isAuthorized(tokenScope, action, resolvedScope)` check, where `action` is the tool's read/write classification and `resolvedScope` is the connection's effective scope (or the tool's requested/target scope where the tool takes one).

#### Scenario: Project-scoped token used for another project

- **GIVEN** a token with `scope = 'project:A'`
- **WHEN** the token is used to make an MCP call with `X-Rembric-Project: B`
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
