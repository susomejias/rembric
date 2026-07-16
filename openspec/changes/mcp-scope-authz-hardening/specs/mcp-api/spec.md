## MODIFIED Requirements

### Requirement: Every MCP tool call MUST be authorized against the token's scope

Every registered MCP tool except `memory.about` SHALL be classified as `read` or `write` and SHALL, before touching any data, resolve the connection's effective scope through the single async resolver (path slug → roots discovery → `SessionRouter`) and check `isAuthorized(tokenScope, action, resolvedScope)`. A failed check SHALL be rejected with code `forbidden`. Tools that accept a `scope` input (`memory.save`, `memory.search`) SHALL authorize the requested scope after their existing input-driven resolution. The path-scoping error contract (`scope_locked`, `project_required`, `project_not_found`, `project_suggestion_pending`) SHALL be preserved unchanged and SHALL be evaluated before the authorization check where it applies today.

Write classification: `memory.save`, `memory.save_prompt`, `memory.capture_passive`, `memory.confirm`, `memory.judge`, `memory.compare`, `memory.session_start`, `memory.session_summary`, `memory.session_end`. `memory.compare` is a write because it always persists a `memory_relations` row (`status='judged'`) and, for `relation='supersedes'`, flips the target memory's `status` to `superseded` and appends to the source's `replaces[]` — a lifecycle mutation, not a read. Read classification: `memory.search`, `memory.get`, `memory.context`, `memory.timeline`, `memory.stats`, `memory.doctor`, `memory.search_prompts`, `memory.suggest_topic_key`, `memory.session_get`, `project.use` (against the requested project), `project.current`. `project.list` SHALL filter its result to the projects the token is authorized to read: `*` and `read:*` tokens see all projects; `project:<id>` and `read:project:<id>` tokens see only that project.

`project.use({autocreate: true})` on a slug that does not yet exist is a WRITE (it mints a new project row), even though `project.use` is otherwise read-classified: the server SHALL check `isAuthorized(tokenScope, 'write', {scope: 'project', projectId: null})` before creating the row. `autocreate: true` against an ALREADY-existing slug is unaffected (no row is created, so the normal read check against the resolved project applies).

#### Scenario: Read-restricted token attempts a formerly-ungated write

- **GIVEN** a token with scope `read:*` or `read:project:<id>`
- **WHEN** the token invokes `memory.capture_passive`, `memory.save_prompt`, `memory.session_start`, or `memory.judge`
- **THEN** the call SHALL be rejected with code `forbidden` and no row SHALL be written

#### Scenario: Read-restricted token attempts memory.compare

- **GIVEN** a token with scope `read:*` or `read:project:<id>`
- **WHEN** the token invokes `memory.compare` with any two in-scope memories
- **THEN** the call SHALL be rejected with code `forbidden`, no `memory_relations` row SHALL be written, and no target memory's `status` SHALL change

#### Scenario: A read-only token cannot autocreate a project

- **GIVEN** a token with scope `read:*` or `read:project:<id>`
- **WHEN** the token calls `project.use({slug: 'brand-new-slug', autocreate: true})` for a slug that does not yet exist
- **THEN** the call SHALL be rejected with code `forbidden` and no project row SHALL be created

#### Scenario: A full-access token can still autocreate a project

- **GIVEN** a token with scope `*`
- **WHEN** the token calls `project.use({slug: 'brand-new-slug', autocreate: true})` for a slug that does not yet exist
- **THEN** the project SHALL be created and the call SHALL succeed

#### Scenario: Project-restricted token reads another project's context

- **GIVEN** a token with scope `read:project:A` or `project:A`
- **WHEN** the token opens `/mcp/B` (or resolves project B via `project.use`/roots discovery) and calls `memory.context`, `memory.timeline`, `memory.stats`, `memory.search_prompts`, or `memory.session_get`
- **THEN** the call SHALL be rejected with code `forbidden` and no project-B data SHALL be returned

#### Scenario: Project-restricted token on an unscoped connection resolving global scope

- **GIVEN** a token with scope `read:project:A` connected to `/mcp` with no active project
- **WHEN** the token calls a read tool whose effective scope resolves to global
- **THEN** the call SHALL be rejected with code `forbidden`; after `project.use A` (authorized) the same call SHALL succeed against project A

#### Scenario: `project.list` is filtered by token scope

- **GIVEN** projects A and B exist and a token with scope `project:A`
- **WHEN** the token calls `project.list`
- **THEN** the response SHALL contain project A only

#### Scenario: Full-access tokens are unaffected

- **GIVEN** a token with scope `*`
- **WHEN** it invokes any tool on any `/mcp*` connection
- **THEN** authorization SHALL never reject the call (path-scoping errors still apply)

### Requirement: Tools that attach a write to a session MUST accept an explicit `sessionId` override, reinforced in their descriptions

`memory.save`, `memory.session_summary`, `memory.session_end`, `memory.save_prompt`, and `memory.capture_passive` SHALL accept an optional `sessionId: string` argument. When provided, it SHALL take precedence over the transport's own session resolution (the `SessionRouter` entry, then the ambiguous-active-session fallback) — mirroring the explicit-first precedence `memory.session_summary`/`memory.session_end` already apply via `resolveSessionId`. Each tool's description SHALL mention `sessionId` explicitly (not only via the input schema's per-argument `describe()`, since some MCP clients do not surface per-property schema descriptions to the model) with guidance to pass it only if genuinely known and never invent one.

An explicit `sessionId` SHALL be validated before it is honored. The server SHALL resolve the named session row and require that it (a) is owned by the caller's token (`token_id` matches the request context), (b) belongs to the caller's effective project (`project_id` equals the connection's resolved project id, where a global-scope write requires `project_id IS NULL`), and (c) is not soft-deleted (`deleted_at IS NULL`). When (a) or (b) fails, the call SHALL be rejected with code `session_not_found` — the same masking code the session-lifecycle tools use, so a caller cannot probe which session ids exist under other tokens or projects. When (a) and (b) pass but (c) fails, the call SHALL be rejected with code `session_deleted`. On rejection no row SHALL be written and no session state SHALL be mutated. Validation applies only when `sessionId` is explicitly supplied; the transport/active-session fallback paths (no explicit id) are unchanged and already resolve to a session owned by the caller within the effective scope. An `ended` (but not soft-deleted) session remains a valid attachment target.

This closes a blind spot: `memory.session_summary`'s and `memory.session_end`'s zod schemas already declared `sessionId` as optional, but their tool descriptions never mentioned it — a model reading only the description had no reason to believe passing it was possible. `memory.save` and `memory.save_prompt` did not accept the argument at all prior to this requirement. It also closes a security blind spot: prior to this requirement an explicit `sessionId` was honored verbatim (`if (explicit) return explicit;`) with no ownership/project/soft-delete check, letting a caller forge an attachment to another token's or another project's session.

#### Scenario: memory.save accepts and prioritizes an explicit sessionId

- **GIVEN** the caller owns an active session `<S>` within the connection's effective scope
- **WHEN** the agent calls `memory.save({..., sessionId: '<S>'})` with an explicit, valid session id
- **THEN** the saved memory's `session_id` SHALL be `'<S>'`, NOT null — the explicit value bypasses the ambiguous fallback entirely

#### Scenario: memory.save_prompt accepts and prioritizes an explicit sessionId

- **GIVEN** the caller owns an active session `<S>` within the connection's effective scope
- **WHEN** the agent calls `memory.save_prompt({content, title, sessionId: '<S>'})`
- **THEN** the persisted prompt row's `session_id` SHALL be `'<S>'`

#### Scenario: Tool descriptions mention sessionId explicitly

- **WHEN** the `initialize`/`tools/list` descriptions for `memory.save`, `memory.session_summary`, `memory.session_end`, `memory.save_prompt`, and `memory.capture_passive` are inspected
- **THEN** each SHALL contain the substring `sessionId` with guidance not to invent one when unknown

#### Scenario: An explicit sessionId owned by a different token is rejected

- **GIVEN** a session `<S>` owned by token `<T1>`
- **WHEN** a caller authenticated as a different token `<T2>` calls `memory.save`, `memory.save_prompt`, or `memory.capture_passive` with `sessionId = '<S>'`
- **THEN** the call SHALL be rejected with code `session_not_found` and no row SHALL be written

#### Scenario: An explicit sessionId from another project is rejected

- **GIVEN** the caller's token owns a session `<S>` whose `project_id` is project B
- **WHEN** the caller, on a connection whose effective scope is project A (or global), calls a write-attaching tool with `sessionId = '<S>'`
- **THEN** the call SHALL be rejected with code `session_not_found` and no row SHALL be written

#### Scenario: An explicit sessionId naming a soft-deleted session is rejected

- **GIVEN** the caller's token owns a session `<S>` in the effective project whose `deleted_at` is non-null
- **WHEN** the caller calls a write-attaching tool with `sessionId = '<S>'`
- **THEN** the call SHALL be rejected with code `session_deleted` and no row SHALL be written

## ADDED Requirements

### Requirement: `memory.timeline` session neighbors MUST be filtered by the connection's effective scope

`memory.timeline`'s session-neighbor query (used when the target memory has a non-null `session_id`) SHALL filter neighbors by the connection's effective `(scope, project_id)` in addition to `session_id`, so a neighbor lying outside the effective scope is never returned. Filtering by `session_id` alone is insufficient because a single session can hold memories in more than one scope (an unscoped `/mcp` connection can save a global memory and a project memory within the same session) and because `session_id` carries no foreign key — so without a scope predicate `memory.timeline` could return another scope's memory `content`, violating the cross-scope-read invariant that a target memory's own scope gate is meant to uphold. The time-window fallback neighbor query already applies this `(scope, project_id)` filter; the session-neighbor query SHALL match it.

#### Scenario: A same-session memory in another scope is not returned

- **GIVEN** a target memory `<M>` in project A with `session_id = <S>`, and another memory `<G>` in global scope (or project B) that also carries `session_id = <S>`
- **WHEN** a connection whose effective scope is project A calls `memory.timeline` with `{ memoryId: '<M>' }`
- **THEN** the returned `before`/`after` neighbors SHALL NOT include `<G>` or its `content`

#### Scenario: In-scope session neighbors are still returned

- **GIVEN** a target memory `<M>` in project A with `session_id = <S>`, and other project-A memories sharing `session_id = <S>`
- **WHEN** a connection whose effective scope is project A calls `memory.timeline` with `{ memoryId: '<M>', before: 5, after: 5 }`
- **THEN** the in-scope same-session neighbors SHALL be returned, ordered chronologically, exactly as before this change
