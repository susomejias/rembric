## MODIFIED Requirements

### Requirement: Projects MUST be uniquely identified by their slug

The `projects` table SHALL store the canonical identifier of each project in a column named `slug` (renamed from `path` in this change). `slug` SHALL be `TEXT NOT NULL UNIQUE`. A migration SHALL rename the column atomically; no value normalization SHALL occur during the rename — legacy values continue to function for read and write.

Projects SHALL be created from the dashboard, or by an admin token through the `project.create` MCP tool (see the `mcp-api` capability); no other MCP tool, argument or resolution path SHALL create a project. For _new_ slugs created after this change, the value SHALL match the strict regex `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`. Paths SHALL NOT be persisted in the projects table and SHALL NOT be accepted by any tool argument.

#### Scenario: Renaming the column at migration time

- **GIVEN** a v0.1 database with a populated `projects.path` column
- **WHEN** migration `0003_sessions_and_slugs.sql` runs
- **THEN** the column SHALL be renamed to `slug` and all existing rows SHALL retain their values verbatim

#### Scenario: Creating a new project with a valid slug

- **WHEN** the operator creates a project with slug `rembric-api` from the dashboard, or an admin token calls `project.create({ slug: 'rembric-api' })`, and the slug does not exist
- **THEN** a new row SHALL be inserted with that slug

#### Scenario: No MCP tool creates a project

- **WHEN** an MCP client calls any registered tool other than `project.create` on a connection whose slug names no project, with any arguments
- **THEN** no `projects` row SHALL be inserted

#### Scenario: Creating a new project with an invalid slug

- **WHEN** a creation path receives a slug containing uppercase, leading hyphen, dots, underscores, or a length > 64
- **THEN** the call SHALL be rejected with code `invalid_slug` and SHALL NOT insert a row

#### Scenario: A legacy slug continues to function

- **GIVEN** a pre-existing row with `slug = 'My.Project'` (created under v0.1's looser rules)
- **WHEN** any tool resolves project scope to that slug
- **THEN** the row SHALL be returned and the request SHALL proceed normally
