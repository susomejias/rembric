## ADDED Requirements

### Requirement: Path-less MCP writes MUST refuse silent fallback to global when project suggestions are pending

When an MCP request lands on the path-less endpoint `/mcp` (i.e. the connection is NOT path-scoped via `/mcp/<slug>`), the server SHALL gate writes that default to `scope='project'` against the set of pending project suggestions for the current MCP session. A slug SHALL be considered _pending_ iff it was surfaced by the most recent `roots/list` exchange for the current MCP session AND no row with that slug exists in the `projects` table at the time of the gate check.

Gated tools and their gate conditions:

- `memory.session_start` is gated when its `project` argument is absent or empty AND no project is pinned for the current MCP session (via a prior `project.use`).
- `memory.save` is gated when its `scope` argument is absent or `'project'` AND no project is pinned for the current MCP session.

When the gate fires, the server SHALL respond with a structured error containing:

- `code: 'project_suggestion_pending'`;
- a human-readable `message` that names the two resolution paths verbatim: pass `scope:'global'` explicitly, or call `project.use({slug, autocreate:true})` after asking the user;
- `suggestedSlugs`: the array of pending suggested slugs (non-empty, in the order they were surfaced by `roots/list`).

The gate SHALL be a no-op (the call proceeds with the previous behavior) when ANY of the following holds:

- the set of pending suggestions is empty (no roots advertised, or every suggested slug already exists as a project);
- the agent passes `scope:'global'` explicitly on `memory.save`;
- the agent passes a `project` argument to `memory.session_start`;
- the connection is path-scoped (`/mcp/<slug>`).

#### Scenario: memory.session_start without project on /mcp with a pending suggestion

- **GIVEN** an MCP connection on `/mcp` whose roots-based discovery surfaced suggested slug `acme-research` and where no row with that slug exists in `projects`
- **AND** the client has not called `project.use` for the current session
- **WHEN** the client calls `memory.session_start` without a `project` argument
- **THEN** the response SHALL be an MCP error containing `code: 'project_suggestion_pending'` and `suggestedSlugs: ['acme-research']`
- **AND** no row SHALL be inserted into the `agent_sessions` table for this call

#### Scenario: memory.save without explicit scope on /mcp with a pending suggestion

- **GIVEN** the same connection state as above
- **WHEN** the client calls `memory.save` with `type:'project'`, `content:'…'` and no `scope` argument
- **THEN** the response SHALL be an MCP error containing `code: 'project_suggestion_pending'` and `suggestedSlugs: ['acme-research']`
- **AND** no row SHALL be inserted into the `memory` table for this call

#### Scenario: memory.save with explicit scope='global' bypasses the gate

- **GIVEN** the same connection state as above
- **WHEN** the client calls `memory.save` with `scope:'global'`, `type:'project'`, `content:'…'`
- **THEN** the save SHALL succeed and the new row SHALL have `scope='global'` and `project_id=NULL`

#### Scenario: project.use with autocreate clears the gate

- **GIVEN** the same connection state as above
- **WHEN** the client calls `project.use({slug:'acme-research', autocreate:true})` and then `memory.save` with `type:'project'`, `content:'…'` and no `scope` argument
- **THEN** the `project.use` call SHALL mint the project and pin it to the session
- **AND** the subsequent `memory.save` SHALL succeed and the new row SHALL have `scope='project'` and `project_id` equal to the newly minted project's id

#### Scenario: A suggestion that already exists as a project does not trigger the gate

- **GIVEN** an MCP connection on `/mcp` whose roots-based discovery surfaced suggested slugs `['acme-research', 'analytics']` AND the `projects` table contains a row with slug `acme-research`
- **WHEN** the client calls `memory.session_start` without a `project` argument
- **THEN** the gate SHALL NOT fire because at least one suggestion resolves to an existing project, and the call SHALL proceed under the existing path-less-session-start contract (scope='global' if no project is pinned)

#### Scenario: Path-scoped connections are unaffected

- **GIVEN** an MCP connection on `/mcp/<some-slug>` (path-scoped)
- **WHEN** the client calls `memory.save` with default scope
- **THEN** the existing `Path-scoped connections MUST enforce strict project isolation` requirement applies and the new gate SHALL NOT fire
