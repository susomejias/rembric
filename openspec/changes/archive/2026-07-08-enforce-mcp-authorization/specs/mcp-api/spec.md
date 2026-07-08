## ADDED Requirements

### Requirement: Every MCP tool call MUST be authorized against the token's scope

Every registered MCP tool except `memory.about` SHALL be classified as `read` or `write` and SHALL, before touching any data, resolve the connection's effective scope through the single async resolver (path slug → roots discovery → `SessionRouter`) and check `isAuthorized(tokenScope, action, resolvedScope)`. A failed check SHALL be rejected with code `forbidden`. Tools that accept a `scope` input (`memory.save`, `memory.search`) SHALL authorize the requested scope after their existing input-driven resolution. The path-scoping error contract (`scope_locked`, `project_required`, `project_not_found`, `project_suggestion_pending`) SHALL be preserved unchanged and SHALL be evaluated before the authorization check where it applies today.

Write classification: `memory.save`, `memory.save_prompt`, `memory.capture_passive`, `memory.confirm`, `memory.judge`, `memory.session_start`, `memory.session_summary`, `memory.session_end`. Read classification: `memory.search`, `memory.get`, `memory.context`, `memory.timeline`, `memory.stats`, `memory.doctor`, `memory.search_prompts`, `memory.suggest_topic_key`, `memory.session_get`, `memory.compare`, `project.use` (against the requested project), `project.current`. `project.list` SHALL filter its result to the projects the token is authorized to read: `*` and `read:*` tokens see all projects; `project:<id>` and `read:project:<id>` tokens see only that project.

#### Scenario: Read-restricted token attempts a formerly-ungated write

- **GIVEN** a token with scope `read:*` or `read:project:<id>`
- **WHEN** the token invokes `memory.capture_passive`, `memory.save_prompt`, `memory.session_start`, or `memory.judge`
- **THEN** the call SHALL be rejected with code `forbidden` and no row SHALL be written

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

### Requirement: `memory.judge` and `memory.compare` MUST validate their targets against the connection's effective scope

`memory.judge` SHALL resolve the pending judgment (and `memory.compare` its two memories) through a scope-parameterized service read using the connection's effective scope. A judgment or memory outside that scope SHALL be rejected with code `not_found` (never `forbidden`), so cross-scope existence does not leak, matching the cross-scope-read invariant of `memory.get`.

#### Scenario: Judging a pending relation that belongs to another project

- **GIVEN** a pending judgment created in project B
- **WHEN** a connection whose effective scope is project A (any token) calls `memory.judge` with that `judgmentId`
- **THEN** the call SHALL be rejected with code `not_found` and the relation SHALL remain pending

#### Scenario: Comparing memories from another scope

- **WHEN** a connection whose effective scope is project A calls `memory.compare` naming a memory stored in global scope or project B
- **THEN** the call SHALL be rejected with code `not_found`

#### Scenario: A bogus judgmentId is indistinguishable from an out-of-scope one

- **WHEN** `judgmentId` matches no row anywhere (never existed), single form
- **THEN** the call SHALL be rejected with code `not_found` — the same code an out-of-scope-but-existing `judgmentId` produces, so a caller cannot use the response to infer whether the id exists in another scope. This supersedes the literal `memory_not_found` code the (now-internal-only) unscoped `RelationsService.judge` raises; `memory.judge` always calls the scope-parameterized `judgeInScope`, whose "not found" and "found but out of scope" paths are the same query and therefore the same code.
- **AND** in the batch form, each item's `code` field follows the same rule: an unknown-or-out-of-scope `judgmentId` reports `code: 'not_found'`, not `memory_not_found`

### Requirement: Scope-sensitive tools MUST share the single async scope resolver

All scope-sensitive tools SHALL resolve the effective project through the same async resolver that `memory.save` uses (awaiting roots discovery on unscoped connections). The sync resolver that skipped discovery SHALL be removed. Write tools on unscoped connections SHALL honor the `project_suggestion_pending` gate exactly as `memory.save` does.

#### Scenario: `memory.context` at session start on an unscoped connection

- **GIVEN** an unscoped `/mcp` connection whose project is resolvable via MCP roots discovery
- **WHEN** the agent's first tool call is `memory.context` (before any other call has populated the router)
- **THEN** the server SHALL await roots discovery and return the PROJECT's context, not global context

#### Scenario: `memory.capture_passive` while a project suggestion is pending

- **GIVEN** an unscoped `/mcp` connection with a pending project suggestion
- **WHEN** the agent calls `memory.capture_passive` or `memory.save_prompt`
- **THEN** the call SHALL be rejected with code `project_suggestion_pending`, identically to `memory.save`

## MODIFIED Requirements

### Requirement: The MCP server MUST expose two observability tools

The `/mcp` and `/mcp/<slug>` endpoints SHALL register `memory.doctor` and `memory.stats`.

#### Scenario: `memory.doctor` returns an operational report

- **WHEN** an MCP client calls `memory.doctor`
- **THEN** the server SHALL return `{ db: { open, journalMode, integrity, sizeBytes }, embeddings: { model, backlog }, consolidation: { lastRunAt, lastRunOps }, sessions: { active }, warnings: string[] }` — the report SHALL NOT contain an `llm` block, and the `embeddings` block SHALL NOT contain `enabled` (embeddings are always on); `model` SHALL identify the compiled-in embedding model

#### Scenario: `memory.stats` returns counters by scope and status

- **WHEN** an MCP client calls `memory.stats`
- **THEN** the server SHALL return `{ memoriesByStatus, memoriesByType, memoriesByScope, sessionsByStatus, totalProjects, totalTokens }` with each value being a `Record<string, number>` of counts scoped to the request context

#### Scenario: A read-only token calls `memory.doctor` or `memory.stats`

- **WHEN** the caller's scope is `read:*`, or is `read:project:<id>` and the connection's effective scope resolves to that same project
- **THEN** both tools SHALL succeed (they are read-only by design)
- **WHEN** the caller's scope is `read:project:<id>` and the connection's effective scope resolves to global or to a different project
- **THEN** the call SHALL be rejected with code `forbidden`

### Requirement: The MCP server MUST expose `memory.compare`

The server SHALL register a `memory.compare` tool that records a verdict on two arbitrary memories without a preceding save. The schema SHALL be `{ memoryIdA: string, memoryIdB: string, relation: enum (excluding 'not_conflict'), reason?: string, confidence: number, evidence?: any }`. The verdict SHALL be persisted as a `memory_relations` row with `status = 'judged'` from the start. Both memories SHALL first be resolved against the connection's effective scope (per the cross-scope-target requirement above) before any cross-scope-tuple comparison between the two memories themselves is considered.

#### Scenario: Comparing two memories from independent analysis

- **WHEN** the agent calls `memory.compare({memoryIdA: 'X', memoryIdB: 'Y', relation: 'related', confidence: 0.9, reason: 'both describe auth token rotation'})`
- **THEN** a `memory_relations` row SHALL be inserted with `source_id = X`, `target_id = Y`, `relation = 'related'`, `status = 'judged'`, `marked_by_kind = 'agent'`

#### Scenario: Comparing the same pair twice (idempotency)

- **WHEN** `memory.compare` is called twice with the same `(memoryIdA, memoryIdB)` ordered pair and different `relation` values
- **THEN** the existing row SHALL be UPDATED (relation, reason, confidence, judged_at refreshed); a new row SHALL NOT be inserted

#### Scenario: Comparing across scopes relative to the connection

- **WHEN** `memory.compare` is called with two memories from different `(scope, project_id)` tuples
- **THEN** at least one of the two necessarily lies outside the connection's effective scope, so the call SHALL be rejected with code `not_found` (per the cross-scope-target requirement) — the legacy `cross_scope_relation` code is superseded at the tool surface by this masking rule; the underlying `RelationsService.compare` defensive check (and its `cross_scope_relation` error) remains in place for same-scope-resolved callers that do not go through the connection-scoped path (e.g. `memory.save`'s topic_key supersede)

#### Scenario: Comparing with the `not_conflict` relation

- **WHEN** `memory.compare` is called with `relation: 'not_conflict'`
- **THEN** the call SHALL be rejected with code `invalid_input`; `not_conflict` is only valid as a `memory.judge` verdict (it answers "the save-time candidate was a false positive"), not as a proactive comparison
