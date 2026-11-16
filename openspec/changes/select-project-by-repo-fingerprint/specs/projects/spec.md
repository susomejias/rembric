## MODIFIED Requirements

### Requirement: Project scope MUST be resolvable only from URL path or the default project

The server SHALL resolve an MCP request's project from exactly two sources: (a) the URL path `/mcp/<slug>`, and (b) on a path-less `/mcp` request, the default project. No tool call SHALL set, switch or pin a project, MCP `roots` SHALL NOT be consulted, and no per-connection state SHALL carry a project between requests. The `X-Rembric-Project` header SHALL no longer be consulted; servers SHALL ignore it and SHALL NOT use its value in scope resolution. The `X-Rembric-Repo-Fingerprint` header (see the `repository-binding` capability) SHALL NOT select a project either: the client resolves a fingerprint to a slug before it connects, and connects at `/mcp/<slug>`.

When the URL path carries no slug, the request SHALL resolve to the **default project** (see "Exactly one project MUST be marked as the system default"). There SHALL be exactly one scopeless state: a path-less request that carries the `X-Rembric-Repo-Fingerprint` header is **unbound**. It is authenticated, it resolves to no project, and every tool that resolves an effective scope SHALL be refused with structured code `project_unbound`; it SHALL NOT fall back to the default project. Every other request is either bound to the project its URL slug named or resolved to the default project.

A path slug that names no project is NOT resolved to the default project. An operator who typed a slug asked to be confined to it, and answering a typo with a different project would write into the wrong place silently; such a connection is refused instead.

#### Scenario: URL path sets the scope at connection time

- **WHEN** an MCP call arrives at `/mcp/rembric` and the slug exists
- **THEN** the request SHALL be scoped to project `rembric`, and so SHALL every later request at the same URL

#### Scenario: URL path slug does not exist

- **WHEN** an MCP call arrives at `/mcp/does-not-exist` and no project has that slug
- **THEN** the `initialize` SHALL succeed (path-scoping does not enforce existence pre-tools), BUT any tool call that resolves the scope into a `project_id` SHALL respond with `project_not_found`, SHALL NOT auto-create, and SHALL NOT fall back to the default project

#### Scenario: `X-Rembric-Project` header is sent

- **WHEN** an MCP call arrives with `X-Rembric-Project: rembric`, no path slug and no `X-Rembric-Repo-Fingerprint` header
- **THEN** the server SHALL ignore the header and SHALL resolve the request to the default project

#### Scenario: Neither path nor tool call has set scope

- **WHEN** the agent calls `memory.save` on a `/mcp` connection without an `X-Rembric-Repo-Fingerprint` header, where no tool call can set a project, whether or not its client advertises the `roots` capability
- **THEN** the call SHALL succeed against the default project
- **AND** it SHALL NOT be rejected with `project_required`, which is retired from the MCP surface entirely: no emitting site remains, because the paths that leave a connection unusable emit their own codes — `project_not_found` for an unresolvable slug, `project_archived` for an archived project and `project_unbound` for an unbound repository

#### Scenario: A path-less request carrying a fingerprint is unbound

- **GIVEN** a path-less `/mcp` connection whose requests carry `X-Rembric-Repo-Fingerprint: <fingerprint>`, and a token authorized to write the default project
- **WHEN** the agent calls `memory.save`
- **THEN** the call SHALL be refused with `project_unbound`
- **AND** no row SHALL be written to the default project or to any other project

#### Scenario: The fingerprint header never selects a project

- **GIVEN** fingerprint `F` bound to project `shop`, which the token may write
- **WHEN** a path-less `/mcp` request carries `X-Rembric-Repo-Fingerprint: F` and calls `memory.search`
- **THEN** the call SHALL be refused with `project_unbound`, not served from `shop`
