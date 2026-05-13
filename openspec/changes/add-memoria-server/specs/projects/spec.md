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

### Requirement: The `X-Memoria-Project` header MUST drive project scope

MCP tools that operate on memories SHALL read the `X-Memoria-Project` header to determine the project scope. If absent, the scope SHALL default to `global`. If present, the server SHALL resolve the header value to a project (creating one if needed) and use its id as `project_id`.

#### Scenario: Header is absent
- **WHEN** an MCP call arrives without `X-Memoria-Project`
- **THEN** any `memory.save` performed by that call SHALL default to `scope = 'global'` unless the tool input explicitly requests `scope = 'project'`, in which case the call SHALL reject

#### Scenario: Header is present
- **WHEN** an MCP call arrives with `X-Memoria-Project: my-app`
- **THEN** the server SHALL resolve `my-app` to a project id (creating one if not yet known) and SHALL use that id for any project-scoped memory operations in that call

### Requirement: Projects MUST support archive and rename

The dashboard and CLI SHALL allow operators to rename a project (changing its display name without losing memory associations) and to archive a project (preventing new memories from being saved against it while preserving existing ones).

#### Scenario: Archiving a project
- **WHEN** the operator archives project `P`
- **THEN** subsequent `memory.save` calls scoped to `P` SHALL reject, but `memory.search` and `memory.get` SHALL continue to return its existing memories
