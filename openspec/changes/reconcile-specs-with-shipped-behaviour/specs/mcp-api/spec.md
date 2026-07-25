## MODIFIED Requirements

### Requirement: memory.search response MUST include relation annotations

The `memory.search` response SHALL include a `relations` array on each result row, populated in a single JOIN over `memory_relations`. Annotation kinds: `supersedes`, `superseded_by`, `conflicts_with`, `related`, `compatible`, `scoped`, `pending_conflict`. Each annotation SHALL include the target id and (when judged) a short snippet of the target's content.

Each result row SHALL additionally carry the derived review metadata for the memory (see the `memory` capability): `reviewState` (`'fresh'` | `'needs_review'`) for `active` rows, and `reviewAfter` when non-null. These fields are informational metadata only — they SHALL NOT change result ordering, scope isolation, or which rows are returned. Rows that are not `active` SHALL omit `reviewState`.

`memory.search` SHALL accept two OPTIONAL projection parameters that shape the returned rows WITHOUT changing which rows are returned or their order: `snippet` (a positive integer) and `fields` (a list of row field names). When `snippet` is supplied, each returned row's `content` SHALL be truncated to at most that many characters using the same truncation semantics as `memory.context` (the snippet helper: slice and append an ellipsis when the content exceeds the cap). When `fields` is supplied, the response SHALL return only the named fields PLUS the always-present identity fields `id`, `type`, and `title` (so every projected row remains identifiable). The two parameters compose: requesting `content` in `fields` together with a `snippet` cap yields a truncated `content`. When NEITHER `snippet` NOR `fields` is supplied, the response SHALL be the unchanged full-content row shape (byte-for-byte back-compatible). Projection SHALL be applied AFTER selection, ranking and scope enforcement — it SHALL NOT alter any of them. Projection touches no timestamp, and neither does the search it projects: `memory.search` advances `last_seen_at` for no row (see the `memory` capability, "Being returned by a search MUST NOT be sufficient to confer durability").

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

#### Scenario: A projected search still touches nothing

- **WHEN** `memory.search` is called with `snippet` and `fields` over rows that are decay-eligible
- **THEN** no returned row's `last_seen_at` SHALL have been advanced

### Requirement: The MCP server MUST expose three research tools

The `/mcp` and `/mcp/<slug>` endpoints SHALL register `memory.context`, `memory.timeline`, and `memory.capture_passive` with the following contracts. Note that `memory.save_prompt` (write side) and `memory.search_prompts` (read side) are registered in their own dedicated requirements; this requirement scopes the research/context tools only.

#### Scenario: `memory.context` returns a bootstrap snapshot

- **WHEN** an MCP client calls `memory.context` with `{ sessions?: number, prompts?: number, memories?: number, includeArchived?: boolean }`
- **THEN** the server SHALL return `{ recentSessions, recentPrompts, recentMemories, pendingJudgments, needsReview }`, with each list scoped to the request context (global vs path-scoped project)
- **AND** when a size argument is omitted the default SHALL be `sessions = 3`, `memories = 10`, `prompts = 5` (kept small because the snapshot is read every session start; callers needing more pass explicit args, still bounded by the maxima below)
- **AND** `recentSessions` SHALL contain only sessions that satisfy the `sessionHasContent` predicate (see `sessions` capability), ordered by `started_at DESC`, with empty sessions filtered out BEFORE truncation to `sessions ?? 3`
- **AND** `recentPrompts` SHALL be ordered by `created_at DESC` and filtered to `deleted_at IS NULL`
- **AND** `recentMemories` SHALL be ordered by `COALESCE(last_seen_at, created_at) DESC` — activity recency, falling back to creation for a row never dereferenced, which is most rows given that search does not touch — with `includeArchived = false` (default) filtering out `status = 'archived'` rows
- **AND** `pendingJudgments` SHALL contain at most 5 pending relations in scope with `created_at < (now - JUDGMENT_ORPHAN_AFTER_MS)`, oldest first, each entry carrying `{ judgmentId, sourceId, targetId, sourceSnippet, targetSnippet, ageMs }` so the agent can close them with `memory.judge` without further reads
- **AND** `needsReview` SHALL contain at most 3 `active` in-scope memories whose derived `reviewState = 'needs_review'` (see the `memory` capability), ordered recently-refuted first and then oldest `reviewBaseline` first (see the `memory` capability, "A refutation MUST lead the review queue only while it is recent"), each entry carrying `{ id, type, snippet, reviewAfter, ageMs }` (where `snippet` uses the same per-row cap as the other context lists, `ageMs = now - reviewBaseline` the time since last affirmation) so the agent can re-affirm with `memory.confirm`, supersede with `memory.save` + `topic_key`, or — when it contradicts another memory — fall through to the existing `memory.judge` flow. The list is kept small by COUNT (only the 3 oldest) because it is recurring (every `memory.context`) and usually populated

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
- **THEN** the server SHALL extract each subsequent numbered (`1.`, `2.`) or bulleted (`-`, `*`) item, save each as a separate memory with `type = 'reference'` (there is no `discovery` type) and the active scope, and SHALL return `{ saved: number, ids: string[] }` plus the aggregated `candidates[]` when the saves detected any

#### Scenario: `memory.capture_passive` finds no learnings block

- **WHEN** the input text has no matching `## Key Learnings:` heading
- **THEN** the server SHALL return `{ saved: 0, ids: [] }` with an explicit `reason` naming the expected heading form (see "`memory.capture_passive` MUST NOT report success when it extracted nothing") and SHALL NOT error

### Requirement: The `memory.get` tool MUST return the memory and its history

`memory.get` SHALL accept an `id` and SHALL return the memory's content, status, scope, project, tags, `topicKey`, `replaces`, a bounded predecessor projection derived from `replaces`, and the affirming-confirmation count for the current head. The predecessor projection is bounded and content-free — see the `memory` capability, "Supersedes-chain reads MUST be bounded and content-free"; the response SHALL carry `predecessorCount` and `truncated` so a caller can tell that more ancestry exists. The memory row SHALL NOT expose the internal `source` provenance blob (token name, agent, model), which is operator data surfaced on the dashboard and never returned to an agent.

For an `active` memory, the response SHALL additionally include the derived review metadata (see the `memory` capability): `reviewState` (`'fresh'` | `'needs_review'`), `reviewAfter` when non-null, and `reviewEscalated`. For non-`active` memories these fields SHALL be omitted.

`memory.get` SHALL additionally accept an OPTIONAL `ids` array as a back-compatible batch form. Exactly one of `id` or `ids` SHALL be supplied; supplying both, or neither, SHALL be an `invalid_input` error. When `id` is supplied, the response shape SHALL be unchanged from the single-memory form above. When `ids` is supplied, the response SHALL contain an ordered `memories` array — one per id that resolves to an in-scope, token-authorized memory, in the same order the ids were requested, each entry carrying the same per-memory shape as the single-`id` form — plus a `notFound` array listing the requested ids that did not resolve. The batch form SHALL be scope-enforced via a scoped service read: an id outside the connection's effective scope SHALL be reported in `notFound` and SHALL NOT leak the memory's content or existence, identically to how the single-`id` form treats an out-of-scope id as not found. The `ids` array SHALL be bounded by a maximum length; a request exceeding it SHALL be an `invalid_input` error.

The two forms differ deliberately in one respect: the single-`id` form dereferences ONE memory and advances its access signal, while the batch form is a pure read and advances nothing, so a bulk pull cannot reshuffle decay eligibility or context recency for every id it names (see the `memory` capability, "A dereferenced memory is treated as accessed").

#### Scenario: Retrieve a merged memory

- **WHEN** an authenticated client calls `memory.get` with the id of a merged memory M
- **THEN** the response SHALL include M's content, M's predecessors as `{id, title, status, createdAt}` projections, and the confirmation count against M

#### Scenario: memory.get reports review state for an active memory

- **GIVEN** an `active` memory M whose derived `reviewState` is `'fresh'`
- **WHEN** an authenticated client calls `memory.get('M')`
- **THEN** the response SHALL include `reviewState: 'fresh'` and `reviewAfter` (the non-null derived timestamp for M's type)

#### Scenario: memory.get with a single id is unchanged

- **WHEN** an authenticated client calls `memory.get({ id: 'M' })` (no `ids`)
- **THEN** the response SHALL be the single-memory shape (memory, head, bounded predecessors, confirmationCount, relations, and review metadata when active)

#### Scenario: memory.get with ids returns an ordered batch

- **GIVEN** in-scope memories M1, M2, M3 all readable by the calling token
- **WHEN** an authenticated client calls `memory.get({ ids: ['M2', 'M1', 'M3'] })`
- **THEN** the response SHALL include `memories` ordered `[M2, M1, M3]`, each carrying the single-`id` per-memory shape, and `notFound: []`

#### Scenario: The batch form advances no access signal

- **GIVEN** decay-eligible in-scope memories M1 and M2
- **WHEN** an authenticated client calls `memory.get({ ids: ['M1', 'M2'] })`
- **THEN** neither row's `last_seen_at` SHALL have been advanced, and both SHALL remain decay-eligible

#### Scenario: memory.get batch never leaks a cross-scope id

- **GIVEN** memory X exists in a DIFFERENT project than the connection's effective scope, and in-scope memory M1
- **WHEN** an authenticated client calls `memory.get({ ids: ['M1', 'X'] })`
- **THEN** the response `memories` SHALL contain only M1, and `X` SHALL appear in `notFound`
- **AND** the response SHALL NOT include X's content, title, or any field distinguishing "out of scope" from "does not exist"

#### Scenario: memory.get rejects ambiguous id arguments

- **WHEN** an authenticated client calls `memory.get` with BOTH `id` and `ids` set, or with NEITHER set
- **THEN** the server SHALL return an `invalid_input` error and SHALL NOT return any memory

### Requirement: The MCP server MUST expose two observability tools

The `/mcp` and `/mcp/<slug>` endpoints SHALL register `memory.doctor` and `memory.stats`. Both output contracts SHALL enumerate exactly the fields the tools return: a documented field the tool does not return misleads a client into treating its absence as a fault, and a returned field the contract omits is undocumented surface (the two counters added for queue-depth observability were both in the second category).

#### Scenario: `memory.doctor` returns an operational report

- **WHEN** an MCP client calls `memory.doctor`
- **THEN** the server SHALL return `{ db: { open, journalMode, integrity, sizeBytes }, embeddings: { model, backlog }, entities: { backlog }, consolidation: { lastRunAt, lastRunOps }, sessions: { active }, review: { needsReview, pendingJudgments }, warnings: string[] }` — the report SHALL NOT contain an `llm` block, and the `embeddings` block SHALL NOT contain `enabled` (embeddings are always on); `model` SHALL identify the compiled-in embedding model
- **AND** `entities.backlog` and `review` SHALL be server-wide, matching `sessions.active`

#### Scenario: `memory.stats` returns counters by scope and status

- **WHEN** an MCP client calls `memory.stats`
- **THEN** the server SHALL return `{ scope, memoriesByStatus, memoriesByType, sessionsByStatus, needsReviewTotal, pendingJudgmentsTotal }`, where `scope` is the resolved scope label, the three `*By*` values are each a `Record<string, number>`, and the two totals are numbers — every one of them computed against the request context

#### Scenario: A read-only token calls `memory.doctor` or `memory.stats`

- **WHEN** the caller's scope is `read:*`, or is `read:project:<id>` and the connection's effective scope resolves to that same project
- **THEN** both tools SHALL succeed (they are read-only by design)
- **WHEN** the caller's scope is `read:project:<id>` and the connection's effective scope resolves to global or to a different project
- **THEN** the call SHALL be rejected with code `forbidden`

### Requirement: Memory-returning MCP reads MUST expose `topic_key`

`topic_key` is the identity of a convergent topic: saving with the same key atomically supersedes the previously-active row in the same `(scope, project_id, topic_key)`. That convergence requires the agent to reproduce a byte-identical key across sessions, so the key SHALL be observable. Every memory-returning read — `memory.get`, `memory.search`, `memory.context.recentMemories`, and `memory.save` candidates — SHALL include the memory's `topicKey` (null when unset).

`memory.search` SHALL additionally accept a `topic_key` filter that returns only rows carrying that exact key. Because a topic slot holds exactly one `active` row and every earlier take on the topic is `superseded`, a `topic_key` filter supplied WITHOUT an explicit `status` SHALL return the topic's whole history rather than defaulting to `active` — otherwise the filter's stated purpose (checking whether a topic already converged before minting a synonym key) is unreachable, because the one row it returns is the only row it could ever return. An explicit `status` alongside `topic_key` SHALL still narrow to that status.

The vector index is partitioned by `status`, so an any-status read enumerates the non-archived statuses in the dense branch; an archived row under a given key is therefore reachable through the lexical and listing branches, matching the existing rule that the dense branch is skipped for `status: 'archived'`.

#### Scenario: A search result carries its topic key

- **GIVEN** an active memory saved with `topic_key = 'decision/deploy-runbook'`
- **WHEN** `memory.search` returns it
- **THEN** the returned row SHALL include `topicKey: 'decision/deploy-runbook'`

#### Scenario: Filtering by topic key

- **WHEN** `memory.search` is called with `topic_key = 'decision/deploy-runbook'` in a scope containing that key
- **THEN** the response SHALL contain only rows whose `topic_key` equals that value

#### Scenario: A topic key filter returns the topic's history

- **GIVEN** four memories saved in sequence under `topic_key = 'decision/deploy-runbook'`, leaving one `active` and three `superseded`
- **WHEN** `memory.search` is called with that `topic_key` and no `status`
- **THEN** all four SHALL be returned

#### Scenario: An explicit status still narrows a topic key filter

- **GIVEN** the same four memories
- **WHEN** `memory.search` is called with that `topic_key` and `status: 'active'`
- **THEN** exactly the one active row SHALL be returned

### Requirement: `memory.search` MUST accept an `entity` filter, and no new tool SHALL be added

Exact-address retrieval SHALL be reachable as an `entity` argument on `memory.search` rather than as a new tool. The MCP tool surface is already at the practical ceiling for reliable tool selection — 23 tools with four clusters the model cannot easily distinguish — so a capability expressible as an argument SHALL be an argument.

When `entity` is supplied, the response SHALL be the scoped set of memories linked to that entity, chronologically ordered, and the response SHALL indicate that the entity path was taken rather than the ranked text-query path, so the agent does not read the absence of relevance scores as a defect.

Completeness is bounded, and the bound SHALL be the same generous over-fetch ceiling the ranked branches use rather than the ranked default page size: an omitted `limit` on the entity path means "every linked memory in scope" up to that ceiling, NOT the small default that is calibrated for a ranked page. Returning eight rows out of twelve under a description promising completeness is a correctness problem, because the agent has no signal that anything was withheld. An explicit `limit` SHALL still bound the page.

`entity` SHALL compose with every other selection filter `memory.search` accepts — `status`, `type`, `tag`, `topic_key` and `include_global` — applying the same predicates with the same meaning as on the ranked path. A filter that is documented as combinable but silently dropped is worse than an unsupported one: an agent that narrows to `type: 'user'` and receives unfiltered rows reads project notes as user preferences. Combining `entity` with a text `query` SHALL narrow within the entity's memories rather than fusing two result sets.

#### Scenario: Retrieving everything known about a file

- **WHEN** `memory.search` is called with an `entity` naming a file path present in scope
- **THEN** every in-scope memory linked to that path SHALL be returned in chronological order

#### Scenario: An omitted limit returns the whole linked set, not a ranked page

- **GIVEN** twelve in-scope memories linked to one entity
- **WHEN** `memory.search` is called with that `entity` and no `limit`
- **THEN** all twelve SHALL be returned

#### Scenario: The response distinguishes the entity path

- **WHEN** `memory.search` returns results for an `entity` lookup
- **THEN** the response SHALL indicate that exact-address retrieval was used

An empty entity result SHALL say whether the index has caught up. The tool's own guidance is "empty means it is not there, so retry with `query`" — which is wrong for as long as the extraction drain is still running, and after a recipe change that is the state of the whole corpus. When an `entity` lookup returns nothing AND the scope still holds memories awaiting their first scan, the response SHALL carry a draining flag, and the argument's description SHALL name it so the agent retries the same lookup rather than degrading to text. A non-empty result and a miss over a fully-scanned scope SHALL NOT carry it, so its presence always means something.

#### Scenario: An unknown entity returns empty rather than falling back to text search

- **WHEN** `memory.search` is called with an `entity` that exists nowhere in scope
- **THEN** the response SHALL be empty and SHALL NOT silently degrade into a text query over that string
- **AND** when the scope is fully scanned the response SHALL NOT carry the draining flag

#### Scenario: An empty lookup during a drain is marked as such

- **GIVEN** an in-scope memory referencing an identifier, saved but not yet scanned for entities
- **WHEN** `memory.search` is called with that `entity`
- **THEN** the response SHALL be empty AND SHALL carry the draining flag
- **AND** after the drain completes, the same call SHALL return the memory and SHALL NOT carry the flag

#### Scenario: Entity plus text query narrows rather than fuses

- **WHEN** `memory.search` is called with both an `entity` and a text `query`
- **THEN** the result SHALL be the entity's memories ranked by the text query, not a fusion of two independent result sets

#### Scenario: Entity combines with type and status

- **GIVEN** one entity linked to a `user` memory, a `project` memory and an `archived` memory
- **WHEN** `memory.search` is called with that `entity` and `type: 'user'`
- **THEN** only the `user` memory SHALL be returned
- **WHEN** the same call passes `status: 'archived'` instead
- **THEN** only the archived memory SHALL be returned

#### Scenario: Entity combines with include_global

- **GIVEN** a global memory and a project memory both linked to the same path, and a third project's memory linked to it too
- **WHEN** `memory.search` is called in the project scope with that `entity` and `include_global`
- **THEN** the global and the in-scope project memory SHALL both be returned, and the other project's memory SHALL NOT

### Requirement: `memory.context` MUST offer a relevance channel alongside recency

`memory.context` is the tool the protocol directs agents to when starting or resuming work, and its recency channel is ordered by activity alone — nothing about the work at hand influences it. Recency answers "what happened lately", which is not the same question as "what bears on this task", and on a corpus spanning several projects the two answers diverge quickly.

`memory.context` SHALL accept an optional `focus` string and SHALL return a `relevantMemories[]` channel. The existing recency channel SHALL be unchanged and the two SHALL be separately labelled in the response, so the model can tell which rows were selected for relevance and which for recency.

The relevance channel is filled in two passes, in this order. First, an **entity pre-pass**: identifiers recognised in the seed text by the deterministic extractor are looked up as exact addresses, and their linked in-scope memories are admitted first, because an exact identifier match is stronger evidence than any ranked score. Second, if the channel is still under its cap, the scoped hybrid search that backs `memory.search` fills the remainder. Rows are deduped by id across both passes, and each row SHALL carry a `via` field (`'entity'` | `'ranked'`) naming the pass that found it, so the two populations stay distinguishable in the response — the same observability `memory.search`'s entity flag provides.

When `focus` is absent, the server SHALL derive a seed from signals it already holds for the connection — the active project, the session's working directory, and the most recent curated prompts — so an agent that does not know to pass `focus` still receives relevance. When no seed can be derived, the relevance channel SHALL be empty rather than absent, and the recency channel SHALL still be returned.

#### Scenario: An explicit focus drives the relevance channel

- **WHEN** `memory.context` is called with a `focus` describing the task at hand
- **THEN** `relevantMemories[]` SHALL contain scoped results for that text
- **AND** `recentMemories[]` SHALL be unchanged from what the same call returns without `focus`

#### Scenario: An entity in the seed outranks the ranked pass

- **GIVEN** a memory linked to a file path named in the `focus`, and other memories that rank well for the same text
- **WHEN** `memory.context` is called
- **THEN** the linked memory SHALL be admitted, carrying `via: 'entity'`, before any row carrying `via: 'ranked'`

#### Scenario: The ranked pass fills the remainder

- **GIVEN** a `focus` naming one identifier linked to a single memory, and a cap larger than one
- **WHEN** `memory.context` is called
- **THEN** the remaining slots SHALL be filled by the hybrid search, each row carrying `via: 'ranked'`, with no row repeated across the two passes

#### Scenario: A seed with no identifier still returns relevance

- **GIVEN** a `focus` containing no extractable identifier
- **WHEN** `memory.context` is called
- **THEN** `relevantMemories[]` SHALL be filled entirely by the ranked pass

#### Scenario: A seed is derived when focus is omitted

- **GIVEN** a connection with an active project, a session carrying a working directory, and at least one recent curated prompt
- **WHEN** `memory.context` is called with no `focus`
- **THEN** the server SHALL derive a seed from those signals and populate `relevantMemories[]`

#### Scenario: No derivable seed still returns recency

- **GIVEN** a connection with no active session and no recent prompts
- **WHEN** `memory.context` is called with no `focus`
- **THEN** `relevantMemories[]` SHALL be present and empty, and `recentMemories[]` SHALL be returned as today

#### Scenario: The relevance channel respects scope

- **WHEN** `memory.context` is called on a connection scoped to one project and another project contains a strongly-matching memory
- **THEN** that memory SHALL NOT appear in `relevantMemories[]`

## ADDED Requirements

### Requirement: `memory.confirm` MUST accept a verdict, and a refutation MUST carry a reason

The refutation channel is the negative half of the affirmation verb (see the `memory` capability, "The system MUST accept a negative affirmation"), and it is reachable only through MCP — so its arguments, its validation and its response shape are part of this contract rather than an implementation detail of one zod description.

`memory.confirm` SHALL accept an optional `verdict` of `'affirm'` | `'refute'`, defaulting to `'affirm'` so every existing caller keeps its meaning, and an optional `reason` string. A call with `verdict: 'refute'` and no non-empty `reason` SHALL be rejected with `invalid_input` before any row is written: a refutation without a stated reason is an unreviewable claim, and the reason is the only artifact a later reviewer has. `reason` SHALL be rejected for NUL bytes on the same terms as every other agent-supplied text field.

Both verdicts SHALL be recorded against the head of the supersedes chain reachable from the given id, as one append-only event each, and both SHALL be accepted in the batch `ids` form — one verdict applied to every id in the batch, inside one transaction. The response SHALL be `{ ok: true }` plus `confirmed` (the number of distinct ids recorded) for the batch form and `headTruncated` when head resolution stopped at its hop cap. An `affirm` SHALL advance the memory's access signal; a `refute` SHALL NOT, because refuting a memory is not evidence that it was useful.

The tool description SHALL state the refutation channel, its `reason` requirement, and that a refutation neither edits nor archives the memory — an agent that cannot see the channel in the description will not use it, and an agent that misreads it as a delete verb will use it for cleanup, which is exactly what the archive guidance forbids.

#### Scenario: A refutation without a reason is rejected

- **WHEN** `memory.confirm` is called with `verdict: 'refute'` and no `reason` (or an empty one)
- **THEN** the call SHALL fail with `invalid_input` and no confirmation row SHALL have been written

#### Scenario: A refutation is recorded against the chain head

- **GIVEN** a memory M superseded by a memory H
- **WHEN** `memory.confirm` is called on M with `verdict: 'refute'` and a reason
- **THEN** the refutation event SHALL be recorded against H, and the response SHALL be `{ ok: true }`

#### Scenario: A verdict applies to a whole batch

- **WHEN** `memory.confirm` is called with `ids: ['M1','M2']` and `verdict: 'refute'` plus a reason
- **THEN** one refutation SHALL be recorded per distinct id, `confirmed` SHALL be 2, and a failure on either id SHALL leave neither recorded

#### Scenario: The default verdict is unchanged

- **WHEN** `memory.confirm` is called with no `verdict`
- **THEN** the event SHALL be recorded as an affirmation and the memory's access signal SHALL be advanced

#### Scenario: The description names the channel

- **WHEN** the `memory.confirm` tool description is inspected
- **THEN** it SHALL name the `refute` verdict, its mandatory `reason`, and the fact that refuting neither edits nor archives the memory
