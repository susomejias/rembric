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

The `memory.save` tool's input schema SHALL require a `title: string` argument (1–100 chars; empty or over-long rejected with `invalid_input`) and SHALL gain an optional `topic_key?: string` argument (max length 128, NUL-byte rejected). The response shape SHALL be extended with two additional fields: `candidates: Array<Candidate>` (always present, empty when none found) and `judgmentRequired: boolean`. Existing fields (`id`, `status`, `createdAt`) are unchanged.

The `Candidate` type:

```ts
{
  judgmentId: string;
  targetId: string;
  title: string; // the candidate's title
  snippet: string; // first ~200 chars of the candidate's content
  similarity: number; // 0..1, max(vec, fts) normalized
  source: 'vec' | 'fts'; // which detector surfaced it
}
```

#### Scenario: memory.save with no `topic_key` and zero candidates

- **WHEN** `memory.save({type, title, content})` is called and no existing memory matches the candidate-detection thresholds
- **THEN** the response SHALL be `{ id, status: 'active', createdAt, candidates: [], judgmentRequired: false }`

#### Scenario: memory.save without a title

- **WHEN** `memory.save` is called without a `title`, or with a `title` that is empty or longer than 100 characters
- **THEN** the call SHALL be rejected with code `invalid_input` and SHALL NOT insert any row

#### Scenario: memory.save with `topic_key` upserting an existing row

- **WHEN** `memory.save({type, title, content, topic_key: 'arch/auth'})` is called and an active memory with that key exists in scope
- **THEN** the response SHALL include the newly created `id`; the previous row SHALL be in `status = 'superseded'`; `candidates` MAY additionally include unrelated rows surfaced by FTS/vec; `judgmentRequired` reflects only the candidates surfaced via that path, not the topic-key upsert (which is already judged)

#### Scenario: memory.save before the just-saved row has an embedding

- **GIVEN** the just-saved row's embedding has not been computed yet (lazy model load or worker lag)
- **WHEN** `memory.save` finds three FTS5 matches above threshold
- **THEN** the response SHALL include three candidates each with `source: 'fts'` and each carrying the candidate's `title`; no vec-sourced candidates SHALL appear

#### Scenario: memory.save with `topic_key` longer than 128 chars

- **WHEN** the input `topic_key` exceeds 128 characters
- **THEN** the call SHALL be rejected with code `invalid_input` and SHALL NOT insert any row

### Requirement: memory.search response MUST include relation annotations

The `memory.search` response SHALL include a `relations` array on each result row, populated in a single JOIN over `memory_relations`. Annotation kinds: `supersedes`, `superseded_by`, `conflicts_with`, `related`, `compatible`, `scoped`, `pending_conflict`. Each annotation SHALL include the target id and (when judged) a short snippet of the target's content.

Each result row SHALL additionally carry the derived review metadata for the memory (see the `memory` capability): `reviewState` (`'fresh'` | `'needs_review'`) for `active` rows, and `reviewAfter` when non-null. These fields are informational metadata only — they SHALL NOT change result ordering, scope isolation, or which rows are returned. Rows that are not `active` SHALL omit `reviewState`.

`memory.search` SHALL accept two OPTIONAL projection parameters that shape the returned rows WITHOUT changing which rows are returned or their order: `snippet` (a positive integer) and `fields` (a list of row field names). When `snippet` is supplied, each returned row's `content` SHALL be truncated to at most that many characters using the same truncation semantics as `memory.context` (the snippet helper: slice and append an ellipsis when the content exceeds the cap). When `fields` is supplied, the response SHALL return only the named fields PLUS the always-present identity fields `id`, `type`, and `title` (so every projected row remains identifiable). The two parameters compose: requesting `content` in `fields` together with a `snippet` cap yields a truncated `content`. When NEITHER `snippet` NOR `fields` is supplied, the response SHALL be the unchanged full-content row shape (byte-for-byte back-compatible). Projection SHALL be applied AFTER selection, ranking, scope enforcement, and the `last_seen_at` touch — it SHALL NOT alter any of them.

#### Scenario: A search result row reports its relations

- **WHEN** `memory.search` returns memory N which has a judged `supersedes` relation to memory M and a pending relation to memory Q
- **THEN** the result row SHALL include `relations: [{ kind: 'supersedes', targetId: 'M', snippet }, { kind: 'pending_conflict', targetId: 'Q', judgmentId }]`

#### Scenario: The annotation set respects the cap

- **GIVEN** memory N has 25 rows in `memory_relations`
- **WHEN** the cap is 10
- **THEN** the response SHALL include the 10 most recent annotations; the rest are accessible via the dashboard

#### Scenario: A search result row reports its review state

- **GIVEN** an `active` memory N whose derived `reviewState` is `'needs_review'`
- **WHEN** `memory.search` returns N
- **THEN** the result row SHALL include `reviewState: 'needs_review'` and a non-null `reviewAfter`
- **AND** the presence of `reviewState` SHALL NOT alter N's position in the result ordering

#### Scenario: A search with no projection returns full content unchanged

- **GIVEN** `memory.search` is called WITHOUT `snippet` and WITHOUT `fields`
- **WHEN** the response is returned
- **THEN** each row SHALL carry its full untruncated `content` and the same field set as before this change

#### Scenario: A search with a snippet cap truncates content

- **GIVEN** a result row whose `content` is longer than `N` characters
- **WHEN** `memory.search` is called with `snippet: N`
- **THEN** that row's returned `content` SHALL be the content truncated to at most `N` characters using the `memory.context` snippet truncation semantics
- **AND** the set of rows returned and their order SHALL be identical to the same query without `snippet`

#### Scenario: A search with field selection keeps identity fields

- **GIVEN** `memory.search` is called with `fields: ['status']`
- **WHEN** the response is returned
- **THEN** each row SHALL include `status` and the always-present identity fields `id`, `type`, and `title`, and MAY omit fields not requested (e.g. `tags`, `relations`)
- **AND** the set of rows returned and their order SHALL be identical to the same query without `fields`

### Requirement: The `memory.get` tool MUST return the memory and its history

`memory.get` SHALL accept an `id` and SHALL return the memory's content, status, scope, project, tags, source, and the full chain of predecessors derived from `replaces`, plus the confirmation count for the current head.

For an `active` memory, the response SHALL additionally include the derived review metadata (see the `memory` capability): `reviewState` (`'fresh'` | `'needs_review'`) and `reviewAfter` when non-null. For non-`active` memories these fields SHALL be omitted.

`memory.get` SHALL additionally accept an OPTIONAL `ids` array as a back-compatible batch form. Exactly one of `id` or `ids` SHALL be supplied; supplying both, or neither, SHALL be an `invalid_input` error. When `id` is supplied, the response shape SHALL be unchanged from the single-memory form above. When `ids` is supplied, the response SHALL contain an ordered `memories` array — one per id that resolves to an in-scope, token-authorized memory, in the same order the ids were requested, each entry carrying the same per-memory shape as the single-`id` form — plus a `notFound` array listing the requested ids that did not resolve. The batch form SHALL be scope-enforced via a scoped service read: an id outside the connection's effective scope SHALL be reported in `notFound` and SHALL NOT leak the memory's content or existence, identically to how the single-`id` form treats an out-of-scope id as not found. The `ids` array SHALL be bounded by a maximum length; a request exceeding it SHALL be an `invalid_input` error.

#### Scenario: Retrieve a merged memory

- **WHEN** an authenticated client calls `memory.get` with the id of a merged memory M
- **THEN** the response SHALL include M's content, M's predecessor ids, their content snapshots, and the confirmation count against M

#### Scenario: memory.get reports review state for an active memory

- **GIVEN** an `active` memory M whose derived `reviewState` is `'fresh'`
- **WHEN** an authenticated client calls `memory.get('M')`
- **THEN** the response SHALL include `reviewState: 'fresh'` and `reviewAfter` (the non-null derived timestamp for M's type)

#### Scenario: memory.get with a single id is unchanged

- **WHEN** an authenticated client calls `memory.get({ id: 'M' })` (no `ids`)
- **THEN** the response SHALL be the single-memory shape (memory, head, predecessors, confirmationCount, relations, and review metadata when active), identical to the behavior before the batch form was added

#### Scenario: memory.get with ids returns an ordered batch

- **GIVEN** in-scope memories M1, M2, M3 all readable by the calling token
- **WHEN** an authenticated client calls `memory.get({ ids: ['M2', 'M1', 'M3'] })`
- **THEN** the response SHALL include `memories` ordered `[M2, M1, M3]`, each carrying the single-`id` per-memory shape, and `notFound: []`

#### Scenario: memory.get batch never leaks a cross-scope id

- **GIVEN** memory X exists in a DIFFERENT project than the connection's effective scope, and in-scope memory M1
- **WHEN** an authenticated client calls `memory.get({ ids: ['M1', 'X'] })`
- **THEN** the response `memories` SHALL contain only M1, and `X` SHALL appear in `notFound`
- **AND** the response SHALL NOT include X's content, title, or any field distinguishing "out of scope" from "does not exist"

#### Scenario: memory.get rejects ambiguous id arguments

- **WHEN** an authenticated client calls `memory.get` with BOTH `id` and `ids` set, or with NEITHER set
- **THEN** the server SHALL return an `invalid_input` error and SHALL NOT return any memory

### Requirement: Memory-returning MCP reads MUST expose the title

Every MCP tool that returns a memory SHALL include that memory's `title` field in the returned shape: `memory.search` result rows, `memory.get` (the memory object, its `head`, and each `predecessors[]` entry), `memory.timeline` neighbors (`before[]`/`after[]`), and `memory.context` (`recentMemories[]`, plus a source/target title on `pendingJudgments[]`, and `needsReview[]`). The title SHALL be returned in full (titles are capped at 100 chars, so no snippet truncation applies).

#### Scenario: memory.search rows carry a title

- **WHEN** `memory.search` returns one or more memory rows
- **THEN** each returned row SHALL include its `title`

#### Scenario: memory.context surfaces titles

- **WHEN** `memory.context` returns `recentMemories`, `pendingJudgments`, or `needsReview` entries
- **THEN** each `recentMemories`/`needsReview` entry SHALL include its memory's `title`, and each `pendingJudgments` entry SHALL include the source and target memories' titles

#### Scenario: memory.timeline neighbors carry a title

- **WHEN** `memory.timeline` returns `before` or `after` neighbors
- **THEN** each neighbor SHALL include its `title`

### Requirement: The `memory.confirm` tool MUST follow the supersedes chain

`memory.confirm` SHALL accept EITHER a single `id` OR an `ids: string[]` (the batch form) and SHALL insert a `confirmations` row for the current head of the supersedes chain reachable from each id. The tool SHALL NOT mutate any `memory` row.

In the single form (`{ id }`), the response SHALL be `{ ok: true }`, unchanged from the prior contract.

In the batch form (`{ ids }`), the server SHALL de-duplicate the ids, record one confirmation per distinct id against its chain head inside ONE transaction, and respond with `{ ok: true, confirmed: <count of distinct ids confirmed> }`. The batch form exists so that the up-to-3 ids returned by `memory.context.needsReview` can be re-affirmed in a single round-trip instead of N. Authorization SHALL be checked once against the resolved scope before any write. When any id is missing or outside the active scope, the call SHALL fail with code `not_found` and the transaction SHALL be rolled back (no partial confirmation), so the agent can re-issue with the valid subset. Exactly one of `id` or `ids` SHALL be supplied; supplying both or neither SHALL be rejected with `invalid_input`.

#### Scenario: Confirming an outdated id

- **GIVEN** memory A is superseded by M
- **WHEN** an authenticated client calls `memory.confirm('A')`
- **THEN** a row SHALL be inserted into `confirmations` with `memory_id = 'M'` and no `memory` row SHALL be updated

#### Scenario: Batch-confirming the needsReview ids in one call

- **GIVEN** `memory.context.needsReview` returned ids `[X, Y, Z]`, each the head of its chain
- **WHEN** an authenticated client calls `memory.confirm({ ids: ['X', 'Y', 'Z'] })`
- **THEN** within one transaction a `confirmations` row SHALL be inserted for each of X, Y, and Z, no `memory` row SHALL be updated, and the response SHALL be `{ ok: true, confirmed: 3 }`

#### Scenario: Batch confirm de-duplicates repeated ids

- **WHEN** an authenticated client calls `memory.confirm({ ids: ['X', 'X'] })`
- **THEN** exactly ONE `confirmations` row SHALL be inserted for X's chain head and the response SHALL be `{ ok: true, confirmed: 1 }`

#### Scenario: Batch confirm rejects an out-of-scope id atomically

- **GIVEN** ids `[X, Q]` where Q belongs to a different scope (or does not exist)
- **WHEN** an authenticated client calls `memory.confirm({ ids: ['X', 'Q'] })`
- **THEN** the call SHALL fail with code `not_found`, and NO `confirmations` row SHALL be inserted for X either (the transaction is rolled back)

#### Scenario: memory.confirm rejects supplying both `id` and `ids`

- **WHEN** an authenticated client calls `memory.confirm({ id: 'X', ids: ['Y'] })` or `memory.confirm({})`
- **THEN** the call SHALL be rejected with code `invalid_input` and SHALL NOT insert any `confirmations` row

### Requirement: Errors MUST follow MCP conventions

The server SHALL return MCP-conformant errors for invalid operations, including helpful messages but never leaking secrets or internal stack traces.

#### Scenario: Unknown tool

- **WHEN** a client invokes a tool name not registered by the server
- **THEN** the response SHALL be an MCP error of the appropriate code with a human-readable message identifying the missing tool

#### Scenario: Internal error

- **WHEN** a tool handler throws an unexpected exception
- **THEN** the response SHALL be an MCP error with a generic message and an error id; the full stack SHALL be logged server-side but NOT returned to the client

### Requirement: The four existing memory tools MUST advertise protocol-teaching descriptions

The descriptions of `memory.save`, `memory.search`, `memory.get`, and `memory.confirm` SHALL begin with a "Call this WHEN …" trigger list before documenting the request/response shape. The request and response shapes themselves are unchanged. In addition, the `memory.search` description SHALL advertise that results are ranked by hybrid semantic + keyword relevance (vector similarity combined with FTS5) — so the agent knows paraphrases and cross-lingual queries match, not only exact keywords — and SHALL advertise the result-page affordance: results are a small default page that can be widened by passing a larger `limit` or paged with `offset` when more relevant results are needed. These additions SHALL NOT remove or weaken the recall trigger.

#### Scenario: `memory.save` description teaches the trigger list

- **WHEN** an MCP client retrieves the tool description for `memory.save` via `tools/list`
- **THEN** the description SHALL contain the substring `Call this IMMEDIATELY after` followed by a list including at least: bug fix, decision, discovery, configuration change, pattern, user preference

#### Scenario: `memory.search` description teaches when to call

- **WHEN** an MCP client retrieves the tool description for `memory.search`
- **THEN** the description SHALL contain wording instructing the agent to call it whenever the user references past work or asks to recall ("remember", "recall", "what did we do")

#### Scenario: `memory.search` description advertises hybrid ranking and the widen affordance

- **WHEN** an MCP client retrieves the tool description for `memory.search`
- **THEN** the description SHALL convey that ranking is hybrid semantic + keyword (so paraphrases / cross-lingual queries match), and SHALL convey that the default result page is small and can be widened via `limit` or paged via `offset`
- **AND** the description SHALL still contain the recall trigger wording from the prior scenario

#### Scenario: An accidental edit removes the protocol-teaching phrase

- **WHEN** a developer rewrites a tool description in a way that removes the `Call this …` trigger
- **THEN** a CI test SHALL fail asserting the presence of the trigger phrase, and the build SHALL be rejected

### Requirement: The MCP server MUST expose three session-lifecycle tools

The `/mcp` and `/mcp/<slug>` endpoints SHALL register the tools `memory.session_start`, `memory.session_end`, and `memory.session_summary` with the following contracts. The tools are split by responsibility: `memory.session_start` opens a session, `memory.session_summary` writes summary/title without transitioning, `memory.session_end` is the sole state transition. This is a behaviour change from the prior contract where `memory.session_summary` ended the session as a side effect.

`memory.session_summary` SHALL validate `summary` against the single canonical cap exported from `apps/server/src/services/agent-sessions.ts` (`SUMMARY_MAX_CHARS`, currently `10000`). The MCP zod schema SHALL be `summary: z.string().min(1).max(SUMMARY_MAX_CHARS)` so overflow is rejected at the transport boundary with `invalid_input` before the tool body runs. The rejected agent SHALL receive an error whose message contains the decimal string of `SUMMARY_MAX_CHARS` so it can retry with a tighter body on the first attempt.

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

- **WHEN** an MCP client calls `memory.session_summary` with `{ sessionId?: string, summary: string, title?: string }` and `summary.length <= SUMMARY_MAX_CHARS`
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

#### Scenario: `memory.session_summary` rejects summary over `SUMMARY_MAX_CHARS`

- **WHEN** the agent submits `summary: "A".repeat(SUMMARY_MAX_CHARS + 1)` (one char over the cap)
- **THEN** the call SHALL be rejected at the zod boundary with code `invalid_input`
- **AND** the error message SHALL contain the decimal string of `SUMMARY_MAX_CHARS` so the agent can deduce the cap and retry with a tighter body on the first attempt
- **AND** the session row SHALL NOT be mutated (no partial write, `summary_final` unchanged)

#### Scenario: `memory.session_summary` accepts summary of exactly `SUMMARY_MAX_CHARS`

- **WHEN** the agent submits `summary: "A".repeat(SUMMARY_MAX_CHARS)`
- **THEN** the call SHALL succeed and the row SHALL have `summary` of length `SUMMARY_MAX_CHARS` with `summary_final = true`

#### Scenario: A session-lifecycle tool targets a session owned by a different token

- **WHEN** any of the three tools is called with a `sessionId` whose `token_id` does not match the caller's token
- **THEN** the call SHALL be rejected with code `session_not_found` (never `forbidden`, to avoid information disclosure)

### Requirement: The MCP server MUST expose three research tools

The `/mcp` and `/mcp/<slug>` endpoints SHALL register `memory.context`, `memory.timeline`, and `memory.capture_passive` with the following contracts. Note that `memory.save_prompt` (write side) and `memory.search_prompts` (read side) are registered in their own dedicated requirements; this requirement scopes the research/context tools only.

#### Scenario: `memory.context` returns a bootstrap snapshot

- **WHEN** an MCP client calls `memory.context` with `{ sessions?: number, prompts?: number, memories?: number, includeArchived?: boolean }`
- **THEN** the server SHALL return `{ recentSessions, recentPrompts, recentMemories, pendingJudgments, needsReview }`, with each list scoped to the request context (global vs path-scoped project)
- **AND** when a size argument is omitted the default SHALL be `sessions = 3`, `memories = 10`, `prompts = 5` (kept small because the snapshot is read every session start; callers needing more pass explicit args, still bounded by the maxima below)
- **AND** `recentSessions` SHALL contain only sessions that satisfy the `sessionHasContent` predicate (see `sessions` capability), ordered by `started_at DESC`, with empty sessions filtered out BEFORE truncation to `sessions ?? 3`
- **AND** `recentPrompts` SHALL be ordered by `created_at DESC` and filtered to `deleted_at IS NULL`
- **AND** `recentMemories` SHALL be ordered by `last_seen_at DESC` with `includeArchived = false` (default) filtering out `status = 'archived'` rows
- **AND** `pendingJudgments` SHALL contain at most 5 pending relations in scope with `created_at < (now - JUDGMENT_ORPHAN_AFTER_MS)`, oldest first, each entry carrying `{ judgmentId, sourceId, targetId, sourceSnippet, targetSnippet, ageMs }` so the agent can close them with `memory.judge` without further reads
- **AND** `needsReview` SHALL contain at most 3 `active` in-scope memories whose derived `reviewState = 'needs_review'` (see the `memory` capability), ordered oldest `reviewBaseline` first, each entry carrying `{ id, type, snippet, reviewAfter, ageMs }` (where `snippet` uses the same per-row cap as the other context lists, `ageMs = now - reviewBaseline` the time since last affirmation) so the agent can re-affirm with `memory.confirm`, supersede with `memory.save` + `topic_key`, or — when it contradicts another memory — fall through to the existing `memory.judge` flow. The list is kept small by COUNT (only the 3 oldest) because it is recurring (every `memory.context`) and usually populated

#### Scenario: `needsReview` is unary and disjoint from `pendingJudgments`

- **GIVEN** a scope containing one `active` memory past its review shelf life AND one aged pending relation between two other memories
- **WHEN** an MCP client calls `memory.context`
- **THEN** the stale single memory SHALL appear only in `needsReview` (carrying `id`, not `sourceId`/`targetId`) and the aged relation SHALL appear only in `pendingJudgments` — no entry SHALL appear in both lists

#### Scenario: `needsReview` respects scope

- **GIVEN** an `active` memory past its review shelf life that belongs to project B
- **WHEN** an MCP client calls `memory.context` on a connection scoped to project A (or the global endpoint)
- **THEN** that memory SHALL NOT appear in `needsReview`

#### Scenario: `needsReview` excludes non-active and within-shelf-life memories

- **GIVEN** in scope: an `archived` memory past its shelf life, and an `active` memory still within its shelf life
- **WHEN** an MCP client calls `memory.context`
- **THEN** neither SHALL appear in `needsReview`

#### Scenario: `memory.context` default sizes when size args are omitted

- **GIVEN** a scope with more than 10 active memories, more than 5 non-deleted prompts, and more than 3 content-bearing sessions
- **WHEN** an MCP client calls `memory.context` with no size arguments
- **THEN** `recentMemories` SHALL contain at most 10 rows, `recentPrompts` at most 5, and `recentSessions` at most 3
- **AND** `clamped` SHALL be `false` (defaults are not clamping)

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

#### Scenario: `memory.context` exposes only aged pendings, never fresh ones

- **GIVEN** a pending relation younger than `JUDGMENT_ORPHAN_AFTER_MS` and another older than it, both in scope
- **WHEN** an MCP client calls `memory.context`
- **THEN** `pendingJudgments` SHALL include only the aged one — fresh pendings belong to the session that created them

#### Scenario: `memory.context.pendingJudgments` respects scope

- **GIVEN** an aged pending relation whose memories belong to project B
- **WHEN** an MCP client scoped to project A calls `memory.context`
- **THEN** `pendingJudgments` SHALL NOT include it

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

When the MCP server is constructed, its `instructions` field SHALL be populated with a scope-aware string that teaches the agent when to call each tool. The string SHALL be 1000 characters or fewer in both variants. This cap is a self-imposed token budget, NOT a client or protocol limit: the MCP specification defines `InitializeResult.instructions` as an optional free-form string with no maximum length or truncation rule, and no consuming client enforces one.

The instructions SHALL be organized as directive, proactively-phrased guidance citing the relevant tools by name, and SHALL include all of:

1. **A proactive save flow** — directing the agent to call `memory.save` (with the required short `title` headline plus the `content`) the moment something noteworthy happens (bug fix · decision · discovery · config change · pattern · preference) rather than batching to session end, and naming the `topic_key` supersede path and the `candidates[]` → `memory.judge` conflict-resolution path. Mechanical detail (error codes, scope semantics) MAY be deferred to the tool's own `description`.
2. **A recall flow** — directing the agent that when starting or resuming work, after a `/compact` event, or when asked "what did we do", it SHALL call `memory.context` (or `memory.search` for keyword lookup) BEFORE acting, but ONLY when it lacks the prior detail it needs. The phrasing SHALL keep recall on-demand — it MUST NOT direct an unconditional `memory.context` load at session start.
3. **A session-close flow** — directing the agent to call `memory.session_summary({title, summary})`. The trigger SHALL be bound to ending a turn in which real work happened — phrased so the agent saves before ending any working turn, and SHALL NOT be evadable by avoiding the literal word "done". The flow SHALL describe the title constraint (≤100 chars, descriptive of what was actually worked on — NOT the cwd, NOT generic), the summary structure (Goal · Discoveries · Accomplished · Next Steps · Files), AND the summary length cap (currently ≤10000 chars, derived from `SUMMARY_MAX_CHARS`). The cap MUST be present inline so the agent budgets for it on the first attempt; this is verified by the same length test that enforces the 1000-character ceiling.
4. **The update-guidance pointer** — a short clause naming `memory.about` as the tool to call when the operator asks how to update or upgrade Rembric (server or plugins).
5. **The `sessionId` reinforcement clause** — a terse directive telling the agent to pass its current session id explicitly when it knows one, and to never guess/invent one, so writes attach correctly instead of falling through the ambiguous-session fallback (see the `sessionId` reinforcement requirement below).

#### Scenario: An MCP client connects on `/mcp/<slug>`

- **WHEN** the `initialize` handshake completes against `/mcp/my-project`
- **THEN** the `InitializeResult.instructions` SHALL contain references to `memory.save`, `memory.search`, `memory.session_summary`, AND `memory.context` plus a note indicating the connection is project-scoped to `'my-project'` and that `scope='global'` will be rejected
- **AND** the instructions SHALL contain the substring `memory.session_summary` and the substring `title` and a reference to "before" (referring to before ending a working turn)
- **AND** the instructions SHALL contain the substring `10000` (the summary length cap)
- **AND** the instructions SHALL contain the substring `memory.context` (the recall flow)
- **AND** the instructions SHALL contain the substring `memory.about` (the update-guidance pointer)

#### Scenario: The session-summary trigger is bound to ending a working turn

- **WHEN** either variant of `buildInstructions(ctx)` is built
- **THEN** the instructions SHALL phrase the `memory.session_summary` trigger as firing before ending any turn in which real work happened
- **AND** the instructions SHALL NOT bind the trigger solely to the literal phrase `before saying "done"`

#### Scenario: Recall guidance is on-demand, not unconditional-at-start

- **WHEN** either variant of `buildInstructions(ctx)` is built
- **THEN** the `memory.context` recall flow SHALL be conditioned on the agent lacking prior detail (e.g. starting/resuming work, after `/compact`, or "what did we do")
- **AND** the instructions SHALL NOT direct an unconditional `memory.context` load on every session start

#### Scenario: An MCP client connects on `/mcp` without a project

- **WHEN** the `initialize` handshake completes against `/mcp`
- **THEN** the `InitializeResult.instructions` SHALL contain the same protocol flows (the proactive save flow, the on-demand recall flow, the session-close flow with the `10000`-char cap, AND the `memory.about` update-guidance pointer) and a note indicating the connection is global-scope and that project memories require opening `/mcp/<slug>` or sending `X-Rembric-Project`

#### Scenario: Instructions length is checked at build time

- **WHEN** the test suite runs against both `/mcp` and `/mcp/<slug>` variants of `buildInstructions(ctx)`
- **THEN** both outputs SHALL be 1000 characters or fewer (the raised cap — the 10000-char summary cap mention, the recall flow, AND the memory.about pointer MUST all fit within the 1000-char budget)
- **AND** both outputs SHALL contain the substring `10000`
- **AND** both outputs SHALL contain the substring `memory.context`
- **AND** both outputs SHALL contain the substring `memory.about`

#### Scenario: A client that does not consume `instructions` connects

- **WHEN** an MCP client ignores the `instructions` field
- **THEN** every tool SHALL still function normally (the field is informational only)
- **AND** `memory.about` SHALL remain discoverable through the MCP tool manifest regardless of whether the client consumed the `instructions` pointer

#### Scenario: instructions.test.ts asserts the protocol flows are present

- **WHEN** `apps/server/src/mcp/instructions.test.ts` runs against `buildInstructions({requestedSlug: 'demo'})` and `buildInstructions({requestedSlug: null})`
- **THEN** both outputs SHALL contain the substrings `memory.save`, `memory.context`, `memory.session_summary`, AND `memory.about`
- **AND** both outputs SHALL be ≤1000 chars
- **AND** existing assertions for `memory.search`, scope notes, the `10000` cap, and the proactive (non-"done"-bound) session-summary phrasing SHALL pass

### Requirement: Tools that attach a write to a session MUST accept an explicit `sessionId` override, reinforced in their descriptions

`memory.save`, `memory.session_summary`, `memory.session_end`, `memory.save_prompt`, and `memory.capture_passive` SHALL accept an optional `sessionId: string` argument. When provided, it SHALL take precedence over the transport's own session resolution (the `SessionRouter` entry, then the ambiguous-active-session fallback) — mirroring the explicit-first precedence `memory.session_summary`/`memory.session_end` already apply via `resolveSessionId`. Each tool's description SHALL mention `sessionId` explicitly (not only via the input schema's per-argument `describe()`, since some MCP clients do not surface per-property schema descriptions to the model) with guidance to pass it only if genuinely known and never invent one.

This closes a blind spot: `memory.session_summary`'s and `memory.session_end`'s zod schemas already declared `sessionId` as optional, but their tool descriptions never mentioned it — a model reading only the description had no reason to believe passing it was possible. `memory.save` and `memory.save_prompt` did not accept the argument at all prior to this requirement.

An explicit `sessionId` on the write-_attaching_ tools (`memory.save`, `memory.save_prompt`, `memory.capture_passive`) SHALL be validated before it is honored. The server SHALL resolve the named session row and require that it (a) is owned by the caller's token (`token_id` matches the request context), (b) belongs to the caller's effective project (`project_id` equals the connection's resolved project id, where a global-scope write requires `project_id IS NULL`), and (c) is not soft-deleted (`deleted_at IS NULL`). When (a) or (b) fails, the call SHALL be rejected with code `session_not_found` — the same masking code the session-lifecycle tools use, so a caller cannot probe which session ids exist under other tokens or projects. When (a) and (b) pass but (c) fails, the call SHALL be rejected with code `session_deleted`. On rejection no row SHALL be written. Validation applies only when `sessionId` is explicitly supplied; the transport/active-session fallback paths already resolve to a session owned by the caller within the effective scope. An `ended` (but not soft-deleted) session remains a valid attachment target. `memory.session_summary`/`memory.session_end` retain their existing service-layer cross-token + soft-delete checks. This closes a security blind spot: prior to this requirement an explicit `sessionId` was honored verbatim, letting a caller forge an attachment to another token's or another project's session.

#### Scenario: memory.save accepts and prioritizes an explicit sessionId

- **GIVEN** two sessions are concurrently active for the same `(tokenId, projectId)` (the ambiguous-fallback case where auto-resolution returns null)
- **WHEN** the agent calls `memory.save({..., sessionId: '<S>'})` with an explicit, valid session id
- **THEN** the saved memory's `session_id` SHALL be `'<S>'`, NOT null — the explicit value bypasses the ambiguous fallback entirely

#### Scenario: memory.save_prompt accepts and prioritizes an explicit sessionId

- **WHEN** the agent calls `memory.save_prompt({content, title, sessionId: '<S>'})`
- **THEN** the persisted prompt row's `session_id` SHALL be `'<S>'`

#### Scenario: Tool descriptions mention sessionId explicitly

- **WHEN** the `memory.save`, `memory.session_summary`, `memory.session_end`, `memory.save_prompt`, and `memory.capture_passive` tool descriptions are inspected
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

The server SHALL register a `memory.judge` tool that closes pending judgments surfaced by `memory.save`. The schema SHALL accept EITHER a single judgment `{ judgmentId: string, relation: enum, reason?: string, confidence?: number, evidence?: any }` OR a batch `{ judgments: Array<{ judgmentId, relation, reason?, confidence?, evidence? }> }` (the array SHALL be non-empty and capped at 25 items; an empty array is rejected with `invalid_input`). Exactly one of the single fields or `judgments` SHALL be supplied; supplying both or neither SHALL be rejected with `invalid_input`. When `relation = 'supersedes'`, the server SHALL transition the target memory to `status = 'superseded'` and append the target's id to the source's `replaces[]`. Other relations SHALL only update the `memory_relations` row.

The batch form exists so an agent can close every entry in `memory.save.candidates[]` in one round-trip. Each item in a batch SHALL run in its OWN judge transaction (the same per-call transaction the single form uses); there SHALL be NO outer transaction spanning the batch, so a failing item SHALL NOT roll back the others. The single-form response is unchanged: `{ ok: true, judgmentId, relation, status, judgedAt }`. The batch-form response SHALL be `{ ok: true, results: Array<{ ok: true, judgmentId, relation, status, judgedAt } | { ok: false, judgmentId, code, message }> }`, in input order, one entry per submitted item, where the error `code` is whatever `DomainError.code` that item raised (e.g. `memory_not_found` for an unknown id, `conflict` for an already-closed row).

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

- **WHEN** `memory.judge` is called (single form) on a row whose `status` is already `'judged'`
- **THEN** the call SHALL fail and the original verdict SHALL remain unchanged

#### Scenario: Judging with a bogus judgmentId

- **WHEN** `judgmentId` matches no row (single form)
- **THEN** the call SHALL fail and no row SHALL be mutated

#### Scenario: Batch judge closes every candidate from one save

- **GIVEN** three pending rows `[J1, J2, J3]` surfaced by one `memory.save`
- **WHEN** the agent calls `memory.judge({ judgments: [{ judgmentId: J1, relation: 'not_conflict' }, { judgmentId: J2, relation: 'related', confidence: 0.8 }, { judgmentId: J3, relation: 'supersedes', confidence: 0.95 }] })`
- **THEN** the response SHALL be `{ ok: true, results: [...] }` with three entries in input order, each `{ ok: true, judgmentId, relation, status: 'judged', judgedAt }`, and J3's target SHALL be `status = 'superseded'`

#### Scenario: A bad item in a batch does NOT sink the others

- **GIVEN** a batch `[{ judgmentId: J1, relation: 'not_conflict' }, { judgmentId: 'BOGUS', relation: 'related' }, { judgmentId: J3, relation: 'compatible' }]` where J1 and J3 are valid pending rows and `BOGUS` matches no row
- **WHEN** the agent calls `memory.judge({ judgments })`
- **THEN** the response `results` SHALL be `[{ ok: true, judgmentId: J1, ... }, { ok: false, judgmentId: 'BOGUS', code, message }, { ok: true, judgmentId: J3, ... }]`, and J1 and J3 SHALL be `status = 'judged'` (NOT rolled back by the failed middle item)

#### Scenario: Batch judge rejects an empty or oversized array

- **WHEN** the agent calls `memory.judge({ judgments: [] })`, or with more than 25 items
- **THEN** the call SHALL be rejected with code `invalid_input` and SHALL NOT mutate any row

#### Scenario: memory.judge rejects mixing the single and batch forms

- **WHEN** the agent calls `memory.judge({ judgmentId: J1, relation: 'related', judgments: [...] })` or `memory.judge({})`
- **THEN** the call SHALL be rejected with code `invalid_input` and SHALL NOT mutate any row

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
- `sessionId?: string` (optional; when provided, takes precedence over the session-attach helper's own resolution — see the `sessionId` reinforcement requirement below).

Standard behaviour: the server SHALL insert a new row into `prompts` with `content`, `title`, `tags`, the resolved `session_id` (the caller's explicit `sessionId` when provided, else the existing session-attach helper), the active scope's `project_id`, and `agent` copied from the token name. The row SHALL be created with `deleted_at = NULL`, `replaces = NULL`.

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

### Requirement: The MCP server MUST expose a read-only `memory.about` update-guidance tool

The server SHALL register a `memory.about` tool that returns Rembric update guidance as structured data. The tool SHALL take no input parameters, SHALL be read-only (no database access, no persistence, no mutation of any kind), and SHALL be idempotent. Its registered description SHALL contain the keywords `update` and `upgrade` and reference plugins so an agent selects it when the operator asks how to update or upgrade Rembric.

The tool acts as the cross-client equivalent of a Claude-Code skill: it is the portable surface — reachable from all four supported clients — that hands the operator the commands to run. It SHALL be **guidance-only**: it returns command strings for the operator to run and SHALL NOT execute `curl`, `sh`, `docker`, or any shell command itself.

The response SHALL be split into two axes that are never conflated:

- `server`: an object containing the running server version (the value of `REMBRIC_VERSION`), a human-readable note that this is the server (which runs wherever the tool executes, e.g. the operator's VPS), and the server update path on that host (`docker compose pull && docker compose up -d`). This axis SHALL NOT claim anything about client plugin state.
- `plugins`: an object containing the canonical TUI-installer commands — a **read-only status command** (`… --status --json`) that reports the server and each plugin's installed-vs-available version with a per-agent `action` (`none`/`update`/`ahead`/`unknown`), the interactive entrypoint (`curl -fsSL <install-url> | sh`), the update-all variant (`… --action=update`), and a subset example (`… --action=update --agent=<a,b>`) — together with an explicit note that plugins are installed per client machine, that this server cannot see them, that the operator runs the command on each machine where Rembric is used, and that the operator should run the status command first and update only where `action` is `update`.

The status command SHALL be the installer's existing read-only `--status --json` mode; the tool SHALL NOT compute installed-vs-available state itself (that detection is client-side and owned by the installer). The status command SHALL NOT include `--action=update` or any mutating flag.

The `plugins` command strings SHALL be derived from the canonical installer entrypoint and flags defined by the `tui-installer` capability; the tool SHALL NOT fork or hand-edit the installer's flag set. The `server` update command SHALL NOT duplicate the dashboard-driven one-click flow owned by the `self-update` capability; `memory.about` only surfaces the manual host command and the running version.

#### Scenario: A client calls memory.about

- **WHEN** an authenticated MCP client calls `memory.about` with no arguments
- **THEN** the tool SHALL return a result containing a `server` object whose version equals the running `REMBRIC_VERSION` and a `plugins` object containing the installer command(s)
- **AND** the result SHALL NOT trigger any database read or write

#### Scenario: The two axes are labeled and never conflated

- **WHEN** the tool result is inspected
- **THEN** the `plugins` axis SHALL include a note stating that plugins live on each client machine and that the server cannot see them
- **AND** the `server` version SHALL NOT be presented as an indicator of whether any client plugin is up to date

#### Scenario: The tool is guidance-only and never executes

- **WHEN** `memory.about` is invoked
- **THEN** the server SHALL NOT spawn a process, run `curl`/`sh`/`docker`, or perform any side effect; it SHALL only return command strings for the operator to run

#### Scenario: The plugins commands match the canonical installer entrypoint

- **WHEN** the tool's `plugins` command strings are compared against the canonical installer entrypoint defined by the `tui-installer` capability
- **THEN** the interactive and `--action=update` invocations SHALL reference that same entrypoint and flag set (no forked URL or flags)

#### Scenario: The tool offers a read-only status command to check before updating

- **WHEN** the `plugins` axis is inspected
- **THEN** it SHALL include a `status` command using the installer's `--status --json` mode that references the canonical entrypoint
- **AND** that command SHALL NOT contain `--action=update` or any other mutating flag
- **AND** the `plugins.note` SHALL direct the operator to run the status command first and update only where the reported `action` is `update`

### Requirement: The MCP endpoint MUST advertise the authorization server on `401` when OAuth is enabled

When OAuth is enabled (`REMBRIC_PUBLIC_URL` set), an unauthenticated or invalid-token request to `/mcp` or `/mcp/<slug>` SHALL respond `401` with a `WWW-Authenticate: Bearer` header that includes `resource_metadata="<issuer>/.well-known/oauth-protected-resource"`, enabling OAuth clients to discover the authorization server. When OAuth is disabled, the `401` response SHALL NOT include this header and SHALL be byte-compatible with the pre-change behavior.

#### Scenario: 401 advertises resource metadata when OAuth enabled

- **GIVEN** the server started with `REMBRIC_PUBLIC_URL=https://rembric.example.com`
- **WHEN** a request hits `/mcp` with no `Authorization` header
- **THEN** the response SHALL be `401` and SHALL carry `WWW-Authenticate: Bearer resource_metadata="https://rembric.example.com/.well-known/oauth-protected-resource"`

#### Scenario: 401 unchanged when OAuth disabled

- **GIVEN** the server started without `REMBRIC_PUBLIC_URL`
- **WHEN** a request hits `/mcp` with no `Authorization` header
- **THEN** the response SHALL be `401` and SHALL NOT include a `WWW-Authenticate` header

### Requirement: OAuth and static tokens MUST share the path-scoping contract

A connection authenticated by an OAuth access token SHALL be subject to the identical `/mcp` vs `/mcp/<slug>` path-scoping contract as a static-token connection: a path-scoped OAuth connection SHALL enforce strict project isolation, and a global OAuth connection SHALL behave as a global static-token connection. The authentication mechanism SHALL NOT change scope resolution.

#### Scenario: Path-scoped OAuth connection enforces isolation

- **GIVEN** a connection at `/mcp/foo` authenticated with an OAuth access token
- **WHEN** the client calls `memory.save` with `scope='global'`
- **THEN** the response SHALL be an MCP error with `code: 'scope_locked'`, identical to the static-token case

#### Scenario: Reserved OAuth paths do not shadow MCP slugs

- **GIVEN** OAuth is enabled
- **WHEN** the server routes requests for `/authorize`, `/token`, `/register`, and `/.well-known/oauth-*`
- **THEN** those SHALL resolve to the OAuth handlers and SHALL NOT be interpreted as `/mcp` project slugs, and `/mcp/<slug>` routing SHALL remain unchanged

### Requirement: Every MCP tool MUST advertise behavioral annotations

Every tool registered on the MCP server SHALL declare an `annotations` object consistent with Rembric's append-only and closed-store invariants. The annotation set SHALL satisfy:

- Read-only tools (`memory.search`, `memory.get`, `memory.context`, `memory.session_get`, `memory.timeline`, `memory.search_prompts`, `memory.doctor`, `memory.about`, `memory.stats`, `memory.suggest_topic_key`, `project.list`, `project.current`) SHALL carry `readOnlyHint: true`.
- Mutating tools SHALL carry `readOnlyHint: false`.
- Because no tool performs an irreversible destructive update (supersede is a reversible, journaled `status` flip; rows are never deleted), **every** tool SHALL carry `destructiveHint: false`.
- Because Rembric is a closed local store, **every** tool SHALL carry `openWorldHint: false`.
- Tools whose repeated invocation is side-effect-free or last-call-wins (`memory.compare`, `memory.session_end`, `memory.session_summary`, `memory.suggest_topic_key`, and all read-only tools) SHALL carry `idempotentHint: true`.

Annotations are advisory metadata only: they SHALL NOT change tool inputs, outputs, or the `text` result contract.

#### Scenario: Read-only tools report readOnlyHint

- **WHEN** a client calls `tools/list`
- **THEN** each of `memory.search`, `memory.get`, `memory.context`, `memory.session_get`, `memory.timeline`, `memory.search_prompts`, `memory.doctor`, `memory.about`, `memory.stats`, `memory.suggest_topic_key`, `project.list`, and `project.current` SHALL report `annotations.readOnlyHint === true`

#### Scenario: No tool is advertised as destructive

- **WHEN** a client calls `tools/list`
- **THEN** every registered tool SHALL report `annotations.destructiveHint === false`

#### Scenario: No tool is advertised as open-world

- **WHEN** a client calls `tools/list`
- **THEN** every registered tool SHALL report `annotations.openWorldHint === false`

#### Scenario: Mutating tools are not marked read-only

- **WHEN** a client calls `tools/list`
- **THEN** `memory.save`, `memory.confirm`, `memory.capture_passive`, `memory.save_prompt`, `memory.session_start`, `memory.session_summary`, `memory.session_end`, `memory.judge`, `memory.compare`, and `project.use` SHALL report `annotations.readOnlyHint === false`

#### Scenario: Annotations do not alter the result contract

- **WHEN** any annotated tool is invoked successfully
- **THEN** the result SHALL still be returned as a `text` content block (no `structuredContent` is required), unchanged from the pre-annotation behavior

### Requirement: Every MCP tool MUST advertise an output schema and return conforming structured content

Every tool registered on the MCP server SHALL declare an `outputSchema` describing the shape of its **successful** result, and on success SHALL return a `structuredContent` object that conforms to that schema. The `structuredContent` SHALL be the JSON-normalized form of the response (timestamps as ISO strings), equal in meaning to the existing `text` content block.

This requirement is additive and SHALL NOT change:

- the `text` content block returned by any tool (clients that read only `text` are unaffected), or
- error results — results returned via `mcpError` carry `isError: true`, for which output-schema validation is not performed.

#### Scenario: A successful tool call returns structured content

- **WHEN** any registered tool is invoked and succeeds
- **THEN** the result SHALL include a `structuredContent` object conforming to the tool's declared `outputSchema`
- **AND** the result SHALL still include the equivalent `text` content block

#### Scenario: Every tool advertises an output schema

- **WHEN** a client calls `tools/list`
- **THEN** every tool entry SHALL include an `outputSchema`

#### Scenario: Error results are exempt from output-schema validation

- **WHEN** a tool returns an error via `mcpError` (e.g. `not_found`, `scope_locked`, `forbidden`, `invalid_input`)
- **THEN** the result SHALL carry `isError: true` and SHALL NOT be required to include `structuredContent`

#### Scenario: Structured content matches the text payload

- **WHEN** a tool succeeds and returns both `text` and `structuredContent`
- **THEN** parsing the `text` JSON SHALL yield the same object as `structuredContent`

### Requirement: MCP tool handlers MUST be organized one domain per module

The MCP tool-handler layer at `apps/server/src/mcp/` SHALL place each tool domain in its own `<domain>-tools.ts` module that exports exactly one `build<Domain>Handlers` factory and its `<Domain>ToolDeps` interface. There SHALL be no generically-named `tools.ts` handler module. Cross-cutting helpers shared by more than one handler module (the `DomainError`→MCP error mapper, the session-router key resolver, scope resolution, and serialization helpers) SHALL be defined exactly once in a shared module and imported, never copied. `server.ts` SHALL remain a thin registration manifest that wires the per-domain factories without containing handler logic.

#### Scenario: Invariant test rejects a generic or duplicated handler module

- **WHEN** the invariants suite (`apps/server/src/test/invariants.test.ts`) scans `apps/server/src/mcp/` for handler modules
- **THEN** the suite SHALL fail if a file named `tools.ts` exists, if any `*-tools.ts` module does not export exactly one `build*Handlers` factory, or if `errToMcp` / `routerKey` are defined in more than one module

#### Scenario: Tool surface is unchanged by the reorganization

- **WHEN** the MCP server registers its tools after the reorganization
- **THEN** the exact same set of tool names, input schemas, output schemas, and annotations SHALL be advertised as before, and every existing `mcp-api` tool-contract requirement SHALL continue to hold

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
