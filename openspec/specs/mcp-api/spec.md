# mcp-api Specification

## Purpose

Defines the Model Context Protocol surface exposed by Rembric over Streamable HTTP, including transport, project scoping, authentication, tool contracts (`memory.save`, `memory.search`, `memory.get`, `memory.confirm`), and error conventions.

## Requirements

### Requirement: The MCP endpoint MUST use Streamable HTTP transport

The server SHALL expose the Model Context Protocol over the Streamable HTTP transport at `/mcp`, using `@modelcontextprotocol/sdk`. The legacy SSE transport SHALL NOT be exposed.

#### Scenario: Client initiates a session

- **WHEN** an MCP client opens a session against `/mcp` using the Streamable HTTP transport
- **THEN** the server SHALL respond with a valid initialize result advertising the registered tools

### Requirement: Path-scoped connections MUST enforce strict project isolation

When the MCP connection is path-scoped (`/mcp/<slug>` or via `X-Rembric-Project` header) the server SHALL enforce a hard isolation contract on every tool call. The connection's project is the only scope visible:

- `memory.save` with `scope='global'` SHALL be rejected with structured code `scope_locked`.
- `memory.save` with `scope='project'` SHALL be persisted with `project_id` equal to the path-bound project regardless of any other argument the agent supplies.
- `memory.search` SHALL return only memories whose `scope = 'project'` and `project_id` equals the bound project; global memories SHALL NOT be returned. The `includeGlobal` argument SHALL be ignored on path-scoped connections.
- `memory.get` and `memory.confirm` SHALL respond with structured code `not_found` when the requested memory is global or belongs to a different project, regardless of whether the memory exists, to avoid leaking existence across scopes.

#### Scenario: save with scope='global' on a path-scoped connection

- **GIVEN** a client connected at `/mcp/foo` with a valid token
- **WHEN** the client calls `memory.save` with `scope='global'`
- **THEN** the response SHALL be an MCP error containing `code: 'scope_locked'` and a message naming the bound project

#### Scenario: search on a path-scoped connection does not leak globals

- **GIVEN** a path-scoped connection at `/mcp/foo` and at least one memory with `scope='global'`
- **WHEN** the client calls `memory.search` with or without `includeGlobal=true`
- **THEN** the response SHALL NOT contain any memory whose `scope='global'`

#### Scenario: get across project boundaries

- **GIVEN** a path-scoped connection at `/mcp/foo` and a memory M with `scope='project'`, `project_id='bar'`
- **WHEN** the client calls `memory.get('M')`
- **THEN** the response SHALL be an MCP error with `code: 'not_found'`, identical to the response for a non-existent id

### Requirement: The MCP endpoint MUST support path-based project scoping

The server SHALL accept MCP requests at `/mcp` (global) and at `/mcp/<project-slug>` (project-scoped). When the path includes a non-empty slug after `/mcp/`, the server SHALL resolve that slug to a project via `projects.findOrCreate(slug)` and SHALL use the resulting project as the request's project scope. The path slug SHALL take precedence over any `X-Rembric-Project` header.

#### Scenario: Connecting at a project-scoped path

- **WHEN** an MCP client connects to `/mcp/my-app` with a valid token
- **THEN** the server SHALL resolve `my-app` to a project row (creating it if needed) and every tool call in that session SHALL behave as if `X-Rembric-Project: my-app` were present

#### Scenario: Path slug and conflicting header

- **GIVEN** a client connecting to `/mcp/foo` while also sending `X-Rembric-Project: bar`
- **WHEN** the server processes the request
- **THEN** the project SHALL resolve to `foo` (the path wins); the header SHALL be ignored

#### Scenario: Global connection

- **WHEN** an MCP client connects to `/mcp` without a slug and without `X-Rembric-Project`
- **THEN** the request SHALL be accepted without a project scope; tools that require a project (e.g. `memory.save` with `scope='project'`) SHALL respond with a structured error code `project_required` whose message instructs the operator to reconnect at `/mcp/<slug>` or supply the header

### Requirement: Every MCP request MUST be authenticated

The server SHALL reject any request to `/mcp` that does not include a valid bearer token in the `Authorization` header. Tokens SHALL be matched against the `tokens` table by hash; revoked or expired tokens SHALL be rejected.

#### Scenario: Missing token

- **WHEN** a request arrives at `/mcp` without an `Authorization` header
- **THEN** the response SHALL be `401 Unauthorized` and no MCP handshake SHALL be performed

#### Scenario: Revoked token

- **GIVEN** a token whose `revoked_at` is set
- **WHEN** a request arrives at `/mcp` with that token
- **THEN** the response SHALL be `401 Unauthorized`

#### Scenario: Expired token

- **GIVEN** a token whose `expires_at` is in the past
- **WHEN** a request arrives at `/mcp` with that token
- **THEN** the response SHALL be `401 Unauthorized`

### Requirement: Tool inputs MUST be validated by zod

Every MCP tool SHALL declare its input schema with zod, and the SDK shall reject calls with invalid arguments before the tool handler runs. Tool handlers SHALL NOT need to re-validate primitive fields.

#### Scenario: Invalid input

- **WHEN** an MCP client calls `memory.save` with `content` set to an integer
- **THEN** the tool SHALL respond with an MCP error indicating the schema violation and SHALL NOT touch the database

### Requirement: memory.save MUST accept a `topic_key` and surface candidates

The `memory.save` tool's input schema SHALL gain an optional `topic_key?: string` argument (max length 128, NUL-byte rejected). The response shape SHALL be extended with two additional fields: `candidates: Array<Candidate>` (always present, empty when none found) and `judgmentRequired: boolean`. Existing fields (`id`, `status`, `createdAt`) are unchanged.

The `Candidate` type:

```ts
{
  judgmentId: string;
  targetId: string;
  snippet: string; // first ~200 chars of the candidate's content
  similarity: number; // 0..1, max(vec, fts) normalized
  source: 'vec' | 'fts'; // which detector surfaced it
}
```

#### Scenario: memory.save with no `topic_key` and zero candidates

- **WHEN** `memory.save({type, content})` is called and no existing memory matches the candidate-detection thresholds
- **THEN** the response SHALL be `{ id, status: 'active', createdAt, candidates: [], judgmentRequired: false }`

#### Scenario: memory.save with `topic_key` upserting an existing row

- **WHEN** `memory.save({type, content, topic_key: 'arch/auth'})` is called and an active memory with that key exists in scope
- **THEN** the response SHALL include the newly created `id`; the previous row SHALL be in `status = 'superseded'`; `candidates` MAY additionally include unrelated rows surfaced by FTS/vec; `judgmentRequired` reflects only the candidates surfaced via that path, not the topic-key upsert (which is already judged)

#### Scenario: memory.save with embeddings disabled and FTS matches

- **GIVEN** `EMBEDDING_ENABLED = false`
- **WHEN** `memory.save` finds three FTS5 matches above threshold
- **THEN** the response SHALL include three candidates each with `source: 'fts'`; no vec-sourced candidates SHALL appear

#### Scenario: memory.save with `topic_key` longer than 128 chars

- **WHEN** the input `topic_key` exceeds 128 characters
- **THEN** the call SHALL be rejected with code `invalid_input` and SHALL NOT insert any row

### Requirement: memory.search response MUST include relation annotations

The `memory.search` response SHALL include a `relations` array on each result row, populated in a single JOIN over `memory_relations`. Annotation kinds: `supersedes`, `superseded_by`, `conflicts_with`, `related`, `compatible`, `scoped`, `pending_conflict`. Each annotation SHALL include the target id and (when judged) a short snippet of the target's content.

#### Scenario: A search result row reports its relations

- **WHEN** `memory.search` returns memory N which has a judged `supersedes` relation to memory M and a pending relation to memory Q
- **THEN** the result row SHALL include `relations: [{ kind: 'supersedes', targetId: 'M', snippet }, { kind: 'pending_conflict', targetId: 'Q', judgmentId }]`

#### Scenario: The annotation set respects the cap

- **GIVEN** memory N has 25 rows in `memory_relations`
- **WHEN** the cap is 10
- **THEN** the response SHALL include the 10 most recent annotations; the rest are accessible via the dashboard

### Requirement: The `memory.get` tool MUST return the memory and its history

`memory.get` SHALL accept an `id` and SHALL return the memory's content, status, scope, project, tags, source, and the full chain of predecessors derived from `replaces`, plus the confirmation count for the current head.

#### Scenario: Retrieve a merged memory

- **WHEN** an authenticated client calls `memory.get` with the id of a merged memory M
- **THEN** the response SHALL include M's content, M's predecessor ids, their content snapshots, and the confirmation count against M

### Requirement: The `memory.confirm` tool MUST follow the supersedes chain

`memory.confirm` SHALL accept an `id` and SHALL insert a `confirmations` row for the current head of the supersedes chain reachable from `id`. The tool SHALL NOT mutate any `memory` row.

#### Scenario: Confirming an outdated id

- **GIVEN** memory A is superseded by M
- **WHEN** an authenticated client calls `memory.confirm('A')`
- **THEN** a row SHALL be inserted into `confirmations` with `memory_id = 'M'` and no `memory` row SHALL be updated

### Requirement: Errors MUST follow MCP conventions

The server SHALL return MCP-conformant errors for invalid operations, including helpful messages but never leaking secrets or internal stack traces.

#### Scenario: Unknown tool

- **WHEN** a client invokes a tool name not registered by the server
- **THEN** the response SHALL be an MCP error of the appropriate code with a human-readable message identifying the missing tool

#### Scenario: Internal error

- **WHEN** a tool handler throws an unexpected exception
- **THEN** the response SHALL be an MCP error with a generic message and an error id; the full stack SHALL be logged server-side but NOT returned to the client

### Requirement: The four existing memory tools MUST advertise protocol-teaching descriptions

The descriptions of `memory.save`, `memory.search`, `memory.get`, and `memory.confirm` SHALL begin with a "Call this WHEN …" trigger list before documenting the request/response shape. The request and response shapes themselves are unchanged.

#### Scenario: `memory.save` description teaches the trigger list

- **WHEN** an MCP client retrieves the tool description for `memory.save` via `tools/list`
- **THEN** the description SHALL contain the substring `Call this IMMEDIATELY after` followed by a list including at least: bug fix, decision, discovery, configuration change, pattern, user preference

#### Scenario: `memory.search` description teaches when to call

- **WHEN** an MCP client retrieves the tool description for `memory.search`
- **THEN** the description SHALL contain wording instructing the agent to call it whenever the user references past work or asks to recall ("remember", "recall", "what did we do")

#### Scenario: An accidental edit removes the protocol-teaching phrase

- **WHEN** a developer rewrites a tool description in a way that removes the `Call this …` trigger
- **THEN** a CI test SHALL fail asserting the presence of the trigger phrase, and the build SHALL be rejected

### Requirement: The MCP server MUST expose three session-lifecycle tools

The `/mcp` and `/mcp/<slug>` endpoints SHALL register the tools `memory.session_start`, `memory.session_end`, and `memory.session_summary` with the following contracts. The tools are split by responsibility: `memory.session_start` opens a session, `memory.session_summary` writes summary/title without transitioning, `memory.session_end` is the sole state transition. This is a behaviour change from the prior contract where `memory.session_summary` ended the session as a side effect.

#### Scenario: `memory.session_start` opens a new session

- **WHEN** an MCP client calls `memory.session_start` with `{ agent?: string, description?: string }`
- **THEN** the server SHALL insert a `sessions` row with `status = 'active'`, `started_at = now`, the provided `agent` (or `'unknown'`), `token_id` from the request context, `project_id` from the request scope, and a placeholder `title` of the form `basename(cwd) · HH:MM UTC` with `title_final = false`; **AND** the response SHALL be `{ sessionId, scope, startedAt, title }`

#### Scenario: `memory.session_end` ends a session without summary

- **WHEN** an MCP client calls `memory.session_end` with `{ sessionId: string }` for an active session
- **THEN** the server SHALL set `status = 'ended'` and `ended_at = now` on that row, leave `summary` and `title` unchanged, and SHALL return `{ ok: true, endedAt }`

#### Scenario: `memory.session_end` is idempotent on already-ended sessions

- **WHEN** an MCP client calls `memory.session_end` on a row whose `status` is already `'ended'`
- **THEN** the server SHALL return `{ ok: true, endedAt }` with the existing `ended_at` and SHALL NOT mutate the row

#### Scenario: `memory.session_summary` writes summary and title without ending the session

- **WHEN** an MCP client calls `memory.session_summary` with `{ sessionId?: string, summary: string, title?: string }`
- **THEN** the server SHALL resolve `sessionId` from the active MCP transport mapping when omitted, write `summary` with `summary_final = true`, write `title` (when provided, after validating length ≤100) with `title_final = true`, leave `status`/`ended_at` unchanged, and return `{ ok: true, sessionId, summary, title, summaryFinal: true, titleFinal: <true|false> }`

#### Scenario: `memory.session_summary` may be called multiple times; the latest call wins

- **GIVEN** a session whose `summary_final = true` from a prior `memory.session_summary({summary: "A"})` call
- **WHEN** the agent calls `memory.session_summary({summary: "B"})` again
- **THEN** `summary` SHALL be replaced with "B" (last-final-wins among final writes)

#### Scenario: `memory.session_summary` rejects empty summary

- **WHEN** the agent submits `summary: ""` or whitespace-only
- **THEN** the call SHALL be rejected with code `invalid_input`

#### Scenario: `memory.session_summary` rejects title over 100 chars

- **WHEN** the agent submits `title: "A".repeat(101)`
- **THEN** the call SHALL be rejected with code `invalid_input`

#### Scenario: A session-lifecycle tool targets a session owned by a different token

- **WHEN** any of the three tools is called with a `sessionId` whose `token_id` does not match the caller's token
- **THEN** the call SHALL be rejected with code `session_not_found` (never `forbidden`, to avoid information disclosure)

### Requirement: The MCP server MUST expose three research tools

The `/mcp` and `/mcp/<slug>` endpoints SHALL register `memory.context`, `memory.timeline`, and `memory.capture_passive` with the following contracts. Note that `memory.save_prompt` (write side) and `memory.search_prompts` (read side) are registered in their own dedicated requirements; this requirement scopes the research/context tools only.

#### Scenario: `memory.context` returns a bootstrap snapshot

- **WHEN** an MCP client calls `memory.context` with `{ sessions?: number, prompts?: number, memories?: number, includeArchived?: boolean }`
- **THEN** the server SHALL return `{ recentSessions, recentPrompts, recentMemories }`, with each list scoped to the request context (global vs path-scoped project)
- **AND** `recentSessions` SHALL contain only sessions that satisfy the `sessionHasContent` predicate (see `sessions` capability), ordered by `started_at DESC`, with empty sessions filtered out BEFORE truncation to `sessions ?? 5`
- **AND** `recentPrompts` SHALL be ordered by `created_at DESC` and filtered to `deleted_at IS NULL`
- **AND** `recentMemories` SHALL be ordered by `last_seen_at DESC` with `includeArchived = false` (default) filtering out `status = 'archived'` rows

#### Scenario: `memory.context.recentSessions` backfills past empty sessions

- **GIVEN** the active scope contains, in `started_at` order from newest to oldest, three empty sessions and one useful session
- **WHEN** an MCP client calls `memory.context({sessions: 1})`
- **THEN** the response's `recentSessions` array SHALL have length 1 and SHALL contain only the useful session — the three newer empty sessions SHALL NOT consume the slot

#### Scenario: `memory.context.recentSessions` excludes soft-deleted sessions

- **GIVEN** a session that has content AND is soft-deleted (`deleted_at IS NOT NULL`)
- **WHEN** an MCP client calls `memory.context`
- **THEN** the row SHALL NOT appear in `recentSessions` — the soft-delete filter and the content filter both apply

#### Scenario: `memory.context` arguments exceed clamps

- **WHEN** the caller passes `sessions > 25`, `prompts > 50`, or `memories > 100`
- **THEN** the server SHALL silently clamp to the maximum and SHALL include a `clamped: true` field in the response

#### Scenario: `memory.context` excludes soft-deleted prompts

- **GIVEN** prompts P1 and P2 in scope where `P2.deleted_at IS NOT NULL`
- **WHEN** an MCP client calls `memory.context`
- **THEN** `recentPrompts` SHALL include `P1` and SHALL NOT include `P2`

#### Scenario: `memory.timeline` returns chronological neighbors within a session

- **WHEN** an MCP client calls `memory.timeline` with `{ memoryId, before?: 5, after?: 5 }` and the target memory has a non-null `session_id`
- **THEN** the server SHALL return up to `before` memories with `created_at < target.created_at` and `session_id = target.session_id`, plus up to `after` memories with `created_at > target.created_at` and `session_id = target.session_id`, ordered chronologically

#### Scenario: `memory.timeline` falls back when the target has no session

- **WHEN** the target memory has `session_id = NULL`
- **THEN** the server SHALL return neighbors selected by `created_at` within ±2 hours of the target's `created_at`, scoped to the same `(scope, project_id)`, and the response SHALL include `fallback: 'time_window'`

#### Scenario: `memory.timeline` combined window exceeds 50

- **WHEN** `before + after > 50`
- **THEN** the call SHALL be rejected with code `invalid_input` and a message referring the caller to `memory.search`

#### Scenario: `memory.capture_passive` extracts numbered learnings

- **WHEN** an MCP client calls `memory.capture_passive` with `{ text: string, sessionId?: string }` and `text` contains a section starting with `^## Key Learnings:\s*$`
- **THEN** the server SHALL extract each subsequent numbered (`1.`, `2.`) or bulleted (`-`, `*`) item, save each as a separate memory with `type = 'discovery'` and the active scope, and SHALL return `{ saved: number, ids: string[] }`

#### Scenario: `memory.capture_passive` finds no learnings block

- **WHEN** the input text has no matching `## Key Learnings:` heading
- **THEN** the server SHALL return `{ saved: 0, ids: [] }` and SHALL NOT error

### Requirement: The MCP server MUST expose two observability tools

The `/mcp` and `/mcp/<slug>` endpoints SHALL register `memory.doctor` and `memory.stats`.

#### Scenario: `memory.doctor` returns an operational report

- **WHEN** an MCP client calls `memory.doctor`
- **THEN** the server SHALL return `{ db: { open, journalMode, integrity, sizeBytes }, llm: { reachable, lastPingAt }, embeddings: { enabled, backlog }, consolidation: { lastRunAt, lastRunOps }, sessions: { active }, warnings: string[] }`

#### Scenario: `memory.stats` returns counters by scope and status

- **WHEN** an MCP client calls `memory.stats`
- **THEN** the server SHALL return `{ memoriesByStatus, memoriesByType, memoriesByScope, sessionsByStatus, totalProjects, totalTokens }` with each value being a `Record<string, number>` of counts scoped to the request context

#### Scenario: A read-only token calls `memory.doctor` or `memory.stats`

- **WHEN** the caller's scope is `read:*` or `read:project:<id>`
- **THEN** both tools SHALL succeed (they are read-only by design)

### Requirement: The MCP server MUST expose three project-management tools under the `project.*` namespace

The `/mcp` and `/mcp/<slug>` endpoints SHALL register `project.use`, `project.list`, and `project.current` with the following contracts. Tool names live under the top-level `project.*` namespace (not `memory.project_*`) to distinguish project management from memory CRUD.

#### Scenario: `project.use` activates an existing slug

- **WHEN** an MCP client calls `project.use({slug: 'rembric'})` and no project is currently active for the session
- **AND** a project row exists with `slug = 'rembric'`
- **THEN** the server SHALL activate that project for the session and SHALL return `{ slug: 'rembric', projectId, created: false, switched: false, source: 'tool-explicit' }`

#### Scenario: `project.use` with the same slug as currently active is idempotent

- **WHEN** `project.use({slug})` is called where `slug` matches the project already active for the session
- **THEN** the server SHALL return `{ slug, projectId, created: false, switched: false }` and SHALL NOT mutate any state

#### Scenario: `project.use` against a different active project requires `confirmSwitch`

- **WHEN** `project.use({slug: 'api'})` is called where the session is already active in project `'rembric'` and `confirmSwitch` is omitted or `false`
- **THEN** the call SHALL be rejected with code `project_switch_requires_confirm` and a payload `{ currentSlug: 'rembric', targetSlug: 'api' }`

#### Scenario: `project.use` against a different active project with active session

- **WHEN** `project.use({slug: 'api', confirmSwitch: true})` is called where the session is active in project `'rembric'` AND a Rembric session is currently `status = 'active'` for this MCP transport session
- **THEN** the call SHALL be rejected with code `session_active_must_end` and a payload `{ activeSessionId }`, instructing the agent to call `memory.session_summary` (or `memory.session_end`) first

#### Scenario: `project.use` against an unknown slug without `autocreate`

- **WHEN** `project.use({slug: 'does-not-exist'})` is called and no project with that slug exists
- **THEN** the call SHALL be rejected with code `project_not_found` and a payload `{ suggestedSlugs: string[] }` of up to 3 deterministic Levenshtein-≤3 suggestions

#### Scenario: `project.use` with `autocreate` creates a valid slug

- **WHEN** `project.use({slug: 'new-thing', autocreate: true})` is called where no project has that slug and no other project is active for the session
- **AND** the slug matches the strict regex
- **THEN** the server SHALL insert a new `projects` row and activate it, returning `{ slug, projectId, created: true, switched: false }`

#### Scenario: `project.use` with `autocreate` and an invalid slug

- **WHEN** `project.use({slug: 'Bad_Slug', autocreate: true})` is called
- **THEN** the call SHALL be rejected with code `invalid_slug` and SHALL NOT insert a row

#### Scenario: `project.list` returns available slugs

- **WHEN** an MCP client calls `project.list({includeArchived?: false})`
- **THEN** the server SHALL return `{ projects: Array<{ slug, displayName, archived, memoryCount }> }` ordered by slug ascending, filtering archived rows by default

#### Scenario: `project.current` reports resolution provenance

- **WHEN** an MCP client calls `project.current`
- **THEN** the server SHALL return `{ slug: string | null, projectId: string | null, source: 'url-path' | 'roots' | 'tool-explicit' | 'none', suggestedSlugs: string[] }` where `suggestedSlugs` is populated by the most recent `roots/list` derivation that did NOT auto-activate (existing-but-already-active, or non-existing)

### Requirement: The MCP `initialize` response MUST ship a protocol-teaching `instructions` block

When the MCP server is constructed, its `instructions` field SHALL be populated with a scope-aware string that teaches the agent when to call each tool. The string SHALL be 800 characters or fewer.

The instructions SHALL include:

1. The session-close protocol sentence directing the agent to call `memory.session_summary({title, summary})` before declaring work "done". The sentence SHALL describe the title constraint (≤100 chars, descriptive of what was actually worked on — NOT the cwd, NOT generic) and the summary structure (Goal · Discoveries · Accomplished · Next Steps · Files).
2. **The post-compact recovery clause (new)** — a short instruction directing the agent that after any compaction event, when the compacted summary lacks specific detail (exact file paths, prior decisions, concrete error messages), it MUST call `memory.context` (or `memory.search` for keyword lookup) BEFORE responding to the user's pending prompt. The phrasing SHALL stay concise (≤60 chars of new content) so the total stays under the 800-char cap.

#### Scenario: An MCP client connects on `/mcp/<slug>`

- **WHEN** the `initialize` handshake completes against `/mcp/my-project`
- **THEN** the `InitializeResult.instructions` SHALL contain references to `memory.save`, `memory.search`, `memory.session_summary`, AND `memory.context` (the new post-compact recovery clause) plus a note indicating the connection is project-scoped to `'my-project'` and that `scope='global'` will be rejected
- **AND** the instructions SHALL contain the substring `memory.session_summary` and the substring `title` and a reference to "before" (referring to before declaring done)
- **AND** the instructions SHALL contain the substring `memory.context` (the new post-compact recovery clause)

#### Scenario: An MCP client connects on `/mcp` without a project

- **WHEN** the `initialize` handshake completes against `/mcp`
- **THEN** the `InitializeResult.instructions` SHALL contain the same protocol triggers (including the session-close protocol sentence AND the memory.context post-compact recovery clause) and a note indicating the connection is global-scope and that project memories require opening `/mcp/<slug>` or sending `X-Rembric-Project`

#### Scenario: Instructions length is checked at build time

- **WHEN** the test suite runs against both `/mcp` and `/mcp/<slug>` variants of `buildInstructions(ctx)`
- **THEN** both outputs SHALL be 800 characters or fewer (unchanged cap — the new clause MUST fit within the existing budget)

#### Scenario: A client that does not consume `instructions` connects

- **WHEN** an MCP client ignores the `instructions` field
- **THEN** every tool SHALL still function normally (the field is informational only)

#### Scenario: instructions.test.ts asserts the new memory.context clause is present

- **WHEN** `apps/server/src/mcp/instructions.test.ts` runs against `buildInstructions({requestedSlug: 'demo'})` and `buildInstructions({requestedSlug: null})`
- **THEN** both outputs SHALL contain the substring `memory.context`
- **AND** both outputs SHALL be ≤800 chars
- **AND** existing assertions for `memory.session_summary`, `memory.save`, `memory.search`, scope notes, etc. SHALL continue to pass

### Requirement: The MCP server MUST expose `memory.suggest_topic_key`

The server SHALL register a `memory.suggest_topic_key` tool that returns a stable topic key heuristic from `type` plus optional `title` / `content`. The implementation SHALL be deterministic (no LLM call) and family-aware (`architecture/*`, `bug/*`, `decision/*`, `pattern/*`, `config/*`, `discovery/*`, `preference/*`).

#### Scenario: A suggestion is requested for a clear case

- **WHEN** `memory.suggest_topic_key({type: 'architecture', title: 'JWT auth middleware'})` is called
- **THEN** the response SHALL be `{ topic_key: 'architecture/jwt-auth-middleware' }` (or a similar deterministic slug)

#### Scenario: A suggestion is requested without a title

- **WHEN** `memory.suggest_topic_key({type: 'bug', content: 'long free-form text...'})` is called
- **THEN** the heuristic SHALL fall back to a content-derived slug (first non-stopword keywords), prefixed with the type family (`bug/<slug>`)

#### Scenario: The same input is provided twice

- **WHEN** identical arguments are passed in two separate calls
- **THEN** the returned `topic_key` SHALL be byte-identical (determinism)

### Requirement: The MCP server MUST expose `memory.judge`

The server SHALL register a `memory.judge` tool that closes a pending judgment surfaced by `memory.save`. The schema SHALL be `{ judgmentId: string, relation: enum, reason?: string, confidence?: number, evidence?: any }`. When `relation = 'supersedes'`, the server SHALL transition the target memory to `status = 'superseded'` and append the target's id to the source's `replaces[]`. Other relations SHALL only update the `memory_relations` row.

#### Scenario: Judging supersedes mutates the target memory

- **GIVEN** a pending row J with source N (active) and target M (active)
- **WHEN** the agent calls `memory.judge({judgmentId: J, relation: 'supersedes', confidence: 0.95})`
- **THEN** within one transaction: M SHALL transition to `status = 'superseded'`, N's `replaces` SHALL include M's id, the relation row SHALL transition to `status = 'judged'` with `relation = 'supersedes'`, `marked_by_kind = 'agent'`

#### Scenario: Judging conflicts_with does not mutate memory rows

- **WHEN** the agent calls `memory.judge({judgmentId, relation: 'conflicts_with', reason})`
- **THEN** only the `memory_relations` row SHALL change; both `memory` rows SHALL remain `active`

#### Scenario: Judging `not_conflict` acknowledges and closes

- **WHEN** the agent calls `memory.judge({judgmentId, relation: 'not_conflict'})`
- **THEN** the relation row SHALL transition to `status = 'judged'` with `relation = 'not_conflict'`; no `memory` row SHALL be mutated; the annotation SHALL NOT surface in `memory.search` (`not_conflict` is hidden from default search annotations)

#### Scenario: Judging an already-judged row

- **WHEN** `memory.judge` is called on a row whose `status` is already `'judged'`
- **THEN** the call SHALL fail with code `judgment_already_closed` and the original verdict SHALL remain unchanged

#### Scenario: Judging with a bogus judgmentId

- **WHEN** `judgmentId` matches no row
- **THEN** the call SHALL fail with code `judgment_not_found`

### Requirement: The MCP server MUST expose `memory.compare`

The server SHALL register a `memory.compare` tool that records a verdict on two arbitrary memories without a preceding save. The schema SHALL be `{ memoryIdA: string, memoryIdB: string, relation: enum (excluding 'not_conflict'), reason?: string, confidence: number, evidence?: any }`. The verdict SHALL be persisted as a `memory_relations` row with `status = 'judged'` from the start.

#### Scenario: Comparing two memories from independent analysis

- **WHEN** the agent calls `memory.compare({memoryIdA: 'X', memoryIdB: 'Y', relation: 'related', confidence: 0.9, reason: 'both describe auth token rotation'})`
- **THEN** a `memory_relations` row SHALL be inserted with `source_id = X`, `target_id = Y`, `relation = 'related'`, `status = 'judged'`, `marked_by_kind = 'agent'`

#### Scenario: Comparing the same pair twice (idempotency)

- **WHEN** `memory.compare` is called twice with the same `(memoryIdA, memoryIdB)` ordered pair and different `relation` values
- **THEN** the existing row SHALL be UPDATED (relation, reason, confidence, judged_at refreshed); a new row SHALL NOT be inserted

#### Scenario: Comparing across scopes

- **WHEN** `memory.compare` is called with two memories from different `(scope, project_id)` tuples
- **THEN** the call SHALL be rejected with code `cross_scope_relation` and SHALL NOT insert any row

#### Scenario: Comparing with the `not_conflict` relation

- **WHEN** `memory.compare` is called with `relation: 'not_conflict'`
- **THEN** the call SHALL be rejected with code `invalid_input`; `not_conflict` is only valid as a `memory.judge` verdict (it answers "the save-time candidate was a false positive"), not as a proactive comparison

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

### Requirement: Session-lifecycle MCP tools MUST reject soft-deleted sessions

`memory.session_end` and `memory.session_summary` SHALL resolve the target row before performing any state transition. When the resolved row has `deleted_at IS NOT NULL`, the call SHALL be rejected with a structured MCP error containing `code: 'session_deleted'` and a message naming the deleted-at timestamp. No state mutation SHALL be performed. The cross-token check that already protects these calls SHALL continue to run first; only when the cross-token check passes does the `session_deleted` gate apply.

`memory.session_start` is unaffected — every call opens a brand-new session row and never touches a deleted one.

#### Scenario: memory.session_end targets a soft-deleted session

- **GIVEN** a Rembric session `<S>` whose `deleted_at` is non-null, owned by token `<T>`
- **WHEN** an MCP client authenticated as `<T>` calls `memory.session_end` with `sessionId = <S>`
- **THEN** the response SHALL be an MCP error containing `code: 'session_deleted'` and a message naming the deleted-at timestamp
- **AND** no column on the row SHALL be mutated

#### Scenario: memory.session_summary targets a soft-deleted session

- **GIVEN** a Rembric session `<S>` whose `deleted_at` is non-null, owned by token `<T>`
- **WHEN** an MCP client authenticated as `<T>` calls `memory.session_summary` with `sessionId = <S>` and a non-empty summary
- **THEN** the response SHALL be an MCP error containing `code: 'session_deleted'`
- **AND** the row's `summary` column SHALL remain unchanged

#### Scenario: Cross-token check still runs before the deleted gate

- **GIVEN** a Rembric session `<S>` owned by token `<T1>`, soft-deleted
- **WHEN** an MCP client authenticated as a different token `<T2>` calls `memory.session_end` on `<S>`
- **THEN** the response SHALL be an MCP error with the existing cross-token `forbidden` code, NOT `session_deleted`

### Requirement: The MCP server MUST expose `memory.save_prompt` with optional metadata and refine semantics

The `/mcp` and `/mcp/<slug>` endpoints SHALL register `memory.save_prompt` for persisting curated user prompts. Input schema:

- `content: string` (required, non-empty after trim).
- `title: string` (required, ≤100 chars).
- `tags?: string[]` (optional; each element is a non-empty string).
- `replaces?: string` (optional; ULID of a predecessor prompt in the same scope).

Standard behaviour: the server SHALL insert a new row into `prompts` with `content`, `title`, `tags`, the resolved `session_id` (via the existing session-attach helper), the active scope's `project_id`, and `agent` copied from the token name. The row SHALL be created with `deleted_at = NULL`, `replaces = NULL`.

Refine behaviour: when `replaces` is provided, the server SHALL run an atomic SQLite transaction that:

1. Loads the predecessor row by id.
2. Rejects with `prompt_not_found` if no row exists.
3. Rejects with `prompt_scope_mismatch` if the predecessor's `project_id` does not match the active scope's `project_id` (both NULL counts as a match for global scope).
4. Rejects with `prompt_already_deleted` if the predecessor's `deleted_at IS NOT NULL`.
5. Sets the predecessor's `deleted_at = now()`.
6. Inserts the new prompt row with `replaces = [<predecessorId>]`.
7. Returns `{ ok: true, id: <newId>, createdAt: <ts>, replaces: [<predecessorId>] }`.

On `replaces=null`/unset, the response SHALL be `{ ok: true, id: <newId>, createdAt: <ts> }`.

#### Scenario: `memory.save_prompt` persists optional title and tags

- **WHEN** the agent calls `memory.save_prompt({ content: "ship the auth refactor by Friday", title: "auth refactor deadline", tags: ["deadline", "auth"] })`
- **THEN** the persisted row SHALL have `title = "auth refactor deadline"` and `tags = '["deadline","auth"]'` (JSON encoded)
- **AND** the row SHALL be indexed in `prompts_fts` with both `content` and the flattened `tags` string

#### Scenario: `memory.save_prompt` rejects title over 100 chars

- **WHEN** the agent submits `title: "A".repeat(101)`
- **THEN** the call SHALL be rejected with code `invalid_input`

#### Scenario: `memory.save_prompt` refine soft-deletes the predecessor atomically

- **GIVEN** an active prompt `P1` in project `foo`
- **WHEN** the agent calls `memory.save_prompt({ content: "...refined...", replaces: "<P1.id>" })` from a `/mcp/foo` connection
- **THEN** in a single transaction: `P1.deleted_at` SHALL be set to the current timestamp; a new row `P2` SHALL be inserted with `P2.replaces = ["<P1.id>"]`
- **AND** the response SHALL include `{ ok: true, id: "<P2.id>", replaces: ["<P1.id>"] }`

#### Scenario: `memory.save_prompt` rejects refine when the predecessor is not in the active scope

- **GIVEN** a prompt `P1` belonging to project `foo`
- **WHEN** the agent (on a `/mcp/bar` connection) calls `memory.save_prompt({ content: "...", replaces: "<P1.id>" })`
- **THEN** the call SHALL be rejected with code `prompt_scope_mismatch`
- **AND** `P1` SHALL remain active

#### Scenario: `memory.save_prompt` rejects refine when the predecessor is already deleted

- **GIVEN** a prompt `P1` with `deleted_at IS NOT NULL`
- **WHEN** the agent calls `memory.save_prompt({ content: "...", replaces: "<P1.id>" })`
- **THEN** the call SHALL be rejected with code `prompt_already_deleted`
- **AND** no new row SHALL be inserted

#### Scenario: `memory.save_prompt` rejects refine when the predecessor does not exist

- **WHEN** the agent calls `memory.save_prompt({ content: "...", replaces: "01HVALIDLOOKINGBUTUNKNOWN" })`
- **THEN** the call SHALL be rejected with code `prompt_not_found`

#### Scenario: `memory.save_prompt` plain save (no tags, no replaces)

- **WHEN** the agent calls `memory.save_prompt({ content: "save me", title: "remember to save" })` with no tags and no replaces
- **THEN** the call SHALL succeed and the row SHALL have `tags = NULL`, `replaces = NULL`
- **AND** the response SHALL be `{ ok: true, id: <ulid>, createdAt: <ts> }`

#### Scenario: `memory.save_prompt` rejects calls missing `title`

- **WHEN** the agent calls `memory.save_prompt({ content: "save me" })` without a `title`
- **THEN** the call SHALL be rejected with code `invalid_input` (zod validation failure: title is required)

### Requirement: The MCP server MUST expose `memory.search_prompts`

The `/mcp` and `/mcp/<slug>` endpoints SHALL register a new MCP tool `memory.search_prompts` that returns curated prompts matching a query and/or structured filters, scope-resolved through the existing `scopeFromContext` helper.

Input schema:

- `query?: string` — free-text query; when provided, the server SHALL use the `prompts_fts` virtual table via `MATCH` against `content + tags`.
- `sessionId?: string` — restrict to prompts whose `session_id = <sessionId>`.
- `agent?: string` — restrict to prompts whose `agent = <agent>`.
- `includeDeleted?: boolean` — default `false`; when `true`, soft-deleted prompts SHALL be included.
- `limit?: number` — default `25`, clamped to `[1, 100]`.
- `offset?: number` — default `0`.

Response shape:

```json
{
  "scope": "project:<id>" | "global",
  "prompts": [
    {
      "id": "<ulid>",
      "content": "<full content>",
      "title": "<title or null>",
      "tags": ["<tag>", ...] | null,
      "sessionId": "<id or null>",
      "projectId": "<id or null>",
      "agent": "<agent or null>",
      "replaces": ["<predecessorId>", ...] | null,
      "deletedAt": "<iso timestamp or null>",
      "createdAt": "<iso timestamp>"
    }
  ],
  "total": <count>,
  "clamped": true | false
}
```

The tool SHALL resolve effective project via the existing `scopeFromContext` precedence (path-scoped `ctx.project` → `SessionRouter` pin → global). It SHALL NOT leak prompts from any other scope.

#### Scenario: `memory.search_prompts` returns FTS5 matches scoped to the active project

- **GIVEN** a token connected to `/mcp/foo` and a project `foo` with prompts containing "deploy via Docker" and "refactor auth"
- **WHEN** the agent calls `memory.search_prompts({ query: "deploy" })`
- **THEN** the response SHALL include exactly the prompt whose content matches "deploy"
- **AND** the response `scope` SHALL be `project:<foo.id>`

#### Scenario: `memory.search_prompts` honours session and agent filters

- **GIVEN** prompts P1 (`session_id=S1, agent=claude-code`), P2 (`session_id=S1, agent=codex`), P3 (`session_id=S2, agent=claude-code`)
- **WHEN** the agent calls `memory.search_prompts({ sessionId: "<S1>", agent: "claude-code" })`
- **THEN** the response SHALL include only `P1`

#### Scenario: `memory.search_prompts` excludes soft-deleted prompts by default

- **GIVEN** prompts P1 and P2 in scope where `P2.deleted_at IS NOT NULL`
- **WHEN** the agent calls `memory.search_prompts({})` (no `includeDeleted` flag)
- **THEN** the response SHALL include only `P1`

#### Scenario: `memory.search_prompts` includes soft-deleted prompts when explicitly requested

- **GIVEN** prompts P1 and P2 in scope where `P2.deleted_at IS NOT NULL`
- **WHEN** the agent calls `memory.search_prompts({ includeDeleted: true })`
- **THEN** the response SHALL include both `P1` and `P2`

#### Scenario: `memory.search_prompts` clamps limit and reports it

- **WHEN** the caller passes `limit: 500`
- **THEN** the server SHALL silently clamp `limit` to `100`
- **AND** the response SHALL include `clamped: true`

#### Scenario: `memory.search_prompts` from a path-scoped connection rejects cross-scope leakage

- **GIVEN** a token connected to `/mcp/foo` AND a prompt belonging to project `bar`
- **WHEN** the agent calls `memory.search_prompts({ query: "anything matching bar" })`
- **THEN** the `bar` prompt SHALL NOT appear in the response
