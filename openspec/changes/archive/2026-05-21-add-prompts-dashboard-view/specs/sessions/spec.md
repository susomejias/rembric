## MODIFIED Requirements

### Requirement: Session-tool handlers MUST honor the documented scope-resolution precedence

Every MCP tool handler under `apps/server/src/mcp/sessions-tools.ts` that needs to resolve the effective project (`memory.context`, `memory.timeline`, `memory.stats`, `memory.doctor`, `memory.save_prompt`, `memory.search_prompts`, `memory.session_end`, `memory.session_summary`, `memory.capture_passive`) SHALL resolve scope by consulting, in this order:

1. `ctx.project` from the request context, populated when the connection is path-scoped (`/mcp/<slug>`).
2. The `SessionRouter` entry for `(tokenId, mcpSessionId)`, populated by a prior `project.use` call or by roots-based discovery, when the connection is path-less (`ctx.requestedSlug === null`).
3. Global scope, when neither source resolves a project.

A handler that resolves scope using only `ctx.project` and falls through directly to global scope SHALL be considered to be in violation of this requirement.

#### Scenario: Path-less connection with router pin returns project scope

- **GIVEN** a token connected to `/mcp` (path-less)
- **AND** an agent has called `project.use({slug: 'foo', create: true})` successfully
- **WHEN** the agent calls `memory.context`
- **THEN** the response SHALL include `scope: "project:<foo.id>"` and the project's recent memories

#### Scenario: Path-less connection with no router entry returns global scope

- **GIVEN** a token connected to `/mcp` (path-less)
- **AND** no `project.use` call has been made on this MCP session
- **AND** no roots-based discovery has populated the router
- **WHEN** the agent calls `memory.context`
- **THEN** the response SHALL include `scope: "global"` and only global-scope memories

#### Scenario: Path-scoped connection ignores router fallback

- **GIVEN** a token connected to `/mcp/bar` where project `bar` does not exist
- **AND** the router has a leftover entry pointing to project `foo` from a previous session reusing the same `(tokenId, mcpSessionId)` keys
- **WHEN** the agent calls `memory.context`
- **THEN** the response SHALL include `scope: "global"` (the path-scoped intent overrides the stale router entry)
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
- **AND** SHALL NOT return prompts from any other project or from global scope

### Requirement: Sessions MAY be physically purged when empty

A session row SHALL be physically deletable from the `sessions` table ONLY through `AgentSessionsService.purgeEmpty({ adminBypass: true })` and ONLY when the row satisfies all of the following at the moment of deletion:

1. `status IN ('ended', 'abandoned')`.
2. `deleted_at IS NULL` (the row has not been operator-soft-deleted; soft-deleted rows are preserved as operator intent).
3. `summary IS NULL` and `title_final = false` (no human-meaningful label was ever written).
4. `ended_at IS NOT NULL AND ended_at < (now − 3_600_000)` (a 1-hour grace period after end to avoid racing with late-arriving summary writes).
5. No row exists in `memory` with `session_id = sessions.id`.
6. No row exists in `prompts` with `session_id = sessions.id` AND `deleted_at IS NULL`. (Soft-deleted prompts are interpreted as already removed from the session's logical footprint and do NOT block purge.)
7. No row exists in `confirmations` with `session_id = sessions.id`.

The method SHALL run the predicate and the `DELETE` inside a single SQLite transaction. The method SHALL write a `consolidation_ops` row with `op_type = 'session_purge'`, `affected_ids` carrying the deleted ids, and a static `reasoning` string, in the same transaction.

Without `adminBypass: true`, the method SHALL throw `DomainError('forbidden', ...)` and SHALL NOT touch the database.

#### Scenario: An empty ended session older than the grace period is purged

- **GIVEN** session `S` with `status='ended'`, `deleted_at=NULL`, `summary=NULL`, `title_final=false`, `ended_at = now − 2h`, and zero referencing rows in `memory`, non-deleted `prompts`, `confirmations`
- **WHEN** `AgentSessionsService.purgeEmpty({ adminBypass: true })` is called
- **THEN** the row SHALL be removed from `sessions`
- **AND** a row SHALL exist in `consolidation_ops` with `op_type='session_purge'` and `affected_ids` containing `S.id`
- **AND** the response SHALL include `S.id` in `deletedIds`

#### Scenario: A session within the grace period is preserved

- **GIVEN** session `S` matching the purge predicate except `ended_at = now − 10 minutes`
- **WHEN** `AgentSessionsService.purgeEmpty({ adminBypass: true })` is called
- **THEN** the row SHALL remain in `sessions`
- **AND** `S.id` SHALL NOT appear in the response's `deletedIds`

#### Scenario: A soft-deleted empty session is preserved

- **GIVEN** session `S` matching the purge predicate except `deleted_at` is set to a past timestamp
- **WHEN** `AgentSessionsService.purgeEmpty({ adminBypass: true })` is called
- **THEN** the row SHALL remain in `sessions` — operator soft-delete is interpreted as "do not touch this row"

#### Scenario: A non-admin caller is rejected before any read

- **WHEN** `AgentSessionsService.purgeEmpty({})` or `AgentSessionsService.purgeEmpty({ adminBypass: false })` is called
- **THEN** the method SHALL throw `DomainError('forbidden', ...)`
- **AND** SHALL NOT issue any SQL statement

#### Scenario: A session with even a single referencing memory is preserved

- **GIVEN** session `S` matching the purge predicate except one row in `memory` has `session_id = S.id`
- **WHEN** `AgentSessionsService.purgeEmpty({ adminBypass: true })` is called
- **THEN** the row SHALL remain in `sessions`
- **AND** the memory row SHALL be unaffected

#### Scenario: A session with only soft-deleted prompts is now purgeable

- **GIVEN** session `S` matching the purge predicate except its `prompts` references are all soft-deleted (`deleted_at IS NOT NULL`)
- **WHEN** `AgentSessionsService.purgeEmpty({ adminBypass: true })` is called
- **THEN** the row SHALL be removed from `sessions` (the predicate now ignores soft-deleted prompts)
- **AND** `S.id` SHALL appear in the response's `deletedIds`
- **AND** the soft-deleted prompts SHALL remain in the `prompts` table (their physical purge is governed by the separate "Purge deleted prompts" flow under `/dashboard/maintenance`)

#### Scenario: A session with even one non-deleted prompt is preserved

- **GIVEN** session `S` matching the purge predicate except one row in `prompts` has `session_id = S.id AND deleted_at IS NULL`
- **WHEN** `AgentSessionsService.purgeEmpty({ adminBypass: true })` is called
- **THEN** the row SHALL remain in `sessions`
- **AND** the prompt row SHALL be unaffected
