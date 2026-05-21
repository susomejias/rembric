# sessions Specification

## Purpose

Defines the session model used to group an agent's tool calls into bounded units of work: append-only lifecycle, scope binding to a single token and at most one project, optional anchoring of memories to a session of origin, summary persistence, explicit-slug overrides, switching constraints, and recovery of in-flight sessions on server restart.

## Requirements

### Requirement: Sessions MUST be append-only

The system SHALL never physically delete a session row and SHALL never mutate the `agent`, `token_id`, `started_at`, or `project_id` of an existing session, EXCEPT through the operator-only physical-purge escape hatch defined in "Sessions MAY be physically purged when empty". Lifecycle changes are otherwise expressed exclusively by transitioning the `status` column among `active`, `ended`, and `abandoned`, by writing the `ended_at` column at most once, and by writing the `summary` and `title` columns subject to the `summary_final` / `title_final` precedence flags.

The `deleted_at` column is exempt from immutability: it SHALL transition from NULL to a timestamp (soft-delete) or from a timestamp back to NULL (undelete) any number of times. Both transitions SHALL be guarded by the cross-token rule that already protects `end` and `summarize`, unless the caller is an operator-facing surface (CLI or dashboard) that sets `adminBypass: true`.

The `id` column is set exactly once at insert time. It MAY originate from a client (via `POST /api/<slug>/sessions` or `start({id})`) or be server-minted (via `memory.session_start` without an explicit id). Once written it SHALL NOT be UPDATEd.

The `summary` and `title` columns are exempt from one-write-per-lifetime immutability: they MAY be written multiple times subject to the `final` precedence rules (a `final:true` write locks against `final:false` writes; non-final writes can overwrite each other).

#### Scenario: Code path attempts to physically delete a session

- **WHEN** any service or migration emits a `DELETE FROM agent_sessions` statement from any file OTHER than `apps/server/src/services/agent-sessions.ts`
- **THEN** a CI invariant test SHALL fail and the build SHALL be rejected

#### Scenario: Code path attempts to mutate an immutable session column

- **WHEN** any service emits an `UPDATE agent_sessions SET agent = ?`, `UPDATE agent_sessions SET started_at = ?`, or `UPDATE agent_sessions SET id = ?` statement
- **THEN** a CI invariant test SHALL fail and the build SHALL be rejected

#### Scenario: Two `memory.session_end` (or `/api/.../end`) calls for the same session id

- **WHEN** `memory.session_end` (MCP) or `POST /api/<slug>/sessions/:id/end` (HTTP) is called twice on the same `(token_id, id)`
- **THEN** the second call SHALL succeed as an idempotent no-op (status already `ended`, returns the current row) and SHALL NOT mutate `ended_at`. Summary/title write attempts in the second call SHALL be honoured only if they pass the `final` precedence check.

#### Scenario: deleted_at transitions are tracked

- **WHEN** an operator soft-deletes a session and later undeletes it
- **THEN** `deleted_at` SHALL transition NULL → timestamp → NULL and SHALL be the only column (alongside `summary`/`title`) that may revisit its initial value

#### Scenario: Summary may be updated mid-session subject to final precedence

- **GIVEN** session `<S>` is `active` and `summary` has been written once with `final:false`
- **WHEN** another write lands with `final:false`
- **THEN** the second write SHALL overwrite `summary`
- **AND** `summary_final` SHALL remain `false`

### Requirement: `AgentSessionsService.start()` MUST accept a client-provided id and be idempotent on that id

The service method `start(input: { tokenId, projectId, agent, description?, id? })` SHALL accept an optional `id?: string`. When `id` is supplied:

1. The service SHALL validate `id` against the regex `^[A-Za-z0-9_-]{8,128}$`. Non-matching ids SHALL be rejected with `DomainError('invalid_input', <message naming the contract>)`.
2. The service SHALL `SELECT` the row by `id`. If found AND its `token_id` matches the calling token: return the existing row with `created: false` semantics. The service SHALL NOT mutate `status`, `started_at`, `ended_at`, `summary`, `project_id`, `agent`, or `description` on idempotent hits.
3. If the row was found but its `token_id` does NOT match the calling token: throw `DomainError('id_collision', <message>)`. (Theoretically impossible with UUIDs/ULIDs; this is defense-in-depth.)
4. If no row was found: `INSERT` with the provided id and return with `created: true` semantics.

When `id` is NOT supplied, the service SHALL mint a ULID as today and SHALL return `created: true`. This preserves backwards compatibility with `memory.session_start` (MCP) which does not pass an id.

#### Scenario: start() with a valid client id inserts a new row

- **WHEN** `start({ tokenId: 't1', projectId: 'p1', agent: 'claude-code', id: 'sess-abc12345' })` is called and no row exists for id `'sess-abc12345'`
- **THEN** a new row SHALL be inserted with `id = 'sess-abc12345'`, `token_id = 't1'`, `status = 'active'`
- **AND** the returned value SHALL include `created: true`

#### Scenario: start() with the same client id is idempotent for the same token

- **GIVEN** a previous successful `start({ tokenId: 't1', id: 'sess-abc12345', projectId: 'p1' })`
- **WHEN** `start({ tokenId: 't1', id: 'sess-abc12345', projectId: 'p1' })` is called again
- **THEN** the second call SHALL return the existing row with `created: false`
- **AND** `started_at` SHALL be unchanged from the original insert
- **AND** the table SHALL still contain exactly one row for that id

#### Scenario: start() rejects cross-token id collision

- **GIVEN** a row exists for `(token_id='t1', id='shared-id-12345')`
- **WHEN** `start({ tokenId: 't2', id: 'shared-id-12345', projectId: 'p1' })` is called
- **THEN** the service SHALL throw `DomainError('id_collision', ...)` and SHALL NOT insert or mutate any row
- **AND** the original row for `('t1', 'shared-id-12345')` SHALL be untouched

#### Scenario: start() rejects malformed ids

- **WHEN** `start({ tokenId: 't1', id: 'x', projectId: 'p1' })` is called (too short — fails regex)
- **THEN** the call SHALL throw `DomainError('invalid_input', ...)` and SHALL NOT insert a row

- **WHEN** `start({ tokenId: 't1', id: 'has spaces', projectId: 'p1' })` is called
- **THEN** the call SHALL throw `DomainError('invalid_input', ...)`

- **WHEN** `start({ tokenId: 't1', id: 'A'.repeat(129), projectId: 'p1' })` is called
- **THEN** the call SHALL throw `DomainError('invalid_input', ...)`

#### Scenario: start() without explicit id preserves ULID-minting behavior

- **WHEN** `start({ tokenId: 't1', projectId: 'p1', agent: 'mcp' })` is called (no `id`)
- **THEN** the service SHALL mint a ULID via `ulid()`, insert, and return a row whose `id` is that ULID
- **AND** the returned value SHALL include `created: true`

### Requirement: A session belongs to exactly one token and at most one project

Every session row SHALL carry a `token_id` referencing an existing row in `tokens`. When a session is registered through a path-scoped MCP connection (`/mcp/<slug>`) or via `X-Rembric-Project`, the session row SHALL carry the resolved `project_id`. When the session is registered through `/mcp` with no project header, `project_id` SHALL be null and the session is global-scope.

#### Scenario: A token is revoked while one of its sessions is active

- **WHEN** a token is revoked and a session bound to it is still `status = 'active'`
- **THEN** subsequent tool calls reusing that session id SHALL be rejected with `token_revoked` (existing auth behavior) and the session row SHALL be transitioned to `status = 'abandoned'` on the next request

#### Scenario: A session is started without a project but the token is project-scoped

- **WHEN** `memory.session_start` is called on `/mcp` (no project) with a token whose scope is `project:<id>`
- **THEN** the call SHALL be rejected with code `forbidden` and SHALL NOT insert a session row

### Requirement: Memories MAY anchor to a session of origin

The `memory` table SHALL gain a nullable `session_id` column referencing `sessions.id`. The `confirmations` table SHALL gain the same nullable column.

#### Scenario: An agent saves a memory after `memory.session_start`

- **WHEN** the active MCP transport session has a registered Rembric session for `(token, project)` and `memory.save` is called without an explicit `session_id` argument
- **THEN** the inserted row's `session_id` SHALL be set to the active Rembric session id

#### Scenario: An agent saves a memory without calling `memory.session_start`

- **WHEN** `memory.save` is called and no Rembric session is active for `(token, project, mcp-session-id)`
- **THEN** the inserted row's `session_id` SHALL be null and the call SHALL succeed (backwards compatibility)

#### Scenario: A pre-existing memory row predates this change

- **WHEN** the migration that adds `memory.session_id` runs against an existing data file
- **THEN** existing rows SHALL retain `session_id = NULL` and SHALL remain queryable through every existing tool unchanged

### Requirement: A session summary MUST follow the documented structure

When `memory.session_summary` is called, the submitted `summary` SHALL be persisted in the session row's `summary` column. The tool description SHALL document the canonical structure (Goal / Discoveries / Accomplished / Next Steps / Relevant Files), but the server SHALL NOT enforce the layout — agents may submit free-form text.

The `memory.session_summary` tool SHALL NOT transition the session to `ended`. The tool writes `summary` (and optionally `title`) only, marking both as `final:true`. The dedicated `memory.session_end` tool (or `POST /sessions/<id>/end`) is the sole transition.

The tool SHALL accept an optional `title?: string` (≤100 chars) which when present SHALL be written to the `title` column with `final:true` precedence.

#### Scenario: `memory.session_summary` is called with a non-empty summary

- **WHEN** the agent submits `{summary: "Goal: …"}` (no title)
- **THEN** the server SHALL set `summary` and `summary_final = true` atomically; `ended_at` and `status` SHALL remain unchanged; the response SHALL be `{ ok: true, sessionId }`

#### Scenario: `memory.session_summary` is called with summary and title

- **WHEN** the agent submits `{summary: "Goal: …", title: "Fix login bug"}`
- **THEN** the server SHALL set `summary`, `summary_final = true`, `title`, and `title_final = true` atomically; `ended_at` and `status` SHALL remain unchanged

#### Scenario: `memory.session_summary` is called with an empty summary

- **WHEN** the agent submits a `summary` string of length 0 or only whitespace
- **THEN** the call SHALL be rejected with code `invalid_input` and SHALL NOT mutate the row

#### Scenario: `memory.session_summary` is called with a title longer than 100 chars

- **WHEN** the agent submits `{summary: "…", title: "A".repeat(101)}`
- **THEN** the call SHALL be rejected with code `invalid_input` and SHALL NOT mutate the row

#### Scenario: `memory.session_summary` is called twice; the second call wins because both are final

- **GIVEN** session `<S>` is `active` with summary "A" written via a prior `memory.session_summary` (final:true)
- **WHEN** the agent calls `memory.session_summary({summary: "B"})` again
- **THEN** `summary` SHALL be replaced with "B" (last-final-wins among final writes)
- **AND** the response SHALL succeed

### Requirement: `memory.session_start` MAY accept an explicit project slug

The `memory.session_start` tool SHALL accept an optional `project?: string` argument (a slug, not a path). When provided, it SHALL override any auto-detected scope from `roots/list` but SHALL respect the connection-level scope from a path-scoped URL (`/mcp/<slug>`). The slug resolution rules of the `projects` capability apply: unknown slugs reject with `project_not_found` (with `suggestedSlugs[]`), and creation requires the agent to use `project.use({slug, autocreate: true})` separately first.

#### Scenario: `memory.session_start` with an explicit valid slug on `/mcp`

- **WHEN** the agent calls `memory.session_start({agent: 'claude-code', project: 'rembric'})` on a `/mcp` (no path slug) connection and the slug exists
- **THEN** the inserted session row SHALL have `project_id` set to that project, regardless of any `roots`-derived suggestion

#### Scenario: `memory.session_start` with an explicit slug on `/mcp/<slug>` mismatching the path

- **WHEN** the agent calls `memory.session_start({project: 'api'})` on a connection at `/mcp/rembric`
- **THEN** the call SHALL be rejected with code `scope_locked` and a message clarifying that the connection is path-scoped to `'rembric'`

#### Scenario: `memory.session_start` with an unknown slug

- **WHEN** the agent calls `memory.session_start({project: 'unknown-slug'})` and the slug does not exist
- **THEN** the call SHALL be rejected with code `project_not_found` and `suggestedSlugs[]` in the payload; no session row SHALL be inserted

### Requirement: A project switch MUST NOT happen while a session is active

When a session is `status = 'active'` for the current MCP transport, the `project.use` tool SHALL refuse to switch the active project — even with `confirmSwitch: true` — until the session is closed via `memory.session_end` or `memory.session_summary`.

#### Scenario: `project.use` switch attempted with active session

- **WHEN** the agent calls `project.use({slug: 'api', confirmSwitch: true})` while a session is active in project `'rembric'`
- **THEN** the call SHALL be rejected with code `session_active_must_end` and a payload `{ activeSessionId, currentSlug, targetSlug }`

#### Scenario: Closing a session then switching

- **GIVEN** an active session in project `'rembric'`
- **WHEN** the agent calls `memory.session_summary({summary})` and then `project.use({slug: 'api', confirmSwitch: true})`
- **THEN** the second call SHALL succeed with `switched: true` and `previousSlug: 'rembric'`

### Requirement: Server restart MUST mark in-flight sessions as abandoned

In-process session routing state (`mcp-session-id` → active Rembric session id) is not persisted. On startup, the server SHALL scan for sessions with `status = 'active'` whose `started_at` is older than the configured `SESSION_ABANDON_AFTER_MS` (default `24h`) and transition them to `status = 'abandoned'` with `ended_at = now`.

#### Scenario: Server restarts while a session is active

- **WHEN** the server process exits while a session has `status = 'active'` and the next startup reads a `started_at` older than 24 hours
- **THEN** the session SHALL be flipped to `status = 'abandoned'` and a row in the startup log SHALL record the transition

#### Scenario: Server restarts within the abandon window

- **WHEN** the server restarts and an `active` session is younger than 24h
- **THEN** the row SHALL be left `active`; the next tool call referencing it SHALL be accepted (the agent can `session_end` it explicitly or continue)

### Requirement: Sessions MAY be soft-deleted while preserving the audit trail

The `agent_sessions` table SHALL gain a nullable column `deleted_at TIMESTAMP`. A row with `deleted_at IS NOT NULL` is _soft-deleted_: it remains physically present, its `id` continues to satisfy every existing `memory.session_id` foreign-key reference, but it is hidden from default-visible listings.

`AgentSessionsService` SHALL expose:

- `softDelete(sessionId, {tokenId?, adminBypass?})`: sets `deleted_at` to `now()`. Calling this on an already-deleted row SHALL be a no-op that returns the existing row (idempotent). Without `adminBypass`, the caller's `tokenId` SHALL match the row's `token_id`; mismatches SHALL be rejected with `forbidden`.
- `undelete(sessionId, {adminBypass?})`: clears `deleted_at`. Only admin (operator-facing) callers may invoke this; agent-facing callers SHALL NOT have access.

`AgentSessionsService.list(...)` SHALL apply `WHERE deleted_at IS NULL` by default. `list(...)` SHALL accept an `includeDeleted: true` option to surface deleted rows. `AgentSessionsService.recentForContext(...)` SHALL apply BOTH `WHERE deleted_at IS NULL` AND the `sessionHasContent` predicate defined below; it SHALL NOT accept any option that bypasses either filter — memory-context callers SHALL never see deleted sessions and SHALL never see empty sessions.

`AgentSessionsService.findById(...)` SHALL NOT filter on `deleted_at` or on `sessionHasContent`. The detail surface must still be able to open and act on (e.g. undelete) any row regardless of content.

#### Scenario: softDelete sets deleted_at and hides the row from default list

- **GIVEN** an active session with `id = <S>` whose `deleted_at` is NULL
- **WHEN** the operator calls `softDelete(<S>, {adminBypass: true})`
- **THEN** the row's `deleted_at` SHALL be set to the current timestamp
- **AND** a subsequent `list()` SHALL NOT include the row
- **AND** a subsequent `list({includeDeleted: true})` SHALL include the row
- **AND** `findById(<S>)` SHALL still return the row

#### Scenario: softDelete is idempotent

- **GIVEN** a session whose `deleted_at` is already set
- **WHEN** the operator calls `softDelete` on it again
- **THEN** the call SHALL succeed and SHALL NOT modify `deleted_at`
- **AND** the returned row SHALL be the existing soft-deleted row

#### Scenario: undelete clears deleted_at

- **GIVEN** a soft-deleted session
- **WHEN** the operator calls `undelete` on it with `adminBypass: true`
- **THEN** `deleted_at` SHALL transition back to NULL
- **AND** the row SHALL re-appear in the default list

#### Scenario: Memories anchored to a soft-deleted session preserve their session_id

- **GIVEN** a memory whose `session_id` references session `<S>`
- **WHEN** session `<S>` is soft-deleted
- **THEN** the memory's `session_id` SHALL remain unchanged and SHALL continue to point at `<S>`

### Requirement: The dashboard MUST surface Delete + Undelete actions per session

The list view at `/dashboard/sessions` SHALL render an inline `<form action="/dashboard/sessions/<id>/delete" method="post">` per active row with a CSRF input and a `class="warn"` `Delete` button. The handler SHALL call `softDelete(id, {adminBypass: true})` and redirect to `/dashboard/sessions?deleted=<id>`. The list view SHALL render `?deleted=<id>` as a `flash success` containing an inline `Undelete` action.

The list view SHALL accept `?include_deleted=1` and render soft-deleted rows in a separate `<h2>Deleted</h2>` section beneath the Active table, mirroring how `/dashboard/projects` renders Archived projects.

The detail view at `/dashboard/sessions/:id` SHALL render whether the row is soft-deleted (regardless of the query parameter). When soft-deleted, the page SHALL display a `flash error` reading "This session is deleted." and the action area SHALL show an `Undelete` button (CSRF-protected) at `POST /dashboard/sessions/<id>/undelete` instead of `Delete`.

#### Scenario: Operator soft-deletes a session from the list view

- **GIVEN** an authenticated admin session and an active Rembric session row with id `<S>`
- **WHEN** the operator submits the row's Delete form
- **THEN** the response SHALL be a 302 redirect to `/dashboard/sessions?deleted=<S>`
- **AND** the row SHALL NOT appear in a subsequent GET of `/dashboard/sessions`
- **AND** the row SHALL appear in a subsequent GET of `/dashboard/sessions?include_deleted=1`

#### Scenario: Operator undeletes from the detail view

- **GIVEN** a soft-deleted session at `/dashboard/sessions/<S>` and an authenticated admin
- **WHEN** the operator submits the Undelete form
- **THEN** the response SHALL be a 302 redirect to `/dashboard/sessions`
- **AND** the row SHALL re-appear in the default list

#### Scenario: Delete without CSRF is rejected

- **GIVEN** an authenticated admin session
- **WHEN** a POST to `/dashboard/sessions/<S>/delete` arrives without the `csrf` field
- **THEN** the response SHALL be `403` with the standard `csrf_invalid` body

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

### Requirement: Session rows MUST carry a title column with write-once-final precedence

The `sessions` table SHALL gain a nullable `title TEXT` column and two boolean precedence columns: `summary_final` and `title_final` (default `false`). The title SHALL be initialised at row creation with a placeholder of the form `basename(cwd) · HH:MM UTC` (or `session · HH:MM UTC` when `cwd` is unavailable), stored with `title_final = false`.

`AgentSessionsService.ensure(...)` (the HTTP-path constructor) SHALL compute and write the placeholder title atomically with the row insert. `AgentSessionsService.start(...)` (the MCP-path constructor) SHALL do the same.

Writes that update `summary` or `title` carrying `final:true` SHALL flip the corresponding `_final` column to `true`. A subsequent write carrying `final:false` SHALL be a no-op for the corresponding field. A subsequent write carrying `final:true` SHALL replace the value (last-final-wins for admin/manual edits in future scope).

#### Scenario: Row insert writes placeholder title

- **WHEN** `ensure({id, cwd: '/Users/jane/projects/rembric', ...})` is called at 22:14 UTC and the row does not exist
- **THEN** the inserted row SHALL have `title = 'rembric · 22:14 UTC'` and `title_final = false`

#### Scenario: Final summary write blocks later non-final summary write

- **GIVEN** session `<S>` whose `summary` was written with `final:true` and `summary_final = true`
- **WHEN** another call attempts to write `summary` with `final:false`
- **THEN** the `summary` column SHALL remain unchanged
- **AND** `summary_final` SHALL remain `true`

#### Scenario: Non-final overwrite of placeholder title

- **GIVEN** session `<S>` with the placeholder title and `title_final = false`
- **WHEN** another call writes `title` with `final:false`
- **THEN** the `title` column SHALL be overwritten with the new value
- **AND** `title_final` SHALL remain `false`

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

### Requirement: The session purge journal is permanent

`consolidation_ops` rows written by `purgeEmpty` SHALL NOT themselves be subject to deletion. The journal preserves the audit trail of WHICH session ids existed and WHEN they were removed, even after the session rows are gone.

#### Scenario: A session purge journal row survives subsequent purges

- **GIVEN** `purgeEmpty` has run and produced a `consolidation_ops` row referencing 12 deleted session ids
- **WHEN** a subsequent `purgeEmpty` runs on a different set of session ids
- **THEN** the original `consolidation_ops` row SHALL still exist and its `affected_ids` SHALL still list the original 12 ids

### Requirement: `AgentSessionsService.markAbandoned()` MUST flip a single active session to abandoned with admin-bypass support

The service method `markAbandoned(sessionId: string, input?: { tokenId?: string; adminBypass?: boolean }): AgentSession` SHALL transition exactly one session row from `status = 'active'` to `status = 'abandoned'`, writing `ended_at = now()` in the same `UPDATE`. The transition rules are:

1. **Row lookup**. The service SHALL `SELECT` the row by `id`. If no row matches, it SHALL throw `DomainError('session_not_found', <message naming the id>)`.

2. **Token check**. When `input?.adminBypass` is not `true`, the service SHALL require `input?.tokenId` to equal the row's `token_id`. On mismatch (including `undefined` vs a row token id), the service SHALL throw `DomainError('forbidden', <message>)`. When `adminBypass: true`, the token check SHALL be skipped — mirroring the established pattern used by `softDelete` and `undelete`.

3. **Terminal-state handling**.
   - If the row's `status` is `'abandoned'`, the service SHALL return the existing row unchanged (idempotent no-op). It SHALL NOT mutate `ended_at`.
   - If the row's `status` is `'ended'`, the service SHALL throw `DomainError('session_already_ended', <message>)`. The reverse transition `ended → abandoned` SHALL NOT be allowed.

4. **Happy path**. When `status === 'active'`, the service SHALL emit an `UPDATE agent_sessions SET status='abandoned', ended_at = now() WHERE id = ?` and SHALL return the post-update row.

The method SHALL NOT mutate `agent`, `token_id`, `started_at`, `project_id`, `summary`, `title`, `summary_final`, `title_final`, or `deleted_at`. The only columns written are `status` and `ended_at`.

The method SHALL NOT call into `abandonStale` and `abandonStale` SHALL NOT call into `markAbandoned`; they are siblings serving distinct call sites (per-id operator surface vs. bulk reconciliation scheduler).

#### Scenario: markAbandoned flips an active session

- **GIVEN** a session with `id = <S>`, `status = 'active'`, `ended_at = NULL`, and `token_id = 't1'`
- **WHEN** `markAbandoned(<S>, { tokenId: 't1' })` is called
- **THEN** the row's `status` SHALL transition to `'abandoned'`
- **AND** `ended_at` SHALL be set to the current timestamp
- **AND** the returned value SHALL be the post-update row

#### Scenario: markAbandoned is idempotent on already-abandoned rows

- **GIVEN** a session with `status = 'abandoned'` and `ended_at = <T>`
- **WHEN** `markAbandoned` is called on it
- **THEN** the call SHALL succeed
- **AND** `ended_at` SHALL still equal `<T>` (no second write)
- **AND** the returned row SHALL be the existing one unchanged

#### Scenario: markAbandoned rejects ended sessions

- **GIVEN** a session with `status = 'ended'`
- **WHEN** `markAbandoned` is called on it
- **THEN** the service SHALL throw `DomainError('session_already_ended', ...)`
- **AND** the row SHALL NOT be mutated

#### Scenario: markAbandoned rejects cross-token without adminBypass

- **GIVEN** a session with `token_id = 't1'`
- **WHEN** `markAbandoned(<S>, { tokenId: 't2' })` is called
- **THEN** the service SHALL throw `DomainError('forbidden', ...)`
- **AND** the row SHALL NOT be mutated

#### Scenario: markAbandoned accepts cross-token with adminBypass

- **GIVEN** a session with `token_id = 't1'` and `status = 'active'`
- **WHEN** `markAbandoned(<S>, { adminBypass: true })` is called (no `tokenId` supplied)
- **THEN** the call SHALL succeed
- **AND** the row's `status` SHALL transition to `'abandoned'`

#### Scenario: markAbandoned throws on unknown id

- **WHEN** `markAbandoned('does-not-exist', { adminBypass: true })` is called
- **THEN** the service SHALL throw `DomainError('session_not_found', ...)`

### Requirement: `sessionHasContent` is the single source-of-truth predicate for "this session is worth surfacing"

`AgentSessionsService` SHALL define an internal SQL predicate, `sessionHasContent(s)`, returning TRUE for a `sessions` row `s` iff at least ONE of the following holds:

1. `s.summary IS NOT NULL`, OR
2. `s.title_final = 1`, OR
3. there exists at least one row in `memory` with `session_id = s.id`, OR
4. there exists at least one row in `prompts` with `session_id = s.id` AND `deleted_at IS NULL`, OR
5. there exists at least one row in `confirmations` with `session_id = s.id`.

This predicate governs **purge eligibility only**. It answers "would physically deleting this row dangle foreign-key references?" — and so any anchored content (memory / prompts / confirmations) keeps a session out of the purge set, regardless of whether the agent curated it. Surfacing to `memory.context` is governed by the separate, stricter predicate `sessionIsContextWorthy`.

Soft-deleted prompts (`deleted_at IS NOT NULL`) DO NOT make a session content-bearing; the operator has already marked them as obsolete.

The predicate SHALL be implemented as a single private SQL-fragment helper inside `apps/server/src/services/agent-sessions.ts`. It SHALL be the ONLY place in the codebase where this five-clause predicate is expressed. The `countPurgeableEmpty` and `purgeEmpty` methods SHALL consume the predicate in negated form (`NOT sessionHasContent(s)`) as part of their "purgeable" check. `recentForContext` SHALL NOT consume this predicate — it consumes `sessionIsContextWorthy` instead.

When a future content-bearing table is added with a `session_id` foreign key (the canonical example being a hypothetical `tool_calls` table), the predicate SHALL be the single point of update for the purge protection — the new EXISTS clause is added once, and `countPurgeableEmpty` / `purgeEmpty` pick the change up automatically.

#### Scenario: A session with a written summary satisfies the predicate

- **GIVEN** session `S` with `summary = 'Goal: ...'` and no anchored memory/prompt/confirmation rows
- **WHEN** any call site evaluates `sessionHasContent(S)`
- **THEN** the predicate SHALL return TRUE

#### Scenario: A session with no content fails the predicate

- **GIVEN** session `S` with `summary IS NULL`, `title_final = 0`, and zero anchored rows in `memory`, `prompts`, `confirmations`
- **WHEN** any call site evaluates `sessionHasContent(S)`
- **THEN** the predicate SHALL return FALSE

#### Scenario: A session with anchored memory is content-bearing even without curated summary

- **GIVEN** session `S` with `summary IS NULL`, `title_final = 0`, and at least one anchored row in `memory` with `session_id = S.id`
- **WHEN** `sessionHasContent(S)` is evaluated
- **THEN** the predicate SHALL return TRUE — the session is purge-protected to preserve referential integrity of the anchored memory

#### Scenario: Strict-subset relationship with `sessionIsContextWorthy`

- **GIVEN** the codebase as a whole
- **WHEN** a reviewer reads both predicate helpers
- **THEN** every clause of `sessionIsContextWorthy(s)` SHALL imply at least one clause of `sessionHasContent(s)` (a curated summary implies non-null summary; `title_final = 1` is a clause of `sessionHasContent` verbatim)
- **AND** a code search for the EXISTS-bearing 5-clause predicate SHALL return zero matches outside the `sessionHasContent` helper definition within `apps/server/src/services/agent-sessions.ts`

### Requirement: `recentForContext` MUST exclude empty sessions by default

`AgentSessionsService.recentForContext({projectId, limit})` SHALL return at most `limit` rows, ordered by `started_at DESC`, drawn from the set of sessions satisfying ALL of:

1. `deleted_at IS NULL` (soft-delete);
2. scope match (`projectId IS NULL` for global, or `project_id = ?` for path-scoped);
3. `sessionIsContextWorthy(s)` is TRUE.

Filtering SHALL precede truncation: a request with `limit: 5` SHALL return the five most-recent _context-worthy_ sessions, even if dozens of newer non-curated sessions exist between them. Non-curated sessions SHALL NEVER consume a slot in the response.

The method SHALL NOT accept any flag, option, or argument that bypasses the `sessionIsContextWorthy` filter. Operators who need to inspect non-curated sessions SHALL use `/dashboard/sessions`, which surfaces all rows regardless of curation.

Note: after the auto-curate path lands (see ADDED requirement above), most real-work sessions naturally become context-worthy at their terminal transition, so the population of `sessionIsContextWorthy(s) = TRUE` is the union of agent-curated rows AND server-auto-curated rows. The `[auto]` prefix on the latter is informational only; the predicate does not inspect the summary text.

#### Scenario: A non-curated session is excluded BEFORE terminal transition

- **GIVEN** an active session `M` with `summary_final = 0` AND one anchored memory row referencing `M.id`, plus an ended session `C` with `summary_final = 1`
- **WHEN** `recentForContext({projectId, limit: 5})` is called BEFORE `M` transitions to terminal
- **THEN** the result SHALL contain `C` and SHALL NOT contain `M`
- **AND** `M`'s memory still appears in the caller's `recentMemories[]` payload via `MemoryService.recentForContext`

#### Scenario: A non-curated session with anchored content surfaces AFTER terminal transition (auto-curate)

- **GIVEN** a session `M` that has 5 anchored memory rows but was never explicitly curated by the agent
- **WHEN** the agent calls `memory.session_end` on `M`, which fires the auto-curate path, AND THEN `recentForContext({projectId, limit: 5})` is called
- **THEN** the result SHALL contain `M` with `summary` matching the deterministic `[auto] N memorias…` template

#### Scenario: A non-curated session with no anchored content is excluded permanently

- **GIVEN** an ended session `T` with `summary_final = 0`, zero anchored rows, optionally with a non-final transcript dump in `summary`
- **WHEN** `recentForContext({projectId, limit: 5})` is called
- **THEN** `T` SHALL NOT appear in the result — auto-curate did not fire (no anchored content), the row stays non-context-worthy permanently

#### Scenario: Filter-then-truncate produces backfill semantics

- **GIVEN** a scope containing, in `started_at` order from newest to oldest: three non-curated sessions `A`, `B`, `C` (none with anchored content) and one curated session `U`
- **WHEN** `recentForContext({projectId, limit: 1})` is called
- **THEN** the result SHALL be `[U]` — the most-recent CURATED session, not the most-recent session overall

#### Scenario: Soft-deleted session with curated summary is still excluded

- **GIVEN** a session that has `summary_final = 1` AND is soft-deleted
- **WHEN** `recentForContext` is called
- **THEN** the row SHALL NOT appear in the result — both filters apply, neither overrides the other

### Requirement: `sessionIsContextWorthy` is the surfacing predicate for `memory.context`

`AgentSessionsService` SHALL define an internal SQL predicate, `sessionIsContextWorthy(s)`, returning TRUE for a `sessions` row `s` iff at least ONE of the following holds:

1. `s.summary IS NOT NULL` AND `s.summary_final = 1`, OR
2. `s.title_final = 1`.

The predicate SHALL be implemented as a single private SQL-fragment helper inside `apps/server/src/services/agent-sessions.ts`. It SHALL have exactly ONE consumer: `recentForContext`. It expresses the question "is this session worth surfacing to the LLM as a `recentSessions` entry?"

`sessionIsContextWorthy(s)` is a strict subset of `sessionHasContent(s)`: every context-worthy session is also content-bearing, but content-bearing sessions are not necessarily context-worthy. The distinction is intentional — purge protection and surfacing eligibility ask different questions:

- Purge protection asks "would deleting this row dangle foreign keys?" (`sessionHasContent`).
- Surfacing asks "does this row carry signal the LLM can read directly?" (`sessionIsContextWorthy`).

The two predicates SHALL coexist in the same source file and SHALL be the ONLY places where their respective SQL clauses are expressed.

#### Scenario: A session with a curated summary satisfies `sessionIsContextWorthy`

- **GIVEN** session `S` with `summary = 'Goal: …'` and `summary_final = 1`
- **WHEN** `sessionIsContextWorthy(S)` is evaluated
- **THEN** the predicate SHALL return TRUE

#### Scenario: A session with `title_final = 1` satisfies `sessionIsContextWorthy`

- **GIVEN** session `S` with `summary IS NULL` and `title_final = 1`
- **WHEN** `sessionIsContextWorthy(S)` is evaluated
- **THEN** the predicate SHALL return TRUE

#### Scenario: A session with anchored memory but no curated summary is content-bearing but not context-worthy by itself

- **GIVEN** session `S` with `summary IS NULL`, `title_final = 0`, AND at least one row in `memory` referencing `S.id`, evaluated BEFORE any terminal transition fires the auto-curate (e.g. mid-flight or status='active')
- **WHEN** `sessionHasContent(S)` and `sessionIsContextWorthy(S)` are both evaluated
- **THEN** `sessionHasContent(S)` SHALL return TRUE (purge-protected) AND `sessionIsContextWorthy(S)` SHALL return FALSE
- **AND** after the terminal transition fires, the auto-curate path SHALL elevate `S` to context-worthy by writing a derived summary (see `Auto-curate at terminal transition` requirement below)

#### Scenario: A session with only a transcript-fallback summary is neither content-bearing nor context-worthy

- **GIVEN** session `S` with `summary = '<raw transcript dump>'`, `summary_final = 0`, `title_final = 0`, and zero anchored rows in `memory`, `prompts`, `confirmations`
- **WHEN** `sessionHasContent(S)` and `sessionIsContextWorthy(S)` are both evaluated
- **THEN** both SHALL return FALSE — the row is purgeable AND it does not surface to the LLM (the auto-curate path also does NOT fire, since there is no anchored content to derive from)

### Requirement: Server-side auto-curate at terminal transition

When `AgentSessionsService.end(sessionId)` or `AgentSessionsService.abandonStale()` transitions a session from `active` to a terminal status (`ended` or `abandoned`), the service SHALL, in the same transaction:

1. Read the current `summary_final` flag.
2. If `summary_final = 1`, SKIP — the agent already curated, the curated text wins, no overwrite.
3. If `summary_final = 0` AND the session has at least one anchored row in `memory`, `prompts`, OR `confirmations`, COMPOSE a derived summary using the deterministic template defined below and WRITE it to the row with `summary_final = 1`.
4. If `summary_final = 0` AND the session has NO anchored content, SKIP — there is nothing to derive from. The session remains non-context-worthy and operator-purgeable.

The derivation template is the pure function `composeDerivedSummary(counts, lastMemoryContent)`:

```
parts := []
if counts.memories > 0:      parts.push(`${counts.memories} memorias`)
if counts.prompts > 0:       parts.push(`${counts.prompts} prompts`)
if counts.confirmations > 0: parts.push(`${counts.confirmations} confirmaciones`)

head := join(parts, ', ')
tail := lastMemoryContent ? ` — última: '${snippet(lastMemoryContent, 80)}'` : ''

return `[auto] ${head}${tail}`
```

The function SHALL be deterministic: same `counts` and `lastMemoryContent` produce the same output, byte-for-byte. The function SHALL NOT inspect the previous `summary` value, SHALL NOT call any LLM, SHALL NOT apply heuristics over the content. The `[auto]` prefix is mandatory and identifies the row as server-derived to both the agent and the operator.

The auto-curate write SHALL OVERWRITE any prior `final:false` `summary` value (a per-turn transcript dump written by a plugin Stop hook). The derived summary supersedes the transcript dump in the `summary` column; operators retain forensic visibility of anchored content via `/dashboard/sessions/:id` (the memories list, prompts list, and timing).

The auto-curate path SHALL be the SECOND writer that can lift `summary_final` to 1 (the first being the MCP tool `memory.session_summary`). Subsequent agent-issued `memory.session_summary` calls SHALL be able to overwrite an auto-curated row (see the modified `writeSummary` precedence below): agent intent always wins over server-derived content.

`countPurgeableEmpty` and `purgeEmpty` SHALL keep using `sessionHasContent` (5 clauses); auto-curated sessions naturally fail the `NOT sessionHasContent` predicate (their EXISTS-anchored content was the reason they were curated), so they are NOT purge-eligible.

#### Scenario: Agent curated before ending — auto-curate is a no-op

- **GIVEN** active session `S` with `summary_final = 1` (agent called `memory.session_summary` earlier)
- **WHEN** the agent calls `memory.session_end` on `S`
- **THEN** the service SHALL transition `S` to `ended` and SHALL NOT overwrite the curated summary
- **AND** `S.summary_final` SHALL remain 1, `S.summary` SHALL remain the agent's curated text

#### Scenario: Agent did not curate, session has anchored memory — auto-curate fires

- **GIVEN** active session `S` with `summary_final = 0`, `summary IS NULL` (or any non-final summary), and 5 anchored rows in `memory`, latest content `"Fixed null check in foo.ts when handler receives undefined"`
- **WHEN** the agent calls `memory.session_end` on `S`
- **THEN** the service SHALL atomically: set `status = 'ended'`, write `summary = "[auto] 5 memorias — última: 'Fixed null check in foo.ts when handler receives undefined'"`, set `summary_final = 1`, set `ended_at = now`
- **AND** `S` SHALL now satisfy `sessionIsContextWorthy` and surface in `memory.context.recentSessions`

#### Scenario: Agent did not curate, session has only transcript dump — auto-curate skips

- **GIVEN** active session `S` with `summary = '<raw transcript dump>'`, `summary_final = 0`, and zero anchored rows
- **WHEN** the agent calls `memory.session_end` on `S`
- **THEN** the service SHALL transition `S` to `ended` and SHALL NOT touch `summary` or `summary_final`
- **AND** `S` SHALL remain non-context-worthy (excluded from `memory.context.recentSessions`) and SHALL become purge-eligible after the 1h `ended_at` grace

#### Scenario: abandonStale transitions also trigger auto-curate

- **GIVEN** an active session `S` with `summary_final = 0`, 8 anchored memory rows, and `started_at` older than the abandonStale cutoff
- **WHEN** `abandonStale({olderThanMs})` runs (typically at server startup)
- **THEN** the service SHALL per-row: apply the auto-curate write (composing the derived summary) AND transition `status` to `abandoned` AND set `ended_at = now` — in a single transaction per session
- **AND** the returned `{ abandoned: N }` count SHALL match the number of sessions transitioned

#### Scenario: Auto-curate output is deterministic and structural

- **GIVEN** a session `S` with anchored counts `{ memories: 3, prompts: 2, confirmations: 0 }` and latest memory content `"Refactored the auth middleware to use jose"`
- **WHEN** `composeDerivedSummary` is called with those inputs
- **THEN** the output SHALL be exactly `"[auto] 3 memorias, 2 prompts — última: 'Refactored the auth middleware to use jose'"` — same input always produces same output, no LLM, no heuristic, no content inspection of the previous summary

### Requirement: `writeSummary` MUST allow `final:true` writes on terminal sessions

`AgentSessionsService.writeSummary(sessionId, input)` SHALL accept the write under either of two conditions, relaxing the previous "active-only" gate so that agents can override server auto-curated rows. The service is the shared entry point for both the MCP tool `memory.session_summary` (always `final:true`) and the HTTP fallback path `POST /api/<slug>/sessions/:id/summary` (always `final:false` after hardening).

The two acceptance conditions are:

1. The session's `status = 'active'` (the historical pre-existing rule), OR
2. The session's `status ∈ {'ended', 'abandoned'}` AND the incoming `input.final === true` — i.e., the agent is explicitly issuing a curated write on a terminal session.

Condition (2) exists so that an agent can OVERRIDE a server auto-curated row with its own curated summary at any point, including after the session has already transitioned. The HTTP fallback path cannot exploit this opening because the HTTP handlers hard-code `final: false`, so the HTTP-derived writes still hit condition (1)'s `status = 'active'` gate — only the MCP tool `memory.session_summary` can satisfy condition (2).

When the write is accepted under condition (2), the precedence rule applies as usual: `summary` (and optionally `title`) are overwritten, `summary_final` (and `title_final`) are set to 1, `status`/`ended_at` are NOT modified.

When the incoming write is `final:false` on a terminal session (HTTP path or otherwise), the call SHALL be rejected with `session_already_ended`.

#### Scenario: Agent overrides an auto-curated ended session via `memory.session_summary`

- **GIVEN** session `S` is `ended` with `summary = '[auto] 5 memorias — última: …'` and `summary_final = 1` (server auto-curated)
- **WHEN** the agent calls `memory.session_summary({summary: 'Goal: X. Files: Y.', title: 'Refactor'})` against `S`
- **THEN** the server SHALL accept the write (condition 2)
- **AND** `S.summary` SHALL become `'Goal: X. Files: Y.'`, `S.title` SHALL become `'Refactor'`, `S.summary_final` SHALL remain 1, `S.title_final` SHALL become 1
- **AND** `S.status` SHALL remain `'ended'` (unchanged)

#### Scenario: HTTP fallback cannot exploit the relaxation

- **GIVEN** an ended session `S`
- **WHEN** an HTTP client POSTs `{summary: 'transcript', final: true}` to `/api/<slug>/sessions/:id/summary` (the body's `final` field is dropped by the zod schema and the handler hard-codes `false`)
- **THEN** the service-level call is `writeSummary(S, {final: false})`, which fails condition (1) (`status != 'active'`) and condition (2) (`final !== true`), and SHALL be rejected with `session_already_ended`

#### Scenario: `final:true` write on an active session is unchanged

- **GIVEN** an active session `S` with `summary_final = 0`
- **WHEN** the agent calls `memory.session_summary({summary: 'Goal: X'})` (the MCP handler injects `final: true`)
- **THEN** the write is accepted under condition (1) and `S.summary_final` becomes 1, exactly as before this change
