## ADDED Requirements

### Requirement: Projects MUST be uniquely identified by their absolute path

The `projects` table SHALL enforce uniqueness on the `path` column. `projects.findOrCreate(path)` SHALL return the existing project if one matches, or insert a new row otherwise.

#### Scenario: Resolving an existing project
- **GIVEN** a project row exists with `path = '/Users/x/repo'`
- **WHEN** `projects.findOrCreate('/Users/x/repo')` is called
- **THEN** the existing row SHALL be returned without inserting a new one

#### Scenario: Resolving a new project
- **GIVEN** no project row exists with `path = '/Users/x/new-repo'`
- **WHEN** `projects.findOrCreate('/Users/x/new-repo')` is called
- **THEN** a new row SHALL be inserted and returned

### Requirement: Project scope MUST be resolvable from path or header

The server SHALL accept two equivalent ways for a client to specify project scope on an MCP request: (a) the URL path `/mcp/<project-slug>` and (b) the `X-Rembric-Project` header. When both are present, the path slug SHALL take precedence and the header SHALL be ignored. When neither is present, the request SHALL be treated as global (no project scope).

#### Scenario: Path slug only
- **WHEN** an MCP call arrives at `/mcp/my-app` with no `X-Rembric-Project` header
- **THEN** the server SHALL resolve `my-app` to a project (creating one if not yet known) and use that id for any project-scoped memory operations

#### Scenario: Header only
- **WHEN** an MCP call arrives at `/mcp` with `X-Rembric-Project: my-app`
- **THEN** the server SHALL resolve `my-app` to a project (creating one if not yet known) and use that id for any project-scoped memory operations

#### Scenario: Both path and header (path wins)
- **WHEN** an MCP call arrives at `/mcp/foo` with `X-Rembric-Project: bar`
- **THEN** the server SHALL resolve `foo`, ignore `bar`, and operate scoped to `foo`

#### Scenario: Neither path nor header
- **WHEN** an MCP call arrives at `/mcp` with no `X-Rembric-Project`
- **THEN** the request SHALL be accepted but with no project scope; any `memory.save` requesting `scope='project'` SHALL respond with a structured error code `project_required` instructing the caller to reconnect at `/mcp/<slug>` or supply the header

### Requirement: Projects MUST support archive and rename

The dashboard and CLI SHALL allow operators to rename a project (changing its display name without losing memory associations) and to archive a project (preventing new memories from being saved against it while preserving existing ones).

#### Scenario: Archiving a project
- **WHEN** the operator archives project `P`
- **THEN** subsequent `memory.save` calls scoped to `P` SHALL reject, but `memory.search` and `memory.get` SHALL continue to return its existing memories
