## MODIFIED Requirements

### Requirement: `memory.session_start` MAY accept an explicit project slug

The `memory.session_start` tool SHALL accept an optional `project?: string` argument (a slug, not a path). The argument SHALL be an assertion about the connection's resolved project, never a way to choose one: the resolved project comes from the URL path (`/mcp/<slug>`), or is the default project on a path-less connection, and no argument changes it. When `project` names the resolved project's slug, the call SHALL proceed exactly as if the argument were omitted. When it names any other slug — whether or not a project with that slug exists — the call SHALL be rejected with code `scope_locked`, naming the resolved slug, and no session row SHALL be inserted or adopted. On a connection whose URL slug names no project, the `project_not_found` refusal of the shared resolver SHALL take precedence. No argument of this tool SHALL create a project; projects are created from the dashboard or by an admin token through `project.create`.

#### Scenario: `memory.session_start` with a slug matching the default project on `/mcp`

- **GIVEN** a `/mcp` (no path slug) connection whose default project has slug `default`
- **WHEN** the agent calls `memory.session_start({agent: 'claude-code', project: 'default'})`
- **THEN** the call SHALL succeed exactly as `memory.session_start({agent: 'claude-code'})` does, and the session row SHALL carry the default project's `project_id`

#### Scenario: `memory.session_start` with an explicit valid slug on `/mcp`

- **WHEN** the agent calls `memory.session_start({project: 'rembric'})` on a `/mcp` (no path slug) connection, the slug exists, and it is not the default project's slug
- **THEN** the call SHALL be rejected with code `scope_locked` and a message naming the default project's slug
- **AND** no session row SHALL be inserted, and the connection's later calls SHALL still resolve to the default project

#### Scenario: `memory.session_start` with an explicit slug on `/mcp/<slug>` mismatching the path

- **WHEN** the agent calls `memory.session_start({project: 'api'})` on a connection at `/mcp/rembric`
- **THEN** the call SHALL be rejected with code `scope_locked` and a message clarifying that the connection is path-scoped to `'rembric'`

#### Scenario: `memory.session_start` with an unknown slug

- **WHEN** the agent calls `memory.session_start({project: 'unknown-slug'})` on a connection that resolved to an existing project, and no project has slug `unknown-slug`
- **THEN** the call SHALL be rejected with code `scope_locked`; no session row SHALL be inserted and no project row SHALL be created
