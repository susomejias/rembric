## MODIFIED Requirements

### Requirement: A session belongs to exactly one token and at most one project

Every session row SHALL carry a `token_id` referencing an existing row in `tokens`, and SHALL carry the `project_id` its connection resolved to. Because every connection resolves to exactly one project — the slug's project on `/mcp/<slug>`, the router's project after `project.use` or roots discovery, and otherwise the default project — **no newly registered session SHALL carry a null `project_id`**.

**Existing rows with a null `project_id` SHALL be repointed to the default project by the migration that retires the global scope.** Leaving them would keep the retired scope alive in a second table after the change claims to have removed it, and the operator surface would keep rendering a scope label for rows whose scope no longer exists. The count of such rows on a real installation is every path-less session ever registered.

The column SHALL remain nullable in this release. Flipping nullability on SQLite requires a full table rebuild, and the same rollback argument that keeps `memory.scope` present applies to it: a previous image booting against the migrated file must still find the schema it expects. Making it `NOT NULL` is deferred to the change that performs the other table rebuilds.

#### Scenario: A token is revoked while one of its sessions is active

- **WHEN** a token is revoked and a session bound to it is still `status = 'active'`
- **THEN** subsequent tool calls reusing that session id SHALL be rejected with `token_revoked` (existing auth behavior) and the session row SHALL be transitioned to `status = 'abandoned'` on the next request

#### Scenario: A session is started without a project but the token is project-scoped

- **WHEN** `memory.session_start` is called on `/mcp` with a token whose scope is `project:<id>` and the connection resolved to the default project
- **THEN** the call SHALL be rejected with code `forbidden` and SHALL NOT insert a session row
- **AND** the refusal SHALL name the pinned project and `project.use`

#### Scenario: A path-less session start binds to the default project

- **GIVEN** a path-less `/mcp` connection with a token authorized to write the default project, no prior `project.use` and no roots discovery
- **WHEN** `memory.session_start` is called
- **THEN** the session row SHALL carry the default project's `project_id` and SHALL NOT carry a null `project_id`

#### Scenario: Pre-existing scopeless sessions are repointed

- **GIVEN** a populated database holding sessions with `project_id IS NULL`
- **WHEN** the migration retiring the global scope is applied
- **THEN** every such row SHALL carry the default project's `project_id`, the total `sessions` row count SHALL be unchanged, and `SELECT count(*) FROM sessions WHERE project_id IS NULL` SHALL be `0`

### Requirement: Session-tool handlers MUST honor the documented scope-resolution precedence

Every MCP tool handler under `apps/server/src/mcp/` that needs to resolve the effective project (`memory.context`, `memory.timeline`, `memory.stats`, `memory.doctor`, `memory.save_prompt`, `memory.search_prompts`, `memory.session_end`, `memory.session_summary`, `memory.capture_passive`) SHALL resolve scope by consulting, in this order:

1. `ctx.project` from the request context, populated when the connection is path-scoped (`/mcp/<slug>`).
2. The `SessionRouter` entry for `(tokenId, mcpSessionId)`, populated by a prior `project.use` call or by roots-based discovery, when the connection is path-less (`ctx.requestedSlug === null`).
3. **The default project**, when neither source resolves one. There is no fourth step and no scopeless outcome.

A handler that resolves scope using only `ctx.project` and falls through directly to a scope of its own choosing SHALL be considered to be in violation of this requirement. In particular, a handler SHALL NOT construct the default project's scope itself — it SHALL obtain it from the shared resolver, so the resolution rule lives in one place and a change to it cannot leave a handler behind.

#### Scenario: Path-less connection with router pin returns project scope

- **GIVEN** a token connected to `/mcp` (path-less)
- **AND** an agent has called `project.use({slug: 'foo', autocreate: true})` successfully
- **WHEN** the agent calls `memory.context`
- **THEN** the response SHALL include `scope: "project:<foo.id>"` and the project's recent memories

#### Scenario: Path-less connection with no router entry returns global scope

- **GIVEN** a token connected to `/mcp` (path-less)
- **AND** no `project.use` call has been made on this MCP session
- **AND** no roots-based discovery has populated the router
- **WHEN** the agent calls `memory.context`
- **THEN** the response SHALL include the default project's scope and only that project's memories
- **AND** the scenario title predates this change: the fallback it names is the default project, not a global scope

#### Scenario: Path-scoped connection ignores router fallback

- **GIVEN** a token connected to `/mcp/bar` where project `bar` does not exist
- **AND** the router has a leftover entry pointing to project `foo` from a previous session reusing the same `(tokenId, mcpSessionId)` keys
- **WHEN** the agent calls `memory.context`
- **THEN** the call SHALL be refused with `code: 'project_not_found'` rather than resolving to any project, and SHALL NOT fall back to the default project
- **AND** the response SHALL NOT leak `foo`'s memories

#### Scenario: Path-scoped connection to existing project returns that project's scope

- **GIVEN** a token connected to `/mcp/baz` where project `baz` exists
- **AND** auth has resolved `ctx.project` to the `baz` project
- **WHEN** the agent calls `memory.context`
- **THEN** the response SHALL include `scope: "project:<baz.id>"` regardless of any router state

#### Scenario: `memory.search_prompts` honours router-based scope resolution

- **GIVEN** a token connected to `/mcp` (path-less) with a `project.use({slug: 'foo'})` pin
- **WHEN** the agent calls `memory.search_prompts({ query: "anything" })`
- **THEN** the server SHALL resolve scope to `project:<foo.id>` via the `SessionRouter` entry
- **AND** SHALL NOT return prompts from any other project, including the default project

### Requirement: `recentForContext` MUST exclude empty sessions by default

`AgentSessionsService.recentForContext({projectId, limit})` SHALL return at most `limit` rows, ordered by `started_at DESC`, drawn from the set of sessions satisfying ALL of:

1. `deleted_at IS NULL` (soft-delete already specified above);
2. scope match on `project_id = ?`, where `projectId` is always a resolved project id — the method SHALL NOT accept a null `projectId` as a request for a scopeless population, because no such population exists;
3. `sessionHasContent(s)` is TRUE.

Filtering SHALL precede truncation: a request with `limit: 5` SHALL return the five most-recent _useful_ sessions, even if dozens of newer empty sessions exist between them. Empty sessions SHALL NEVER consume a slot in the response.

The method SHALL NOT accept any flag, option, or argument that bypasses the `sessionHasContent` filter. Operators who need to inspect empty sessions SHALL use `/dashboard/sessions`, which surfaces all rows regardless of content.

#### Scenario: An empty active session is excluded

- **GIVEN** a scope containing one active session `A` with no summary and zero anchored rows, plus one ended session `E` with a summary
- **WHEN** `recentForContext({projectId, limit: 5})` is called
- **THEN** the result SHALL contain `E` and SHALL NOT contain `A`

#### Scenario: Filter-then-truncate produces backfill semantics

- **GIVEN** a scope containing, in `started_at` order from newest to oldest: three empty sessions `A`, `B`, `C` and one useful session `U`
- **WHEN** `recentForContext({projectId, limit: 1})` is called
- **THEN** the result SHALL be `[U]` — the most-recent USEFUL session, not the most-recent session overall

#### Scenario: Soft-deleted session with content is still excluded

- **GIVEN** a session that has a summary AND is soft-deleted
- **WHEN** `recentForContext` is called
- **THEN** the row SHALL NOT appear in the result — both filters apply, neither overrides the other

#### Scenario: The default project's sessions are returned like any other project's

- **GIVEN** the default project holding one useful session and project `A` holding another
- **WHEN** `recentForContext` is called with the default project's id
- **THEN** the result SHALL contain only the default project's session, and SHALL NOT contain project `A`'s
