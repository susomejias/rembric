## ADDED Requirements

### Requirement: Sessions MUST be append-only

The system SHALL never delete a session row and SHALL never mutate the `agent`, `token_id`, `started_at`, or `project_id` of an existing session. Lifecycle changes are expressed exclusively by transitioning the `status` column among `active`, `ended`, and `abandoned`, and by writing the `ended_at` and `summary` columns at most once per session.

#### Scenario: Code path attempts to delete a session
- **WHEN** any service or migration emits a `DELETE FROM sessions` statement
- **THEN** a CI invariant test SHALL fail and the build SHALL be rejected

#### Scenario: Code path attempts to mutate an immutable session column
- **WHEN** any service emits an `UPDATE sessions SET agent = ?` or `UPDATE sessions SET started_at = ?` statement
- **THEN** a CI invariant test SHALL fail and the build SHALL be rejected

#### Scenario: Two `memory.session_end` calls for the same session id
- **WHEN** `memory.session_end` is called twice on the same session id
- **THEN** the second call SHALL fail with code `session_already_ended` and SHALL NOT mutate `ended_at` or `summary`

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

When `memory.session_summary` is called, the submitted `summary` SHALL be persisted verbatim in the session row's `summary` column. The tool description SHALL document the canonical structure (Goal / Discoveries / Accomplished / Next Steps / Relevant Files), but the server SHALL NOT enforce the layout — agents may submit free-form text.

#### Scenario: `memory.session_summary` is called with a non-empty summary
- **WHEN** the agent submits a `summary` string of length >= 1
- **THEN** the server SHALL set `summary`, `ended_at`, and `status = 'ended'` atomically and SHALL return `{ ok: true, sessionId, endedAt }`

#### Scenario: `memory.session_summary` is called with an empty summary
- **WHEN** the agent submits a `summary` string of length 0 or only whitespace
- **THEN** the call SHALL be rejected with code `invalid_input` and SHALL NOT mutate the row

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
