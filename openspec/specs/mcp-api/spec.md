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

When the MCP connection is path-scoped (`/mcp/<slug>`) the server SHALL enforce a hard isolation contract on every tool call. The connection's project is the only scope visible:

- `memory.save` with `scope='global'` SHALL be rejected with structured code `scope_locked`.
- `memory.save` with `scope='project'` SHALL be persisted with `project_id` equal to the path-bound project regardless of any other argument the agent supplies.
- `memory.search` SHALL return only memories whose `scope = 'project'` and `project_id` equals the bound project; global memories SHALL NOT be returned. The `includeGlobal` argument SHALL be ignored on path-scoped connections.
- `memory.get` and `memory.confirm` SHALL respond with structured code `not_found` when the requested memory is global or belongs to a different project, regardless of whether the memory exists, to avoid leaking existence across scopes.

A path slug that does not resolve to an existing project SHALL NOT establish any scope. Such a connection has no bound project, so the four clauses above have nothing to bind to; instead **every** tool that resolves scope SHALL be refused with structured code `project_not_found`, reads and writes alike, and SHALL NOT fall back to the global scope. The refusal SHALL be the connection's uniform answer regardless of tool classification: an unresolvable slug SHALL never widen a read to user-wide memory, and SHALL never admit a write into the global scope.

The `not_found` clause above governs a connection whose slug DOES resolve, where the comparison is between the bound project and the requested memory. On an unresolvable slug there is no bound project to compare against, so `project_not_found` — which names the unusable connection — takes precedence over `not_found`, and the two do not conflict.

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

#### Scenario: search on an unresolvable slug refuses instead of reading global memory

- **GIVEN** a connection at `/mcp/no-such-project` whose slug names no project, a token whose scope is `*`, and at least one memory with `scope='global'`
- **WHEN** the client calls `memory.search`
- **THEN** the response SHALL be an MCP error with `code: 'project_not_found'`
- **AND** the response SHALL contain no memory whose `scope='global'`

#### Scenario: get on a global id from an unresolvable slug refuses

- **GIVEN** a connection at `/mcp/no-such-project` whose slug names no project, a token whose scope is `*`, and a memory M with `scope='global'`
- **WHEN** the client calls `memory.get({id: M})`
- **THEN** the response SHALL be an MCP error with `code: 'project_not_found'` and SHALL NOT return M's `content`

#### Scenario: writes on an unresolvable slug do not land in global memory

- **GIVEN** a connection at `/mcp/no-such-project` whose slug names no project and a token whose scope is `*`
- **WHEN** the client calls `memory.capture_passive` with text containing a well-formed Key Learnings section, or calls `memory.save_prompt`
- **THEN** each call SHALL be refused with `code: 'project_not_found'`
- **AND** no row SHALL be inserted into `memory` or `prompts`

#### Scenario: a session is not opened in the global scope from an unresolvable slug

- **GIVEN** a connection at `/mcp/no-such-project` whose slug names no project and a token whose scope is `*`
- **WHEN** the client calls `memory.session_start`
- **THEN** the call SHALL be refused with `code: 'project_not_found'`
- **AND** no `agent_sessions` row SHALL be inserted, in the global scope or any other

#### Scenario: the refusal names candidate slugs

- **GIVEN** a project with slug `rembric` exists and a connection at `/mcp/rembic`
- **WHEN** the client calls any tool that resolves scope
- **THEN** the error payload SHALL include `suggestedSlugs` containing `rembric`

#### Scenario: the connection is not bricked by the refusal

- **GIVEN** a connection at `/mcp/no-such-project` and a token authorized to create a project
- **WHEN** the client calls `project.current`, `project.list`, `memory.about`, or `project.use({slug: 'no-such-project', autocreate: true})`
- **THEN** each call SHALL succeed
- **AND** after the `project.use` call, subsequent scope-resolving tools SHALL operate in that project's scope rather than being refused

### Requirement: The MCP endpoint MUST support path-based project scoping

The server SHALL accept MCP requests at `/mcp` (global) and at `/mcp/<project-slug>` (project-scoped). When the path includes a non-empty slug after `/mcp/`, the server SHALL resolve that slug to a project via `projects.findBySlug(slug)` and SHALL use the resulting project as the request's project scope. Resolution SHALL NOT create a project: auto-create on read is forbidden by the `projects` capability, and creating a project row at the authentication layer would let any token holding `*` mint arbitrary projects by requesting arbitrary URLs, before any write authorization has been checked.

When `findBySlug` returns nothing, the `initialize` handshake SHALL still succeed and the connection SHALL be treated as path-scoped to a project that does not exist — refused per the strict-isolation requirement, never resolved to the global scope.

The `X-Rembric-Project` header SHALL NOT be consulted in scope resolution (see the `projects` capability); the path slug is the only connection-level mechanism.

#### Scenario: Connecting at a project-scoped path

- **WHEN** an MCP client connects to `/mcp/my-app` with a valid token and a project with slug `my-app` exists
- **THEN** the server SHALL resolve `my-app` to that existing project row, SHALL NOT insert a row, and every tool call in that session SHALL be scoped to it

#### Scenario: Path slug names no project

- **WHEN** an MCP client connects to `/mcp/my-app` with a valid token and no project has slug `my-app`
- **THEN** `initialize` SHALL succeed, no project row SHALL be inserted, and every subsequent tool call that resolves scope SHALL be refused with `code: 'project_not_found'`

#### Scenario: Path slug and conflicting header

- **GIVEN** a client connecting to `/mcp/foo` while also sending `X-Rembric-Project: bar`
- **WHEN** the server processes the request
- **THEN** the project SHALL resolve to `foo` (the path wins); the header SHALL be ignored

#### Scenario: Global connection

- **WHEN** an MCP client connects to `/mcp` without a slug
- **THEN** the request SHALL be accepted without a project scope; tools that require a project (e.g. `memory.save` with `scope='project'`) SHALL respond with a structured error code `project_required` whose message instructs the caller to reconnect at `/mcp/<slug>`, to call `project.use({slug})`, or to save as `scope='global'` instead

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

The `memory.search` response SHALL include a `relations` array on each result row, populated in a single JOIN over `memory_relations`. Annotation kinds: `supersedes`, `superseded_by`, `conflicts_with`, `related`, `compatible`, `scoped`, `pending_conflict`. Each annotation SHALL include the target id and the annotation kind; a judged annotation SHALL additionally carry the judgment's `reason` and `confidence`, and a pending annotation its `judgmentId`. An annotation SHALL NOT carry a snippet of the target's content — no read has ever projected one, and the earlier wording claiming otherwise described a field that does not exist. On the multi-row surfaces the `reason` is bounded (see "Relation annotation reasons MUST be bounded on multi-row reads").

Each result row SHALL additionally carry the derived review metadata for the memory (see the `memory` capability): `reviewState` (`'fresh'` | `'needs_review'`) for `active` rows, and `reviewAfter` when non-null. These fields are informational metadata only — they SHALL NOT change result ordering, scope isolation, or which rows are returned. Rows that are not `active` SHALL omit `reviewState`.

`memory.search` SHALL accept two OPTIONAL projection parameters that shape the returned rows WITHOUT changing which rows are returned or their order: `snippet` (a positive integer) and `fields` (a list of row field names). When `snippet` is supplied, each returned row's `content` SHALL be truncated to at most that many characters using the same truncation semantics as `memory.context` (the snippet helper: slice and append an ellipsis when the content exceeds the cap). When `fields` is supplied, the response SHALL return only the named fields PLUS the always-present identity fields `id`, `type`, and `title` (so every projected row remains identifiable). The two parameters compose: requesting `content` in `fields` together with a `snippet` cap yields a truncated `content`. When NEITHER `snippet` NOR `fields` is supplied, the response SHALL be the unchanged full-content row shape (byte-for-byte back-compatible). Projection SHALL be applied AFTER selection, ranking and scope enforcement — it SHALL NOT alter any of them. Projection touches no timestamp, and neither does the search it projects: `memory.search` advances `last_seen_at` for no row (see the `memory` capability, "Being returned by a search MUST NOT be sufficient to confer durability").

#### Scenario: A search result row reports its relations

- **WHEN** `memory.search` returns memory N which has a judged `supersedes` relation to memory M and a pending relation to memory Q
- **THEN** the result row SHALL include `relations: [{ kind: 'supersedes', targetId: 'M', status: 'judged', reason, confidence }, { kind: 'pending_conflict', targetId: 'Q', status: 'pending', judgmentId }]`

#### Scenario: The annotation set respects the cap

- **GIVEN** memory N has 25 rows in `memory_relations`
- **WHEN** the cap is 10
- **THEN** the response SHALL include the 10 highest-precedence annotations under the ordering the `memory` capability requires (kind tier, then recency, then `judgment_id`) — NOT merely the 10 most recent; the rest are accessible via the dashboard

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

### Requirement: An abstaining search response MUST tell the agent not to invent context

When the text-query branch abstains, the response SHALL carry an explicit flag and a reason, and the tool description SHALL instruct the agent that an abstaining response means no relevant memory exists — not that it should proceed on assumption. An empty result that the model interprets as "search is broken" or fills in from its own priors is worse than a populated one.

Abstention has two causes (see the `memory` capability, "Recall MUST be able to return nothing") and the response SHALL distinguish them: the reason accompanying an abstention caused by an empty fused pool SHALL differ from the reason accompanying the relevance floor's verdict. A single reason string covering both would attribute the verdict to whichever mechanism the string happens to name, and on the shipped configuration that is a mechanism that never ran.

A response that returns no results SHALL NOT be treated as sufficient evidence of abstention, and no tool description SHALL teach that equivalence. An `offset` past the end of a non-empty pool returns an empty page with `abstained: false`, and that is specified behaviour rather than an inconsistency.

Because a page may be shortened by the enabled relevance filter rather than exhausted by the corpus, and because those two states are otherwise byte-identical in the response, `memory.search` SHALL carry an additional flag — `gateShortened` — under the exact condition the `memory` capability defines for it. It SHALL be declared in the tool's `outputSchema` as an OPTIONAL literal `true` rather than an optional boolean, SHALL be present and `true` only when that condition holds, and SHALL be OMITTED otherwise rather than emitted as `false`, matching the existing conditional fields on the same response (`abstainReason`, `viaEntity`, `entityIndexDraining`). The literal form makes the omit-rather-than-`false` rule self-enforcing rather than merely documented: emitting `false` fails the declared output schema and the call is rejected (`-32602`, `Invalid literal value, expected true`) instead of a silently wrong payload reaching the agent. Being additive and optional, it SHALL NOT change the `text` content block's meaning for a client that ignores it, and SHALL NOT be required by any existing client.

The `memory.search` description SHALL state what an abstaining response means and what the shortening flag means, in terms of the OBSERVABLE outcome rather than by naming the mechanism that produced it, so that the description stays true when a gate's enabled state changes. In particular, while the abstention floor is disabled the description SHALL NOT attribute abstention to that floor. This content obligation is bounded by "Tool descriptions MUST stay below the client truncation ceiling" and SHALL be satisfied within the existing cap by replacing text rather than appending it; the cap SHALL NOT be raised to accommodate it.

#### Scenario: An abstaining response is distinguishable from an error

- **WHEN** `memory.search` abstains
- **THEN** the call SHALL succeed with an explicit abstention flag and reason, and SHALL NOT return an error code

#### Scenario: The two abstention causes carry different reasons

- **WHEN** `memory.search` abstains because the fused pool was empty, and the same tool abstains because no pool row reached the floor
- **THEN** the two responses SHALL carry different reason strings, and the floor's string SHALL be unchanged from the one already shipped

#### Scenario: A gate-shortened page is marked as such over the MCP boundary

- **GIVEN** a scope in which the relevance filter removes candidates from the fused pool for a given query
- **WHEN** an MCP client calls `memory.search` with a `limit` larger than the number of surviving rows
- **THEN** the response SHALL carry `gateShortened: true` alongside `abstained: false`
- **AND** an `offset` past the surviving rows but still inside the fused pool SHALL also carry `gateShortened: true` — without the gate that page would have held rows, so the gate is why it ran out
- **AND** an `offset` at or past the end of the fused pool SHALL carry `abstained: false` and NO `gateShortened` field — that page is empty because the caller paged past every candidate, gate or no gate, and the flag would promise a recovery that paging cannot deliver

#### Scenario: The shortening flag is absent rather than false

- **WHEN** `memory.search` returns a page the relevance filter did not shorten
- **THEN** the response object SHALL NOT contain a `gateShortened` key
- **AND** the response SHALL still validate against the tool's declared `outputSchema`
- **AND** this SHALL hold for an `offset` past the end of a non-empty pool the filter removed nothing from — an empty page whose cause is the offset, not the gate, is the control that keeps the flag's two conjuncts honest

#### Scenario: The description steers against confabulation

- **WHEN** the `memory.search` tool description is inspected
- **THEN** it SHALL state that an abstaining response means no relevant memory exists and that the agent SHALL NOT substitute assumed context

#### Scenario: The description does not name a disabled mechanism

- **GIVEN** the abstention floor ships disabled
- **WHEN** a CI test inspects the `memory.search` description obtained from a real `tools/list` response
- **THEN** the description SHALL NOT attribute abstention to the relevance floor
- **AND** the test SHALL fail if that attribution is reintroduced

### Requirement: The `memory.get` tool MUST return the memory and its history

`memory.get` SHALL accept an `id` and SHALL return the memory's content, status, scope, project, tags, `topicKey`, `replaces`, a bounded predecessor projection derived from `replaces`, and the affirming-confirmation count for the current head. The predecessor projection is bounded and content-free — see the `memory` capability, "Supersedes-chain reads MUST be bounded and content-free"; the response SHALL carry `predecessorCount` and `truncated` so a caller can tell that more ancestry exists. The memory row SHALL NOT expose the internal `source` provenance blob (token name, agent, model), which is operator data surfaced on the dashboard and never returned to an agent.

For an `active` memory, the response SHALL additionally include the derived review metadata (see the `memory` capability): `reviewState` (`'fresh'` | `'needs_review'`), `reviewAfter` when non-null, and `reviewEscalated`. For non-`active` memories these fields SHALL be omitted.

`memory.get` SHALL additionally accept an OPTIONAL `ids` array as a back-compatible batch form. Exactly one of `id` or `ids` SHALL be supplied; supplying both, or neither, SHALL be an `invalid_input` error. When `id` is supplied, the response shape SHALL be unchanged from the single-memory form above. When `ids` is supplied, the response SHALL contain an ordered `memories` array — one per id that resolves to an in-scope, token-authorized memory, in the same order the ids were requested, each entry carrying the per-memory shape enumerated below — plus a `notFound` array listing the requested ids that did not resolve. The batch form SHALL be scope-enforced via a scoped service read: an id outside the connection's effective scope SHALL be reported in `notFound` and SHALL NOT leak the memory's content or existence, identically to how the single-`id` form treats an out-of-scope id as not found. The `ids` array SHALL be bounded by a maximum length; a request exceeding it SHALL be an `invalid_input` error.

A batch entry SHALL carry: the memory's own columns (`id`, `scope`, `projectId`, `type`, `title`, `content`, `tags`, `status`, `replaces`, `createdAt`, `topicKey`), `lastSeenAt`, the bounded `relations`/`relationsTotal` projection, the bounded `entities`/`entitiesTotal` projection, and the derived review metadata (`reviewState`, `reviewAfter`, `reviewEscalated`) on exactly the same terms as the single-`id` form — present for an `active` memory, omitted otherwise. The review metadata SHALL be derived in ONE batched lookup for the whole page rather than per row, matching how the search surface already derives it; a batch read SHALL NOT omit it, because `memory.context.needsReview` hands the agent a list of ids and the taught follow-up is a batch read, so an omission there tells the agent that nothing needs review.

The two forms differ deliberately in the following respects, and ONLY these. Each difference SHALL be enumerated here rather than implied by a parity claim, because a claim of identical shape that the payloads do not honour is undetectable by any scenario written against it:

- The single-`id` form dereferences ONE memory and advances its access signal, while the batch form is a pure read and advances nothing, so a bulk pull cannot reshuffle decay eligibility or context recency for every id it names (see the `memory` capability, "A dereferenced memory is treated as accessed").
- The single-`id` form carries the ancestry projection — `head`, `predecessors`, `predecessorCount`, `truncated`, `headTruncated` — and `confirmationCount`; the batch form SHALL NOT. Those are per-target walks, and performing one per id would turn a bulk read into N ancestry queries. A caller needing history for a specific row SHALL use the single-`id` form, and the `memory.get` description SHALL NOT promise ancestry on the batch form.
- `lastSeenAt` is carried by the batch form only. The single-`id` form advances the very signal it would be reporting, so the value it could return is the timestamp its own call just wrote — tautological rather than informative.

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
- **THEN** the response SHALL include `memories` ordered `[M2, M1, M3]`, each carrying the enumerated batch per-memory shape, and `notFound: []`

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

#### Scenario: The batch form carries the review metadata, verified against the single form

- **GIVEN** one `active` in-scope memory M whose derived `reviewState` is `'needs_review'`
- **WHEN** an authenticated client calls `memory.get({ id: 'M' })` and `memory.get({ ids: ['M'] })` on the same connection, adjacent in time
- **THEN** both responses SHALL carry `reviewState`, `reviewAfter` and `reviewEscalated` for M, with equal values
- **AND** a `superseded` or `archived` id in the same batch SHALL carry none of the three, so the omission remains status-driven rather than form-driven
- **AND** the two calls SHALL be the control for each other: a test asserting only the batch form cannot distinguish a correct batch from a scope in which no row needs review

#### Scenario: The batch form carries `replaces`

- **GIVEN** an in-scope memory M that superseded a predecessor, so `M.replaces` is non-empty
- **WHEN** an authenticated client calls `memory.get({ ids: ['M'] })`
- **THEN** the entry for M SHALL carry `replaces` with the same value the single-`id` form returns for M
- **AND** the entry SHALL NOT carry `head`, `predecessors`, `predecessorCount`, `truncated`, `headTruncated` or `confirmationCount` — `replaces` is a column on the row, the ancestry projection is a walk

#### Scenario: `lastSeenAt` is a deliberate asymmetry, not a drift

- **WHEN** an authenticated client calls `memory.get({ ids: ['M'] })` and `memory.get({ id: 'M' })`
- **THEN** the batch entry SHALL carry `lastSeenAt` and the single-`id` response SHALL NOT
- **AND** the single-`id` call SHALL still advance M's access signal, which is why it does not report it

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

### Requirement: The MCP server MUST expose a `memory.archive` tool

The server SHALL register an MCP tool `memory.archive` that retires a single memory by flipping its `status` from `active` to `archived`. The tool SHALL accept `{ id: string }` (validated by zod; non-empty) and SHALL NOT accept a `scope` argument. It SHALL resolve the effective scope exactly like the other single-memory tools (`memory.get`/`memory.confirm`, via `resolveEffectiveScope`) and delegate to `MemoryService.archive(id, scope)`, so archiving is confined to the connection's one effective scope: a `/mcp/<slug>` connection archives in that project's scope; a `/mcp` connection archives in the routed project (via `project.use`) or global scope.

A cross-scope or unknown `id` SHALL return the same `not_found`-class error as `memory.get`/`memory.confirm` — there is no cross-scope or cross-project archive path. Archiving a non-`active` memory SHALL return a `conflict`-class error. The tool SHALL NOT delete rows, drop vectors, or expose any purge capability; physical deletion remains operator/admin-only.

#### Scenario: Archiving an active memory in scope succeeds

- **GIVEN** a `/mcp/<slug>` connection scoped to project `P` and an `active` memory `M` in project `P`
- **WHEN** an MCP client calls `memory.archive` with `{ id: 'M' }`
- **THEN** the server SHALL flip `M.status` to `archived` in project `P`
- **AND** the response SHALL confirm the archive (e.g. the archived id and its new status)

#### Scenario: Archiving a memory outside the connection's scope is not found

- **GIVEN** a `/mcp/<slug>` connection scoped to project `P` and an `active` memory `X` in a different project `Q`
- **WHEN** an MCP client calls `memory.archive` with `{ id: 'X' }`
- **THEN** the server SHALL return a `not_found`-class error and SHALL NOT change `X.status`

#### Scenario: Archiving a non-active memory conflicts

- **WHEN** an MCP client calls `memory.archive` for a memory whose `status` is `superseded` or `archived`
- **THEN** the server SHALL return a `conflict`-class error and SHALL NOT change the memory's status

### Requirement: The `memory.archive` description MUST steer against autonomous retirement

Because `memory.archive` gives the model an unlinked retirement verb, its tool description is load-bearing and SHALL constrain when the model uses it. The description SHALL instruct the model to call `memory.archive` ONLY when the user has explicitly asked to retire, remove, or forget a specific memory (including the archive-back half of a user-requested cross-project move: `memory.save` into the destination followed by `memory.archive` of the original). The description SHALL instruct the model to PREFER a `topic_key` upsert or a `memory.judge` supersede whenever a replacement memory exists, because those keep a successor link, and SHALL state that archive is the no-successor path. The description SHALL forbid archiving as autonomous housekeeping during normal recall or save, and SHALL note that archiving is reversible from the operator dashboard. These constraints SHALL NOT be expressed only in the per-argument zod `describe()` (which some clients do not surface to the model) but in the tool's top-level description text.

#### Scenario: The description carries the explicit-request guard

- **WHEN** an MCP client retrieves the tool description for `memory.archive` via `tools/list`
- **THEN** the description SHALL convey that the tool is called ONLY at the user's explicit request to retire/remove/forget a memory
- **AND** the description SHALL convey that a `topic_key`/`memory.judge` supersede is preferred when a replacement exists (archive being the no-successor path)
- **AND** the description SHALL convey that the model MUST NOT archive as autonomous cleanup during recall or save
- **AND** the description SHALL convey that the action is reversible from the operator dashboard

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

The `memory.search` description SHALL additionally name the shortening flag and say what a short page does and does not imply: that the corpus is not necessarily exhausted. Ranked retrieval returns the best available rows whether or not any of them is relevant, so the description SHALL also state that a full page is not evidence that its rows are relevant. That sentence is the only mitigation available at the description layer for a ranked branch with no absolute relevance threshold, and it is required for the same reason the anti-confabulation instruction is.

Every content obligation in this requirement SHALL be satisfied within `DESCRIPTION_MAX_LENGTH`. Where a new obligation cannot fit, text SHALL be reclaimed from clauses no requirement mandates, and the reclaimed clause SHALL be named in the change that removes it — not appended past the cap, and not paid for by raising the cap.

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

#### Scenario: `memory.search` description explains a short page and a full one

- **WHEN** an MCP client retrieves the tool description for `memory.search`
- **THEN** the description SHALL name the shortening flag, SHALL state that a short page does not mean the corpus is exhausted, and SHALL state that a full page is not proof that its rows are relevant

#### Scenario: A reworded description is still within the cap

- **WHEN** the `memory.search` description is changed to satisfy a new content obligation
- **THEN** its `String.length` measured from a real `tools/list` response SHALL remain at or below `DESCRIPTION_MAX_LENGTH`, and the change SHALL record the measured length and the remaining headroom

#### Scenario: An accidental edit removes the protocol-teaching phrase

- **WHEN** a developer rewrites a tool description in a way that removes the `Call this …` trigger
- **THEN** a CI test SHALL fail asserting the presence of the trigger phrase, and the build SHALL be rejected

### Requirement: The MCP server MUST expose three session-lifecycle tools

The `/mcp` and `/mcp/<slug>` endpoints SHALL register the tools `memory.session_start`, `memory.session_end`, and `memory.session_summary` with the following contracts. The tools are split by responsibility: `memory.session_start` opens a session, `memory.session_summary` writes summary/title without transitioning, `memory.session_end` is the sole state transition. This is a behaviour change from the prior contract where `memory.session_summary` ended the session as a side effect.

`memory.session_start` SHALL NOT always insert a row. When an `active` session already exists for the caller's `(tokenId, projectId)` on this transport — the ordinary case, because every supported host registers the session over HTTP before the agent runs — the call SHALL adopt that row instead of minting a second one, and SHALL report which of the two happened in a REQUIRED `reused` field: `true` when an existing row was adopted, `false` when a row was inserted. `reused` is the only signal distinguishing "you are now attached to the host's session" from "you just created a parallel session", which is the question a defensive `memory.session_start` call is asking. Its `outputSchema` SHALL mark it required, and the tool's description SHALL name it and state what `true` means (see "A tool's description and its response MUST agree, and neither may promise an unreachable state"): a required field the description omits from a closed-form `Returns: { … }` list is undocumented surface on the one channel the model reads.

`memory.session_summary` SHALL validate `summary` against the single canonical cap exported from `apps/server/src/services/agent-sessions.ts` (`SUMMARY_MAX_CHARS`, currently `10000`). The MCP zod schema SHALL be `summary: z.string().min(1).max(SUMMARY_MAX_CHARS)` so overflow is rejected at the transport boundary with `invalid_input` before the tool body runs. The rejected agent SHALL receive an error whose message contains the decimal string of `SUMMARY_MAX_CHARS` so it can retry with a tighter body on the first attempt.

`memory.session_summary` and `memory.session_end` SHALL NOT reject a call because the resolved row is in a terminal state. `memory.session_summary` SHALL apply its summary/title write subject to the `final` precedence rules regardless of `status`; `memory.session_end` takes no summary/title arguments, so on a terminal row it SHALL be a pure no-op returning the existing `ended_at`. Neither SHALL mutate `status`, `ended_at` or `last_activity_at` on a terminal row — see the `sessions` capability, "Terminal session rows MUST accept late summary and title writes". `session_already_ended` SHALL NOT be a possible error code for either tool. This matters because the plugin's `PreCompact`, `SessionStart:compact` and `Stop` nudges instruct the agent to call `memory.session_summary`, and the stale-active retirement sweep can have flipped the row to `abandoned` (the documented steady state for two of the four clients) before the agent gets there.

`memory.session_end` clears the `SessionRouter` transport binding for `(tokenId, mcpSessionId)` ONLY when the row it resolved is not `abandoned`. Before terminal writes were admitted, `end()` threw on an `abandoned` row and the clear was unreachable, so the binding survived; clearing it now would drop every later `memory.save` on that transport to `session_id = NULL`. That prior behaviour SHALL be preserved: ending an `abandoned` row SHALL leave the binding intact, ending an `active` or `ended` row SHALL clear it.

Session resolution is unchanged and SHALL remain status-aware where it already is: `memory.session_summary` resolves its target from an explicit `sessionId`, else the transport's `SessionRouter` entry, else the unambiguous `active` session for the caller's `(token_id, project_id)`. The third source SHALL continue to consider only `active` rows, so an agent that supplies neither an explicit id nor a router-mapped session SHALL receive `session_not_found` rather than having its write attached to a closed session picked by recency.

#### Scenario: `memory.session_start` opens a new session

- **WHEN** an MCP client calls `memory.session_start` with `{ agent?: string, description?: string }`
- **THEN** the server SHALL insert a `sessions` row with `status = 'active'`, `started_at = now`, the provided `agent` (or `'unknown'`), `token_id` from the request context, `project_id` from the request scope, and a placeholder `title` of the form `basename(cwd) · HH:MM UTC` with `title_final = false`; **AND** the response SHALL be `{ sessionId, scope, projectId, startedAt, title, reused }`

#### Scenario: `memory.session_end` ends a session without summary

- **WHEN** an MCP client calls `memory.session_end` with `{ sessionId: string }` for an active session
- **THEN** the server SHALL set `status = 'ended'` and `ended_at = now` on that row, leave `summary` and `title` unchanged, and SHALL return `{ ok: true, endedAt }`

#### Scenario: `memory.session_end` is idempotent on already-ended sessions

- **WHEN** an MCP client calls `memory.session_end` on a row whose `status` is already `'ended'`
- **THEN** the server SHALL return `{ ok: true, endedAt }` with the existing `ended_at` and SHALL NOT mutate the row

#### Scenario: `memory.session_end` is idempotent on abandoned sessions

- **WHEN** an MCP client calls `memory.session_end` on a row whose `status` is `'abandoned'` with `ended_at = E`
- **THEN** the server SHALL return `{ ok: true, endedAt: E }`, SHALL leave `status = 'abandoned'` and `ended_at = E` untouched, and SHALL NOT return `session_already_ended`
- **AND** the `SessionRouter` binding for the calling transport SHALL remain pointing at that session, so a subsequent `memory.save` on the same transport still auto-attaches its `session_id`

#### Scenario: `memory.session_end` on an active session clears the transport binding

- **WHEN** an MCP client calls `memory.session_end` on an `active` row and the call transitions it to `ended`
- **THEN** the `SessionRouter` entry for `(tokenId, mcpSessionId)` SHALL be cleared, as before this requirement's revision

#### Scenario: `memory.session_summary` writes summary and title without ending the session

- **WHEN** an MCP client calls `memory.session_summary` with `{ sessionId?: string, summary: string, title?: string }` and `summary.length <= SUMMARY_MAX_CHARS`
- **THEN** the server SHALL resolve `sessionId` from the active MCP transport mapping when omitted, write `summary` with `summary_final = true`, write `title` (when provided, after validating length ≤100) with `title_final = true`, leave `status`/`ended_at` unchanged, and return `{ ok: true, sessionId, summary, title, summaryFinal: true, titleFinal: <true|false> }`

#### Scenario: `memory.session_summary` succeeds on a session the sweep already abandoned

- **GIVEN** the agent's session was flipped to `status = 'abandoned'` with `ended_at = E` and `last_activity_at = L` by stale-active retirement while the conversation was still open, and the agent knows its `sessionId` (the plugin's nudge injects it)
- **WHEN** the agent calls `memory.session_summary({ sessionId, summary, title })`
- **THEN** the call SHALL succeed and return `{ ok: true, sessionId, summary, title, summaryFinal: true, … }`
- **AND** the row SHALL retain `status = 'abandoned'`, `ended_at = E` and `last_activity_at = L`
- **AND** the call SHALL NOT return `session_already_ended`

#### Scenario: `memory.session_summary` succeeds on an ended session

- **GIVEN** a row whose `status = 'ended'` with `ended_at = E`
- **WHEN** the agent calls `memory.session_summary({ sessionId, summary })`
- **THEN** the call SHALL succeed with `summaryFinal: true`, and `status`/`ended_at` SHALL be unchanged

#### Scenario: `memory.session_summary` with no resolvable session still reports `session_not_found`

- **GIVEN** the agent passes no explicit `sessionId`, the transport has no `SessionRouter` entry, and the only candidate row for its `(token_id, project_id)` is `abandoned`
- **WHEN** the agent calls `memory.session_summary({ summary })`
- **THEN** the call SHALL be rejected with code `session_not_found` (NOT `session_already_ended`, and NOT silently attached to the abandoned row)

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

#### Scenario: A second `memory.session_start` adopts the first session and says so

- **GIVEN** a connection with no active session for its `(tokenId, projectId)`
- **WHEN** an MCP client calls `memory.session_start` twice in a row on that connection
- **THEN** the first response SHALL carry `reused: false` and the second SHALL carry `reused: true`
- **AND** both responses SHALL carry the SAME `sessionId` — the second call SHALL NOT insert a second `sessions` row
- **AND** the `sessions` row count for that `(tokenId, projectId)` SHALL be 1 after both calls, which is the control that `reused: true` describes adoption rather than a coincidence of ids

#### Scenario: `memory.session_start`'s description names every required output field

- **WHEN** an MCP client retrieves the tool description for `memory.session_start` via `tools/list`
- **THEN** the description's `Returns:` enumeration SHALL name every field its `outputSchema` marks required, including `title` and `reused`
- **AND** the description SHALL state that `reused: true` means the call adopted the host's already-active session rather than starting one
- **AND** a CI test SHALL compare the description against the `outputSchema`'s required list, so a field added to the schema without a description update fails the build

### Requirement: The MCP server MUST expose three research tools

The `/mcp` and `/mcp/<slug>` endpoints SHALL register `memory.context`, `memory.timeline`, and `memory.capture_passive` with the following contracts. Note that `memory.save_prompt` (write side) and `memory.search_prompts` (read side) are registered in their own dedicated requirements; this requirement scopes the research/context tools only.

Both of `memory.context`'s queue channels SHALL be returned with the scoped TOTAL of the queue they page, because a page whose depth is invisible cannot be told from an exhausted queue. `needsReview` has carried `needsReviewTotal` since it was introduced; `pendingJudgments` SHALL carry `pendingJudgmentsTotal` on the same terms.

Both of those pending channels SHALL be restricted to ADJUDICABLE pairs — a pending relation whose source AND target are both `status = 'active'` (see the `memory` capability, "A pending judgment MUST be withheld from the agent queue once either endpoint is retired"). The list and the total SHALL apply that restriction identically, so the total remains the depth of the queue the list pages rather than a depth the list can never reach.

`memory.context`'s four size arguments are bounded by its declared input schema — `sessions` 25, `prompts` 50, `memories` 100, `judgments` 50 — and a value above a maximum SHALL be REJECTED as an invalid argument rather than silently clamped, consistent with every other numeric bound on this surface (see "`memory.search` and `memory.get` MUST expose the annotation bound and its true total"). Because no clamping can occur over the transport, the response SHALL NOT carry a field reporting that an argument was clamped (see "A tool's description and its response MUST agree, and neither may promise an unreachable state"). The handler MAY retain an in-process clamp as a defensive bound for a future direct caller that bypasses the input schema; such a clamp is unobservable over the transport and SHALL NOT be reported in the response.

#### Scenario: `memory.context` returns a bootstrap snapshot

- **WHEN** an MCP client calls `memory.context` with `{ sessions?: number, prompts?: number, memories?: number, judgments?: number, includeArchived?: boolean }`
- **THEN** the server SHALL return `{ scope, recentSessions, recentPrompts, recentMemories, relevantMemories, pendingJudgments, pendingJudgmentsTotal, needsReview, needsReviewTotal }` — where `scope` is the resolved scope label, as on `memory.stats` — plus `rankedPass` when the ranked pass executed (see "`memory.context` MUST offer a relevance channel alongside recency"), with each list scoped to the request context (global vs path-scoped project)
- **AND** when a size argument is omitted the default SHALL be `sessions = 3`, `memories = 10`, `prompts = 5`, `judgments = 5` (kept small because the snapshot is read every session start; callers needing more pass explicit args, still bounded by the maxima below)
- **AND** `recentSessions` SHALL contain only sessions that satisfy the `sessionHasContent` predicate (see `sessions` capability), ordered by `started_at DESC`, with empty sessions filtered out BEFORE truncation to `sessions ?? 3`
- **AND** `recentPrompts` SHALL be ordered by `created_at DESC` and filtered to `deleted_at IS NULL`
- **AND** `recentMemories` SHALL be ordered by `COALESCE(last_seen_at, created_at) DESC` — activity recency, falling back to creation for a row never dereferenced, which is most rows given that search does not touch — with `includeArchived = false` (default) filtering out `status = 'archived'` rows
- **AND** `pendingJudgments` SHALL contain at most `judgments ?? 5` adjudicable pending relations in scope — both endpoints `status = 'active'` — oldest first, each entry carrying `{ judgmentId, sourceId, targetId, sourceSnippet, targetSnippet, ageMs }` so the agent can close them with `memory.judge` without further reads; when `judgments` is OMITTED the list SHALL be further filtered to `created_at < (now - JUDGMENT_ORPHAN_AFTER_MS)`, and when `judgments` is PRESENT that age filter SHALL NOT be applied
- **AND** `pendingJudgmentsTotal` SHALL be the count of every adjudicable pending relation in scope — un-aged ones included, and independent of `judgments` — never the returned list's length, which is the page size and therefore exactly the misleading number the field exists to correct. A pending relation excluded from the list because an endpoint is retired SHALL be excluded from the total on the same terms; the age filter is the ONLY divergence permitted between the two
- **AND** `needsReview` SHALL contain at most 3 `active` in-scope memories whose derived `reviewState = 'needs_review'` (see the `memory` capability), ordered recently-refuted first and then oldest `reviewBaseline` first (see the `memory` capability, "A refutation MUST lead the review queue only while it is recent"), each entry carrying `{ id, type, snippet, reviewAfter, ageMs }` (where `snippet` uses the same per-row cap as the other context lists, `ageMs = now - reviewBaseline` the time since last affirmation) so the agent can re-affirm with `memory.confirm`, supersede with `memory.save` + `topic_key`, or — when it contradicts another memory — fall through to the existing `memory.judge` flow. The list is kept small by COUNT (only the 3 oldest) because it is recurring (every `memory.context`) and usually populated

#### Scenario: `pendingJudgmentsTotal` reports the queue, not the page

- **GIVEN** a scope holding more aged pending relations with two `active` endpoints than the default page size
- **WHEN** an MCP client calls `memory.context` with no `judgments` argument
- **THEN** `pendingJudgments` SHALL hold 5 entries and `pendingJudgmentsTotal` SHALL be the full in-scope ADJUDICABLE pending count, strictly greater than 5

#### Scenario: `pendingJudgmentsTotal` counts the un-aged pairs the default list hides

- **GIVEN** one aged pending relation and two pending relations younger than `JUDGMENT_ORPHAN_AFTER_MS`, all in scope
- **WHEN** an MCP client calls `memory.context` with no `judgments` argument
- **THEN** `pendingJudgments` SHALL hold only the aged entry and `pendingJudgmentsTotal` SHALL be 3 — the total is a queue depth, not a description of the list beside it

#### Scenario: `pendingJudgmentsTotal` respects scope

- **GIVEN** a pending relation whose memories belong to project B
- **WHEN** an MCP client scoped to project A (or the global endpoint) calls `memory.context`
- **THEN** `pendingJudgmentsTotal` SHALL NOT count it

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
- **AND** the response SHALL contain no clamp-reporting field — the defaults are inside every maximum, and no admissible argument value can produce clamping

#### Scenario: `memory.context.recentSessions` backfills past empty sessions

- **GIVEN** the active scope contains, in `started_at` order from newest to oldest, three empty sessions and one useful session
- **WHEN** an MCP client calls `memory.context({sessions: 1})`
- **THEN** the response's `recentSessions` array SHALL have length 1 and SHALL contain only the useful session — the three newer empty sessions SHALL NOT consume the slot

#### Scenario: `memory.context.recentSessions` excludes soft-deleted sessions

- **GIVEN** a session that has content AND is soft-deleted (`deleted_at IS NOT NULL`)
- **WHEN** an MCP client calls `memory.context`
- **THEN** the row SHALL NOT appear in `recentSessions` — the soft-delete filter and the content filter both apply

#### Scenario: `memory.context` arguments exceed clamps

The title predates the behaviour: nothing is clamped, and the scenario pins the rejection that happens instead.

- **WHEN** the caller passes `sessions: 26`, `prompts: 51`, `memories: 101`, or `judgments: 51`, each in its own call
- **THEN** each call SHALL be rejected as an invalid argument and SHALL NOT return a context payload
- **AND** the same argument AT its maximum — `sessions: 25`, `prompts: 50`, `memories: 100`, `judgments: 50` — SHALL succeed, which is the control that distinguishes a real rejection from a broken probe
- **AND** all four arguments SHALL be bounded on identical terms; `judgments` SHALL NOT introduce a different layering from its three siblings
- **AND** a `judgments` value at or below 50 that exceeds the number of pending relations in scope SHALL return every one that exists — asking for more than the queue holds is not an error
- **AND** no response SHALL carry a field reporting that any argument was clamped

#### Scenario: `memory.context` excludes soft-deleted prompts

- **GIVEN** prompts P1 and P2 in scope where `P2.deleted_at IS NOT NULL`
- **WHEN** an MCP client calls `memory.context`
- **THEN** `recentPrompts` SHALL include `P1` and SHALL NOT include `P2`

#### Scenario: `memory.context` exposes only aged pendings by default, never fresh ones

- **GIVEN** a pending relation younger than `JUDGMENT_ORPHAN_AFTER_MS` and another older than it, both in scope
- **WHEN** an MCP client calls `memory.context` with no `judgments` argument
- **THEN** `pendingJudgments` SHALL include only the aged one — fresh pendings belong to the session that created them, and the default channel is a queue-depth warning rather than an inventory

#### Scenario: An explicit `judgments` size lifts the age filter

- **GIVEN** the same pair of pending relations, one aged and one fresh
- **WHEN** an MCP client calls `memory.context` with `{ judgments: 10 }`
- **THEN** `pendingJudgments` SHALL include BOTH, oldest first — asking for a size is the caller asking for inventory, and inventory that hides most of itself is not inventory
- **AND** the un-aged entry SHALL carry the same `{ judgmentId, sourceId, targetId, sourceTitle, targetTitle, sourceSnippet, targetSnippet, ageMs }` shape as an aged one, so it can be judged straight from the response
- **AND** no separate `includeUnaged` argument SHALL exist: a size present or absent is the only knob, so the fourth combination (unaged without a bound) is unreachable by construction

#### Scenario: An un-aged pending pair is reachable at all

- **GIVEN** a pending relation created moments ago, whose originating `memory.save` response is no longer available to the caller
- **WHEN** an MCP client calls `memory.context` with a `judgments` size
- **THEN** the pair's `judgmentId` SHALL be returned, so `memory.judge` can close it — without this the pair is unreachable from every MCP surface until `JUDGMENT_ORPHAN_AFTER_MS` elapses, since `memory.judge` accepts only a `judgmentId` and `memory.compare` requires both memory ids up front and so cannot discover a pair

#### Scenario: `memory.context.pendingJudgments` respects scope

- **GIVEN** an aged pending relation whose memories belong to project B
- **WHEN** an MCP client scoped to project A calls `memory.context`
- **THEN** `pendingJudgments` SHALL NOT include it, with or without a `judgments` size

#### Scenario: A `topic_key` revision does not evict the live pending from the page

- **GIVEN** memory A saved with `topic_key = 't'` carrying five aged pending relations, then memory B saved with the same `topic_key` (so A becomes `superseded` and B is `active`), carrying one aged pending relation that is newer than all five
- **WHEN** an MCP client calls `memory.context` with no `judgments` argument
- **THEN** `pendingJudgments` SHALL hold exactly the one pair whose source is B, and `pendingJudgmentsTotal` SHALL be 1 — A's five pairs SHALL neither appear on the page nor raise the total, even though they are the five oldest rows and the page holds five entries

#### Scenario: A retired target is withheld on the same terms as a retired source

- **GIVEN** an aged pending relation whose source is `active` and whose target has been archived
- **WHEN** an MCP client calls `memory.context`
- **THEN** the pair SHALL NOT appear in `pendingJudgments` and SHALL NOT be counted in `pendingJudgmentsTotal`

#### Scenario: An explicit `judgments` size does not readmit retired pairs

- **GIVEN** one adjudicable pending relation and three pending relations with a retired endpoint, all in scope, all created moments ago
- **WHEN** an MCP client calls `memory.context` with `{ judgments: 50 }`
- **THEN** `pendingJudgments` SHALL hold exactly the adjudicable pair and `pendingJudgmentsTotal` SHALL be 1 — a size argument lifts the AGE filter only, so an inventory request cannot surface a pair the default channel withholds for a different reason

#### Scenario: `memory.context`'s description advertises the total and the size

- **WHEN** an MCP client retrieves the tool description for `memory.context` via `tools/list`
- **THEN** the description SHALL name `pendingJudgmentsTotal` and the `judgments` argument, and SHALL state that passing a size lifts the age filter — a caller cannot guess that a size argument changes which rows qualify
- **AND** the description SHALL name the maximum of EACH of the four size arguments — `sessions` 25, `prompts` 50, `memories` 100, `judgments` 50 — and SHALL state that a value above a maximum is rejected rather than clamped. Declaring a maximum only as an input-schema `maximum` keyword SHALL NOT satisfy this clause, since some clients do not surface per-property schema descriptions to the model, leaving the tool rejecting a bound it never taught
- **AND** the description SHALL NOT state that the response carries a flag reporting a clamp
- **AND** the description SHALL satisfy `DESCRIPTION_MAX_LENGTH` (see "Tool descriptions MUST stay below the client truncation ceiling"); if the clause does not fit, prose SHALL be cut from the description rather than the constant raised

#### Scenario: `memory.timeline` returns chronological neighbors within a session

- **WHEN** an MCP client calls `memory.timeline` with `{ memoryId, before?: 5, after?: 5 }` and the target memory has a non-null `session_id`
- **THEN** the server SHALL return up to `before` memories with `created_at < target.created_at` and `session_id = target.session_id`, plus up to `after` memories with `created_at > target.created_at` and `session_id = target.session_id`, ordered chronologically

#### Scenario: `memory.timeline` falls back when the target has no session

- **WHEN** the target memory has `session_id = NULL`
- **THEN** the server SHALL return neighbors selected by `created_at` within ±2 hours of the target's `created_at`, scoped to the same `(scope, project_id)`, and the response SHALL include `fallback: 'time_window'`

#### Scenario: `memory.timeline`'s description names its arguments and its bound

- **WHEN** an MCP client retrieves the tool description for `memory.timeline` via `tools/list`
- **THEN** the description SHALL name the `before` and `after` arguments and their defaults, SHALL state that their SUM may not exceed the combined maximum, and SHALL state that a larger window is rejected rather than clamped
- **AND** it SHALL name the remedy the handler's own error message already names — a wider window is served by `memory.search` — so the description and the error agree
- **AND** a tool whose handler rejects a bound its description never mentions SHALL be treated as a defect (see "A tool's description and its response MUST agree, and neither may promise an unreachable state")

#### Scenario: `memory.timeline` combined window exceeds 50

- **WHEN** `before + after > 50`
- **THEN** the call SHALL be rejected with code `invalid_input` and a message referring the caller to `memory.search`

#### Scenario: `memory.capture_passive` extracts numbered learnings

- **WHEN** an MCP client calls `memory.capture_passive` with `{ text: string, sessionId?: string }` and `text` contains a section starting with `^## Key Learnings:\s*$`
- **THEN** the server SHALL extract each subsequent numbered (`1.`, `2.`) or bulleted (`-`, `*`) item, save each as a separate memory with `type = 'reference'` (there is no `discovery` type) and the active scope, and SHALL return `{ saved: number, ids: string[] }` plus the aggregated `candidates[]` when the saves detected any

#### Scenario: `memory.capture_passive` finds no learnings block

- **WHEN** the input text has no matching `## Key Learnings:` heading
- **THEN** the server SHALL return `{ saved: 0, ids: [] }` with an explicit `reason` naming the expected heading form (see "`memory.capture_passive` MUST NOT report success when it extracted nothing") and SHALL NOT error

### Requirement: `memory.context` MUST offer a relevance channel alongside recency

`memory.context` is the tool the protocol directs agents to when starting or resuming work, and its recency channel is ordered by activity alone — nothing about the work at hand influences it. Recency answers "what happened lately", which is not the same question as "what bears on this task", and on a corpus spanning several projects the two answers diverge quickly.

`memory.context` SHALL accept an optional `focus` string and SHALL return a `relevantMemories[]` channel. The existing recency channel SHALL be unchanged and the two SHALL be separately labelled in the response, so the model can tell which rows were selected for relevance and which for recency.

The relevance channel is filled in two passes, in this order. First, an **entity pre-pass**: identifiers recognised in the seed text by the deterministic extractor are looked up as exact addresses, and their linked in-scope memories are admitted first, because an exact identifier match is stronger evidence than any ranked score. Second, if the channel is still under its cap, the scoped hybrid search that backs `memory.search` fills the remainder. Rows are deduped by id across both passes, and each row SHALL carry a `via` field (`'entity'` | `'ranked'`) naming the pass that found it, so the two populations stay distinguishable in the response — the same observability `memory.search`'s entity flag provides.

The ranked pass's verdict SHALL NOT be discarded. Withholding it makes an empty or short relevance channel indistinguishable from a channel the search deliberately declined to fill, which is the same defect on this surface as it is on `memory.search`. The response SHALL therefore carry the ranked pass's abstention flag, its reason when abstaining, and its shortening flag, grouped under a single OPTIONAL response field so that one presence check answers "did the ranked pass run at all". Inside that field the flag names SHALL match `memory.search`'s, so the two surfaces read identically.

That field SHALL be present ONLY when the ranked pass actually executed. Two paths skip it — no derivable seed, and an entity pre-pass that already filled the channel to its cap — and reporting `abstained: false` for a search that never ran would assert a verdict the server never measured. Its shortening flag describes the ranked pass's own page against the limit THAT PASS requested, not the channel's cap: the channel MAY therefore be full while the shortening flag is set, and the requirement is that this be stated rather than that the pass's limit be changed.

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

#### Scenario: The ranked pass reports an empty pool

- **GIVEN** a `focus` for which both retrieval branches return no candidate in scope
- **WHEN** `memory.context` is called
- **THEN** `relevantMemories[]` SHALL be empty and the response SHALL report the ranked pass as abstaining, with the empty-pool reason

#### Scenario: The ranked pass reports a gate-shortened page

- **GIVEN** a `focus` for which the relevance filter removes candidates and leaves fewer rows than the ranked pass requested
- **WHEN** `memory.context` is called
- **THEN** the response SHALL report the ranked pass's shortening flag alongside `abstained: false`

#### Scenario: A skipped ranked pass reports nothing

- **GIVEN** an entity pre-pass that fills the relevance channel to its cap
- **WHEN** `memory.context` is called
- **THEN** the ranked-pass field SHALL be absent from the response, rather than reporting `abstained: false`
- **AND** the same SHALL hold when no seed can be derived

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

The `/mcp` and `/mcp/<slug>` endpoints SHALL register `memory.doctor` and `memory.stats`. Both output contracts SHALL enumerate exactly the fields the tools return: a documented field the tool does not return misleads a client into treating its absence as a fault, and a returned field the contract omits is undocumented surface (the two counters added for queue-depth observability were both in the second category).

The `db` block SHALL NOT carry an `open` flag. Producing the report requires a database read to authenticate the request, so a report that exists is proof the database was open, and the flag's `false` value is reachable only in a state where the tool returns no report at all — the unreachable-state defect (see "A tool's description and its response MUST agree, and neither may promise an unreachable state"). Database trouble that does NOT prevent the call SHALL continue to be reported where it varies: `integrity` from the integrity check, and `warnings` for a pragma read that failed. **BREAKING** on the published output contract, accepted because a field with one reachable value cannot be depended upon for anything.

#### Scenario: `memory.doctor` returns an operational report

- **WHEN** an MCP client calls `memory.doctor`
- **THEN** the server SHALL return `{ db: { journalMode, integrity, sizeBytes }, embeddings: { model, backlog }, entities: { backlog }, consolidation: { lastRunAt, lastRunOps }, sessions: { active }, review: { needsReview, pendingJudgments }, warnings: string[] }` — the report SHALL NOT contain an `llm` block, and the `embeddings` block SHALL NOT contain `enabled` (embeddings are always on); `model` SHALL identify the compiled-in embedding model
- **AND** `entities.backlog` and `review` SHALL be server-wide, matching `sessions.active`

#### Scenario: `memory.stats` returns counters by scope and status

- **WHEN** an MCP client calls `memory.stats`
- **THEN** the server SHALL return `{ scope, memoriesByStatus, memoriesByType, sessionsByStatus, needsReviewTotal, pendingJudgmentsTotal }`, where `scope` is the resolved scope label, the three `*By*` values are each a `Record<string, number>`, and the two totals are numbers — every one of them computed against the request context

#### Scenario: A read-only token calls `memory.doctor` or `memory.stats`

- **WHEN** the caller's scope is `read:*`, or is `read:project:<id>` and the connection's effective scope resolves to that same project
- **THEN** both tools SHALL succeed (they are read-only by design)
- **WHEN** the caller's scope is `read:project:<id>` and the connection's effective scope resolves to global or to a different project
- **THEN** the call SHALL be rejected with code `forbidden`

#### Scenario: The report carries no `db.open` flag

- **WHEN** an MCP client calls `memory.doctor`
- **THEN** the `db` block SHALL contain `journalMode`, `integrity` and `sizeBytes` and SHALL NOT contain `open`
- **AND** the declared `outputSchema` SHALL NOT mark `open` required, nor declare it at all

#### Scenario: A database fault that still permits the call is reported where it varies

- **GIVEN** a database whose pragma reads fail while the connection still authenticates the request
- **WHEN** an MCP client calls `memory.doctor`
- **THEN** the call SHALL succeed, `warnings` SHALL name the failed pragma read, and `integrity` SHALL report `unknown` rather than `ok`
- **AND** no field SHALL claim the database is healthy

### Requirement: The observability tool descriptions MUST disclose which population their counters cover

`memory.doctor` and `memory.stats` return counters under colliding names over two different populations: doctor's are server-wide (all projects plus global), stats' are resolved against the request context. `memory.stats` carries a top-level `scope` field and `memory.doctor` carries none, but a client SHALL NOT be expected to infer one tool's semantics from the ABSENCE of a field in another. The counters therefore differ in value with nothing on the wire to explain it, and two readers of this codebase have already drawn a wrong conclusion from the collision. The tool description is the surface the model reads before deciding to call, so the disclosure belongs there.

`memory.doctor`'s registered description SHALL:

- state that the report is SERVER-WIDE, covering all projects and the global scope;
- state that `memory.stats` carries the scoped equivalents and that the two sets of numbers WILL differ, so a mismatch reads as intent rather than as one of them being stale;
- name EVERY cause of that divergence, not only the population. `review.needsReview` diverges from `memory.stats`' `needsReviewTotal` by population alone, but `review.pendingJudgments` diverges by population AND by filtering: doctor's counter is an unfiltered count of pending rows while the scoped totals count only ADJUDICABLE pairs, both endpoints still `active` (see the `memory` capability, "that field SHALL remain an unfiltered count of pending rows"). Naming only the population is worse than naming no cause, because a reader who verifies that both calls resolve to one project — where the population cannot explain anything — is left concluding that one of the two numbers is stale. The divergence is measurable inside a single project: archiving one endpoint of a pending pair drops the scoped totals and leaves doctor's count unchanged;
- name the blocks the report actually returns, including `entities`, `sessions` and `review`, the three the description omitted before this requirement existed;
- NOT advertise an `llm` block or any other field the output contract forbids (see "The MCP server MUST expose two observability tools", which requires the report to contain no `llm` block). A description that promises a field the tool cannot return misleads a client into treating its absence as a fault — the same hazard that requirement addresses for the output contract, on the surface the model actually reads.

`memory.stats`' registered description SHALL name `needsReviewTotal` and `pendingJudgmentsTotal` among its counters, and SHALL state that `memory.doctor` reports same-named counters server-wide so its numbers will differ. Naming the two totals is load-bearing rather than cosmetic: `memory.doctor`'s disclosure directs the reader to `memory.stats` for the scoped equivalents, and that direction is useless if `memory.stats`' own description never mentions the fields it names.

These disclosures SHALL be expressed in each tool's top-level description text and SHALL NOT be expressed only in a zod `describe()` on the input or output schema, which some clients do not surface to the model — consistent with the identical constraint already placed on `memory.archive` and on the `sessionId` argument.

Both descriptions SHALL satisfy `DESCRIPTION_MAX_LENGTH` (see "Tool descriptions MUST stay below the client truncation ceiling"); if a clause does not fit, prose SHALL be cut from the description rather than the constant raised. Because client truncation is a tail cut, the server-wide disclosure SHALL NOT be the trailing clause of `memory.doctor`'s description.

This requirement constrains description prose only. It SHALL NOT be read as re-scoping any counter: `memory.doctor`'s `sessions.active`, `entities.backlog` and `review` counters remain server-wide as already specified, and satisfying it SHALL NOT add, remove or rename a field on either payload.

#### Scenario: `memory.doctor`'s description discloses the server-wide population and its scoped counterpart

- **WHEN** an MCP client retrieves the tool description for `memory.doctor` via `tools/list`
- **THEN** the description SHALL convey that the report is server-wide across all projects and the global scope
- **AND** the description SHALL name `memory.stats` as the source of the scoped equivalents and SHALL convey that the two will differ
- **AND** the description SHALL name `entities`, `sessions` and `review` among the blocks returned

#### Scenario: `memory.doctor`'s description does not advertise the removed `llm` block

- **WHEN** an MCP client retrieves the tool description for `memory.doctor` via `tools/list`
- **THEN** the description SHALL NOT contain the substring `LLM` in any letter case
- **AND** a `memory.doctor` call in the same session SHALL return a payload for which `'llm' in payload` is `false`, so the description and the payload agree

#### Scenario: `memory.stats`' description names its queue-depth totals and the divergence

- **WHEN** an MCP client retrieves the tool description for `memory.stats` via `tools/list`
- **THEN** the description SHALL name `needsReviewTotal` and `pendingJudgmentsTotal`
- **AND** the description SHALL still convey that its counters are scoped to the active project or global
- **AND** the description SHALL convey that `memory.doctor`'s same-named counters are server-wide and will differ

#### Scenario: The disclosures live in the top-level description, not a schema `describe()`

- **WHEN** the registered descriptions and schemas for `memory.doctor` and `memory.stats` are inspected
- **THEN** every disclosure this requirement mandates SHALL be present in the string returned as each tool's `description` by `tools/list`
- **AND** neither tool's presence in `tools/list` SHALL depend on a `describe()` call on `doctorOutput` or `statsOutput` to satisfy this requirement

#### Scenario: Both rewritten descriptions stay inside the truncation cap

- **WHEN** an MCP client issues `tools/list` against the server
- **THEN** the descriptions of `memory.doctor` and `memory.stats` SHALL each be at most `DESCRIPTION_MAX_LENGTH` characters measured as `String.length`
- **AND** `memory.doctor`'s server-wide disclosure SHALL appear before its closing usage guidance, so a tail truncation removes the usage hint rather than the disclosure

#### Scenario: The disclosure does not change any counter's value

- **GIVEN** a scope holding one adjudicable pending pair and three pairs with a retired endpoint
- **WHEN** `memory.doctor` and `memory.stats` are both called from a connection resolving to that scope
- **THEN** `memory.doctor`'s `review.pendingJudgments` SHALL remain the unfiltered server-wide count and `memory.stats`' `pendingJudgmentsTotal` SHALL remain 1, exactly as before this change

#### Scenario: `memory.doctor`'s description names the filter as well as the population

- **WHEN** an MCP client retrieves the tool description for `memory.doctor` via `tools/list`
- **THEN** the description SHALL convey that `pendingJudgments` is an unfiltered count of pending rows while the scoped totals count only adjudicable pairs
- **AND** it SHALL remain true that the description also conveys the server-wide population, which explains the `sessions`, `entities` and `needsReview` divergences

#### Scenario: The named causes account for a divergence inside one project

- **GIVEN** a single project holding one pending pair, and both tools called from a connection resolving to that project
- **WHEN** one endpoint of the pair is archived and both tools are called again
- **THEN** `memory.doctor`'s `review.pendingJudgments` SHALL still report 1 while `memory.stats`' `pendingJudgmentsTotal` SHALL report 0
- **AND** the `memory.doctor` description SHALL contain a cause that accounts for that difference, since the population cannot: both calls resolved to the same project

### Requirement: The MCP server MUST expose three project-management tools under the `project.*` namespace

The `/mcp` and `/mcp/<slug>` endpoints SHALL register `project.use`, `project.list`, and `project.current` with the following contracts. Tool names live under the top-level `project.*` namespace (not `memory.project_*`) to distinguish project management from memory CRUD.

`project.list`'s per-project count SHALL be named `activeMemoryCount` and SHALL count only memories whose `status` is `active`, in that project's scope. The name carries the filter because the count's previous name, `memoryCount`, stated neither dimension and was measured disagreeing with the corpus the same connection could read: after `memory.archive` on a project's only memory, `project.list` reported `1` while `memory.search` in that same scope returned `0`. The name is additionally reused elsewhere in the server for a different aggregate (memories saved in one session), so a bare `memoryCount` on this payload is ambiguous in two ways at once. Renaming rather than silently re-filtering is required: a changed value under an unchanged key gives a consumer no signal to re-read the contract.

`activeMemoryCount` SHALL be computed by a repository read that takes the scope as a required parameter (see the `data-access` requirement "`project.list`'s per-project memory count MUST be a scoped repository read"). The scope SHALL be derived from the project row being reported, and the token-authorization filter over project rows SHALL be applied BEFORE any count is taken, so the handler can only count a scope the token was already authorized to read. This ordering is the entire basis on which a handler may name its own scope, and it SHALL NOT be relaxed into a post-filter.

`project.list` SHALL NOT resolve an effective scope from the request context in order to produce the count, and SHALL continue to succeed on a connection whose URL slug resolves to no project (see "the connection is not bricked by the refusal").

`project.list` SHALL NOT report a second, unfiltered per-project total. The per-status breakdown scoped to the request context is `memory.stats`' `memoriesByStatus`, and a second total on this payload would answer the same question on a path that deliberately does not resolve the caller's scope.

`project.list`'s registered top-level description SHALL state that the count is of active memories. This SHALL be in the description string returned by `tools/list`, not only in a schema `describe()`, which some clients do not surface to the model.

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
- **THEN** the server SHALL return `{ projects: Array<{ slug, displayName, archived, activeMemoryCount }> }` ordered by slug ascending, filtering archived rows by default
- **AND** the payload SHALL NOT contain a `memoryCount` key on any project entry

#### Scenario: `activeMemoryCount` drops when a memory is archived

- **GIVEN** projects `p` and `q`, where `p` holds exactly one memory with `status = 'active'` and `q` holds two
- **WHEN** an MCP client calls `project.list`, then calls `memory.archive` on `p`'s only memory, then calls `project.list` again
- **THEN** the first response SHALL report `activeMemoryCount` of 1 for `p`
- **AND** the second response SHALL report `activeMemoryCount` of 0 for `p`
- **AND** `q`'s `activeMemoryCount` SHALL be 2 in both responses

#### Scenario: `activeMemoryCount` agrees with what the same connection can retrieve

- **GIVEN** a project holding one `active` memory and one `archived` memory
- **WHEN** an MCP client on a connection resolving to that project calls `project.list` and `memory.stats`
- **THEN** `activeMemoryCount` for that project SHALL equal `memory.stats`' `memoriesByStatus.active` for the same scope
- **AND** `activeMemoryCount` SHALL be strictly less than the project's total row count, so the filter is observable rather than vacuous

#### Scenario: `activeMemoryCount` excludes memories outside the reported project

- **GIVEN** projects `p` and `q` each holding `active` memories, plus at least one `active` memory in the global scope
- **WHEN** a token authorized for both projects calls `project.list`
- **THEN** each entry's `activeMemoryCount` SHALL count only that entry's own project scope
- **AND** no entry's `activeMemoryCount` SHALL include the global-scope memories

#### Scenario: A project-scoped token sees only its own project and its own count

- **GIVEN** projects `p` and `q` both holding `active` memories, and a token with scope `project:<p.id>`
- **WHEN** the token calls `project.list`
- **THEN** the response SHALL contain `p` only, with `p`'s own `activeMemoryCount`
- **AND** no count for `q` SHALL be computed or returned

#### Scenario: `project.list` still succeeds on a connection whose slug resolves to no project

- **GIVEN** a connection at `/mcp/no-such-project` and a token authorized to read the existing projects
- **WHEN** the client calls `project.list`
- **THEN** the call SHALL succeed and SHALL report `activeMemoryCount` for every project the token may read
- **AND** the call SHALL NOT be rejected with `project_not_found`

#### Scenario: `project.list`'s description states that the count is of active memories

- **WHEN** an MCP client retrieves the tool description for `project.list` via `tools/list`
- **THEN** the description SHALL convey that the per-project count covers active memories
- **AND** the description SHALL satisfy `DESCRIPTION_MAX_LENGTH` (see "Tool descriptions MUST stay below the client truncation ceiling")

#### Scenario: `project.current` reports resolution provenance

- **WHEN** an MCP client calls `project.current`
- **THEN** the server SHALL return `{ slug: string | null, projectId: string | null, source: 'url-path' | 'roots' | 'tool-explicit' | 'none', suggestedSlugs: string[] }` where `suggestedSlugs` is populated by the most recent `roots/list` derivation that did NOT auto-activate (existing-but-already-active, or non-existing)

### Requirement: The MCP `initialize` response MUST ship a protocol-teaching `instructions` block

When the MCP server is constructed, its `instructions` field SHALL be populated with a scope-aware string that teaches the agent when to call each tool. The string SHALL be 1000 characters or fewer in both variants. This cap is a self-imposed token budget rather than the binding limit: the MCP specification defines `InitializeResult.instructions` as an optional free-form string with no maximum length or truncation rule, but at least one consuming client DOES impose a ceiling — Claude Code truncates `instructions` at 2048 characters with the same `LB` constant it applies to tool descriptions, appending `… [truncated]`. The 1000-character cap is therefore chosen for token cost, at less than half the known client ceiling, and it binds first. Any future change RAISING this cap SHALL keep it below the verified client ceiling (see "Tool descriptions MUST stay below the client truncation ceiling").

The instructions SHALL be organized as directive, proactively-phrased guidance citing the relevant tools by name, and SHALL include all of:

1. **A proactive save flow** — directing the agent to call `memory.save` (with the required short `title` headline plus the `content`) the moment something noteworthy happens (bug fix · decision · discovery · config change · pattern · preference) rather than batching to session end, and naming the `topic_key` supersede path and the `candidates[]` → `memory.judge` conflict-resolution path. Mechanical detail (error codes, scope semantics) MAY be deferred to the tool's own `description`.
2. **A recall flow** — directing the agent that when starting or resuming work, after a `/compact` event, or when asked "what did we do", it SHALL call `memory.context` (or `memory.search` for keyword lookup) BEFORE acting, but ONLY when it lacks the prior detail it needs. The phrasing SHALL keep recall on-demand — it MUST NOT direct an unconditional `memory.context` load at session start.
3. **A session-close flow** — directing the agent to call `memory.session_summary({title, summary})`. The trigger SHALL be bound to ending a turn in which real work happened — phrased so the agent saves before ending any working turn, and SHALL NOT be evadable by avoiding the literal word "done". The flow SHALL describe the title constraint (≤100 chars, descriptive of what was actually worked on — NOT the cwd, NOT generic), the summary structure (the canonical section list defined in `sessions`, carried from its single source rather than restated), AND the summary length cap (currently ≤10000 chars, derived from `SUMMARY_MAX_CHARS`). The cap MUST be present inline so the agent budgets for it on the first attempt; this is verified by the same length test that enforces the 1000-character ceiling.
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
- **THEN** the `InitializeResult.instructions` SHALL contain the same protocol flows (the proactive save flow, the on-demand recall flow, the session-close flow with the `10000`-char cap, AND the `memory.about` update-guidance pointer) and a note indicating how a project becomes active on an unscoped connection — roots-based auto-detection where the client supports it, otherwise `project.use`. It SHALL NOT name the retired `X-Rembric-Project` header, which is asserted absent from both variants by `apps/server/src/mcp/instructions.test.ts`.

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

#### Scenario: The instructions cap stays below the client ceiling

- **WHEN** a change raises `INSTRUCTIONS_MAX_LENGTH` above 1000
- **THEN** the new cap SHALL remain below the verified client truncation ceiling for `instructions` (2048 characters in Claude Code 2.1.220)
- **AND** the change SHALL record the ceiling it re-verified, so the cap is never raised past a limit nobody checked

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

The server SHALL register a `memory.suggest_topic_key` tool that returns a stable topic key heuristic from `type` plus optional `title` / `content`. The implementation SHALL be deterministic (no LLM call) and family-aware, with one family per `type`: `preference/*` for `user`, `feedback/*` for `feedback`, `decision/*` for `project`, `reference/*` for `reference`, `runbook/*` for `procedural`. No other `type` is accepted — the tool's schema is `z.enum(MEMORY_TYPES)`.

The slug SHALL be derived by TRANSLITERATING the title rather than stripping it: a character outside `[a-z0-9-]` SHALL be mapped to its closest ASCII equivalent where one exists (Latin diacritics, `ß`, `ø`, `æ`, Cyrillic, Greek), so a non-ASCII word yields one token rather than fragmenting into several. Stripping non-ASCII characters to whitespace is specifically forbidden: it splits words and each fragment then consumes one of the bounded token slots, truncating the slug before the terms that identify the topic.

Function words SHALL be filtered before the token budget is applied, and the filtered set SHALL NOT be limited to English — a non-English title whose particles survive spends its budget on them and loses its discriminating terms.

When the title and content together yield no usable slug — which is the case for scripts no transliteration table covers, notably CJK and Hangul — the tool SHALL return `topic_key: null` together with a `reason` naming why, and SHALL NOT invent a placeholder. Emitting a constant such as `<family>/untitled`, or a slug reduced to an incidental number, is forbidden: distinct memories would receive the same suggestion, and an agent adopting it would drive the `topic_key` upsert to supersede an unrelated active row. A caller may still author its own key, which the server accepts as Unicode.

#### Scenario: A suggestion is requested for a clear case

- **WHEN** `memory.suggest_topic_key({type: 'project', title: 'JWT auth middleware'})` is called
- **THEN** the response SHALL carry a non-null `topic_key` in the `decision/` family derived from the title's non-stopword keywords

#### Scenario: A suggestion is requested without a title

- **WHEN** `memory.suggest_topic_key({type: 'project', content: 'long free-form text...'})` is called
- **THEN** the heuristic SHALL fall back to a content-derived slug (first non-stopword keywords), prefixed with the type family

#### Scenario: A type outside the memory-type enum is rejected

- **WHEN** `memory.suggest_topic_key` is called with a `type` that is not one of `MEMORY_TYPES`
- **THEN** the call SHALL be rejected with code `invalid_input`

#### Scenario: An accented title keeps its words whole

- **WHEN** a title containing accented Latin characters is passed (e.g. Spanish `admisión`, German `Größe`)
- **THEN** each such word SHALL appear in the slug as one transliterated token, and SHALL NOT be split at the accented character

#### Scenario: A non-English title reaches its discriminating terms

- **WHEN** a Spanish title is passed whose leading words are articles and prepositions
- **THEN** those particles SHALL be absent from the slug, and the slug SHALL contain the title's content words rather than stopping among the particles

#### Scenario: A title in a script with no transliteration yields no suggestion

- **WHEN** a title consisting of Hangul or CJK characters with no ASCII content is passed
- **THEN** the response SHALL carry `topic_key: null` and a non-empty `reason`, and SHALL NOT carry a placeholder slug

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
- **THEN** at least one of the two necessarily lies outside the connection's effective scope, so the call SHALL be rejected with code `not_found` (per the cross-scope-target requirement) — the legacy `cross_scope_relation` code is superseded at the tool surface by this masking rule; the underlying `RelationsService.compare` defensive check (and its `cross_scope_relation` error) remains in place for same-scope-resolved callers that do not go through the connection-scoped path (e.g. the development seeder)

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

`memory.session_start` is unaffected: it never resolves an existing row by id, and the row it may adopt is found by an active-session lookup that excludes soft-deleted rows, so it can neither target nor revive a deleted session. It does NOT always insert a new row — see "The MCP server MUST expose three session-lifecycle tools", which specifies the adoption path and its `reused` flag — and this requirement SHALL NOT be read as promising that it does.

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
- **THEN** the response SHALL be an MCP error with the cross-token mask `session_not_found`, NOT `session_deleted` — the mask never reveals that a session with that id exists under another token, matching "A session-lifecycle tool targets a session owned by a different token" above

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

- `query?: string` — free-text query; when provided, the server SHALL sanitize it (the same sanitizer used by `memory.search`'s hybrid retrieval — see the `memory` capability) and use the `prompts_fts` virtual table via `MATCH` against `content + tags`. A query that sanitizes to nothing (e.g. pure punctuation) SHALL be treated as no query (recency fallback) rather than raising an error.
- `sessionId?: string` — restrict to prompts whose `session_id = <sessionId>`.
- `agent?: string` — restrict to prompts whose `agent = <agent>`.
- `includeDeleted?: boolean` — default `false`; when `true`, soft-deleted prompts SHALL be included.
- `limit?: number` — default `25`, bounded to `[1, 100]` by the declared input schema. A value outside that range SHALL be REJECTED as an invalid argument rather than clamped.
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
  "total": <count>
}
```

The tool SHALL resolve effective project via the existing `scopeFromContext` precedence (path-scoped `ctx.project` → `SessionRouter` pin → global). It SHALL NOT leak prompts from any other scope.

Because the input schema's bound exactly brackets the service's own range, no clamping can occur over the transport, and the response SHALL NOT carry a field reporting that `limit` was clamped (see "A tool's description and its response MUST agree, and neither may promise an unreachable state"). The service MAY retain an in-process clamp over the same range as a defensive bound for a direct caller; it is unobservable over the transport and SHALL NOT be reported in the response. The tool's description SHALL name `limit`'s default and its maximum and SHALL state that a larger value is rejected rather than clamped — a rejection the caller was not told how to avoid is not a safe bound.

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

The title predates the behaviour: `limit` is NOT clamped and nothing is reported, and the scenario pins the rejection that happens instead.

- **WHEN** the caller passes `limit: 500`
- **THEN** the call SHALL be rejected as an invalid argument and SHALL NOT return a prompt page
- **AND** `limit: 0` SHALL be rejected on the same terms — the bound is two-sided
- **AND** `limit: 100` SHALL succeed, which is the control that makes the rejection a finding rather than a broken probe, and proves the bound the description teaches is usable
- **AND** no response SHALL carry a field reporting that `limit` was clamped

#### Scenario: `memory.search_prompts`' description teaches its bound

- **WHEN** an MCP client retrieves the tool description for `memory.search_prompts` via `tools/list`
- **THEN** the description SHALL state `limit`'s default and its maximum, and that a larger value is rejected rather than clamped
- **AND** the response shape the description advertises SHALL NOT list a clamp-reporting field
- **AND** the description SHALL satisfy `DESCRIPTION_MAX_LENGTH` (see "Tool descriptions MUST stay below the client truncation ceiling")

#### Scenario: `memory.search_prompts` from a path-scoped connection rejects cross-scope leakage

- **GIVEN** a token connected to `/mcp/foo` AND a prompt belonging to project `bar`
- **WHEN** the agent calls `memory.search_prompts({ query: "anything matching bar" })`
- **THEN** the `bar` prompt SHALL NOT appear in the response

#### Scenario: `memory.search_prompts` does not raise an FTS5 syntax error on ordinary punctuation

- **GIVEN** a prompt in scope with content `"what's the deploy plan?"`
- **WHEN** the agent calls `memory.search_prompts({ query: "what's the deploy plan?" })`
- **THEN** the call SHALL succeed and SHALL NOT raise an FTS5 syntax error
- **AND** the response SHALL include the matching prompt

#### Scenario: A query that sanitizes to nothing falls back to recency

- **WHEN** the agent calls `memory.search_prompts({ query: "??? !!!" })`
- **THEN** the call SHALL succeed and return the most recent in-scope prompts, as if no query had been given

### Requirement: The MCP server MUST expose a read-only `memory.about` update-guidance tool

The server SHALL register a `memory.about` tool that returns Rembric update guidance as structured data. The tool SHALL take no input parameters, SHALL be read-only (no database access, no persistence, no mutation of any kind), and SHALL be idempotent. Its registered description SHALL contain the keywords `update` and `upgrade` and reference plugins so an agent selects it when the operator asks how to update or upgrade Rembric.

The tool acts as the cross-client equivalent of a Claude-Code skill: it is the portable surface — reachable from all four supported clients — that hands the operator the commands to run. It SHALL be **guidance-only**: it returns command strings for the operator to run and SHALL NOT execute `curl`, `sh`, `docker`, or any shell command itself.

The response SHALL be split into two axes that are never conflated:

- `server`: an object containing the running server version (the value of `REMBRIC_VERSION`), a human-readable note that this is the server (which runs wherever the tool executes, e.g. the operator's VPS), and the server update path on that host (`docker compose pull && docker compose up -d`). This axis SHALL NOT claim anything about client plugin state.
- `plugins`: an object containing the canonical TUI-installer commands — a **read-only status command** (`… --status --json`) that reports the server and each plugin's installed-vs-available version with a per-agent `action` (`none`/`update`/`ahead`/`unknown`), the interactive entrypoint (`curl -fsSL <install-url> | sh`), the update-all variant (`… --action=update`), and a subset example (`… --action=update --agent=<a,b>`) — together with an explicit note that plugins are installed per client machine, that this server cannot see them, that the operator runs the command on each machine where Rembric is used, and that the `update_all` command is safe to run directly (it updates only agents with an update available and skips the rest without erroring) — the status-first-then-selective-update advice applies to the `subset` command, where the operator names specific agents.

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
- **AND** the `plugins.note` SHALL state that `update_all` is safe to run directly without checking `status` first
- **AND** the `plugins.note` SHALL direct the operator to check `status` first specifically when using the `subset` command to update named agents

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

The shared resolver SHALL refuse with `project_not_found` rather than returning a scope when the path slug names no project, so no tool routed through it can inherit a fallback by omission — including a tool added after this requirement lands.

A tool that resolves its own project rather than delegating to the resolver SHALL apply the same refusal. Two do, both because they must classify the request before a scope exists to assert against: `memory.save`, which distinguishes `scope='global'` (`scope_locked`) from `scope='project'`, and `memory.session_start`, which binds the session row to a project. Every such site SHALL build its message and `suggestedSlugs[]` from one shared constructor, so the refusals cannot drift in wording or payload. That obligation SHALL be verified by enumeration over the registered tool list (below), never by counting resolver call sites — a tool absent from that list of call sites is exactly how this defect reached three separate write paths.

Every tool routed through the resolver SHALL surface that refusal as a structured `mcpError` (`isError: true` with a JSON body carrying `code` and `message`), never as an exception escaping into the transport, because an escaped exception yields an error result with no machine-readable `code`. A tool SHALL therefore resolve scope inside the same error-translating boundary it already uses for authorization failures. Where a tool previously validated its arguments before resolving scope, scope resolution SHALL come first: an unusable connection is reported ahead of a malformed argument, because the call cannot succeed under any arguments.

Coverage SHALL be asserted by enumeration rather than by inspection: a test SHALL drive the registered tool list, invoke every scope-sensitive tool on a connection whose path slug names no project, and assert the structured refusal. Tools exempt from scope resolution SHALL be enumerated explicitly in that test, so a newly registered tool fails it until it is classified.

#### Scenario: `memory.context` at session start on an unscoped connection

- **GIVEN** an unscoped `/mcp` connection whose project is resolvable via MCP roots discovery
- **WHEN** the agent's first tool call is `memory.context` (before any other call has populated the router)
- **THEN** the server SHALL await roots discovery and return the PROJECT's context, not global context

#### Scenario: `memory.capture_passive` while a project suggestion is pending

- **GIVEN** an unscoped `/mcp` connection with a pending project suggestion
- **WHEN** the agent calls `memory.capture_passive` or `memory.save_prompt`
- **THEN** the call SHALL be rejected with code `project_suggestion_pending`, identically to `memory.save`

#### Scenario: Every registered scope-sensitive tool refuses an unresolvable slug

- **GIVEN** a connection whose path slug names no project and a token whose scope is `*`
- **WHEN** the enumerating test invokes every tool in the registered tool list with minimally valid arguments
- **THEN** every tool not on the explicit exemption list SHALL return a result carrying `isError: true` and a JSON body whose `code` is `project_not_found`

#### Scenario: A newly registered tool cannot inherit the fallback

- **GIVEN** a change that registers a new scope-sensitive MCP tool
- **WHEN** the test suite runs without that tool being classified
- **THEN** the enumerating test SHALL fail rather than the tool silently resolving to the global scope

#### Scenario: Scope resolution precedes argument validation

- **GIVEN** a connection whose path slug names no project
- **WHEN** the client calls `memory.get` with neither `id` nor `ids` (a malformed request)
- **THEN** the response SHALL carry `code: 'project_not_found'` rather than `code: 'invalid_input'`

### Requirement: Unexpected errors on any HTTP-exposed surface MUST NOT leak internals

Any error thrown during request handling that is not a `DomainError` (a recognized, intentional failure with a stable `code`) SHALL be treated as unexpected: the server SHALL generate a correlatable `errorId`, log the real error message and stack server-side (never in the response), and return only a generic message (`'An unexpected error occurred.'`) plus that `errorId` to the caller. This SHALL apply uniformly across every HTTP-exposed surface: MCP tool calls (`errToMcp`), the `/api/<slug>/sessions*` and `/api/<slug>/memory/*` routes (`domainErr`), the `/mcp` transport-level catch-all (`respondInternal`), and `/admin` routes (e.g. `POST /admin/consolidation/run`). A `DomainError`'s own `code` and `message` SHALL continue to be returned verbatim — this requirement governs only the unexpected-error path.

#### Scenario: An MCP tool call throws an unexpected error

- **WHEN** an MCP tool handler throws an error that is not a `DomainError`
- **THEN** the response SHALL be `{ ok: false, code: 'internal_error', message: 'An unexpected error occurred.', errorId: <uuid> }`
- **AND** the real error message and stack SHALL be logged server-side, tagged with the same `errorId`
- **AND** the response SHALL NOT contain the real error message or any stack fragment

#### Scenario: An `/api` session route throws an unexpected error

- **WHEN** a `POST /api/<slug>/sessions*` or `/api/<slug>/memory/*` handler throws an error that is not a `DomainError`
- **THEN** the HTTP response body SHALL follow the same shape and the same non-leak guarantee as the MCP tool-call scenario above

#### Scenario: `POST /admin/consolidation/run` throws an unexpected error

- **WHEN** the manually-triggered consolidation run throws an error that is not a `DomainError`
- **THEN** the response SHALL follow the same shape and the same non-leak guarantee

#### Scenario: A `DomainError` is returned verbatim, not generalized

- **WHEN** any of the surfaces above throws a `DomainError` (e.g. `session_not_found`, `invalid_input`)
- **THEN** the response SHALL carry that error's own `code` and `message`
- **AND** SHALL NOT be replaced with the generic `internal_error` shape

### Requirement: Memory-returning MCP reads MUST expose `topic_key`

`topic_key` is the identity of a convergent topic: saving with the same key atomically supersedes the previously-active row in the same `(scope, project_id, topic_key)`. That convergence requires the agent to reproduce a byte-identical key across sessions, so the key SHALL be observable. Every memory-returning read — `memory.get`, `memory.search`, `memory.context.recentMemories`, and `memory.save` candidates — SHALL include the memory's `topicKey` (null when unset).

`memory.search` SHALL additionally accept a `topic_key` filter that returns only rows carrying that exact key. Because a topic slot holds exactly one `active` row and every earlier take on the topic is `superseded`, a `topic_key` filter supplied WITHOUT an explicit `status` SHALL return the topic's whole history rather than defaulting to `active` — otherwise the filter's stated purpose (checking whether a topic already converged before minting a synonym key) is unreachable, because the one row it returns is the only row it could ever return. An explicit `status` alongside `topic_key` SHALL still narrow to that status.

"The topic's whole history" means every status but `archived`. An omitted `status` SHALL mean "any but archived" on EVERY branch — listing, lexical and dense alike — rather than dropping the status predicate on the branches that could carry it. The dense branch is partitioned by `status` and enumerates only the non-archived values, so a branch that dropped the predicate would make an archived row reachable through exactly one of the two fused rankings, letting it outrank a row both branches found; and a retired take is the one thing the convergence check (has this topic already been decided?) has no use for. `status: 'archived'` remains an exact filter, served by the listing and lexical branches (the dense branch is skipped for it).

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

#### Scenario: An archived take is not part of the topic's history

- **GIVEN** a memory archived under `topic_key = 'decision/deploy-runbook'`, plus two later takes under the same key leaving one `superseded` and one `active`
- **WHEN** `memory.search` is called with that `topic_key` and no `status`, with and without a text `query`
- **THEN** exactly the `superseded` and the `active` row SHALL be returned in both cases
- **AND** the same call with `status: 'archived'` SHALL return exactly the archived row

### Requirement: `memory.suggest_topic_key` MUST report whether the suggested key is occupied

A key suggestion computed purely from `type` and `title` cannot tell the agent that an equivalent topic already exists under a differently-worded key, which is the exact failure that fragments a topic into two active rows. `memory.suggest_topic_key` SHALL consult the connection's effective scope and return, alongside the suggested key: `occupied` (whether an active row already holds it), `occupantId` and `occupantTitle` when occupied, and `nearby` — a bounded list of `{topic_key, title}` for active rows in scope whose keys share a prefix with the suggestion — so the agent can adopt an existing key instead of minting a synonym.

#### Scenario: The suggested key is already held

- **GIVEN** an active memory in scope with `topic_key = 'decision/dev-stack-permissions'`
- **WHEN** `memory.suggest_topic_key` produces that same key
- **THEN** the response SHALL report `occupied: true` with the occupant's id and title

#### Scenario: A near-miss key exists

- **GIVEN** an active memory in scope with `topic_key = 'decision/dev-stack-permissions'`
- **WHEN** `memory.suggest_topic_key` produces `decision/dev-stack-chown`
- **THEN** `occupied` SHALL be `false` and `nearby` SHALL include the existing `decision/dev-stack-permissions` entry

#### Scenario: Suggestion is scope-isolated

- **WHEN** `memory.suggest_topic_key` is called on a connection scoped to project A and the key is held only in project B
- **THEN** `occupied` SHALL be `false` and `nearby` SHALL NOT reference project B's row

### Requirement: `memory.capture_passive` MUST use the same curation path as `memory.save`

`memory.capture_passive` is the tool the protocol steers agents toward for bulk persistence, so it SHALL NOT be a weaker write path. Each extracted learning SHALL be saved through the same pipeline as `memory.save`: convergent-topic handling, inline embedding before candidate detection, and save-time candidate detection. The response SHALL aggregate the detected `candidates[]` so conflicts introduced by a bulk capture are surfaceable and judgeable, rather than silently accumulating unlinked rows that are additionally invisible to the dense search branch until a background drain reaches them.

#### Scenario: A bulk capture surfaces a conflict

- **GIVEN** an existing active memory that semantically conflicts with one of the extracted learnings
- **WHEN** `memory.capture_passive` saves that learning
- **THEN** the response SHALL include a candidate referencing the existing memory, and a pending relation SHALL have been recorded

#### Scenario: Captured rows are immediately searchable by the dense branch

- **WHEN** `memory.capture_passive` saves a learning
- **THEN** that row's embedding SHALL have been computed before the call returns, so a subsequent `memory.search` vector branch can surface it

### Requirement: `memory.capture_passive` MUST NOT report success when it extracted nothing

Returning `{saved: 0}` as a success response for text whose learnings header did not match causes the agent to report to the user that learnings were persisted when none were. A zero-match parse SHALL be an explicit, actionable signal naming the expected header form. The header match SHALL accept a case-insensitive level-2 or level-3 heading with an optional trailing colon, so ordinary formatting variation is not silently discarded.

#### Scenario: No learnings header is present

- **WHEN** `memory.capture_passive` is called with text containing no learnings heading
- **THEN** the response SHALL explicitly report that nothing was extracted and name the expected heading form

#### Scenario: A lower-cased heading without a colon is accepted

- **WHEN** `memory.capture_passive` is called with a `### key learnings` heading followed by three list items
- **THEN** three memories SHALL be saved

### Requirement: `memory.stats` counts MUST all be scoped to the request context

`memory.stats` is documented as returning counts scoped to the request context. Every counter it returns SHALL therefore be computed against the resolved `Scope`, including `sessionsByStatus`, which once aggregated every non-soft-deleted session row on the server regardless of project. The scoped guarantee SHALL be enforced by the counting method **requiring** a `Scope` parameter rather than by a naming convention, so a future unscoped call cannot pass review by omission. The unscoped variant SHALL carry the `admin` prefix that confines it to the allow-listed `(file, method)` pairs — which for this read are the dashboard router, the `memory.doctor` closure and the service pass-through between them, not the dashboard alone (see the `data-access` capability, "Scoped, unsafe, and admin method families").

The documented output contract SHALL be corrected to enumerate exactly the counters the tool returns.

#### Scenario: A project-scoped token reads stats

- **WHEN** `memory.stats` is called on a connection whose effective scope is project A, and other projects have sessions
- **THEN** `sessionsByStatus` SHALL count only sessions belonging to project A

#### Scenario: The output contract matches the implementation

- **WHEN** the documented `memory.stats` output is compared against the returned structured content
- **THEN** every documented counter SHALL be present and no returned counter SHALL be undocumented

### Requirement: `memory.search` MUST accept an `entity` filter, and no new tool SHALL be added

Exact-address retrieval SHALL be reachable as an `entity` argument on `memory.search` rather than as a new tool. The MCP tool surface is already at the practical ceiling for reliable tool selection — 23 tools with four clusters the model cannot easily distinguish — so a capability expressible as an argument SHALL be an argument.

When `entity` is supplied, the response SHALL be the scoped set of memories linked to that entity, chronologically ordered, and the response SHALL indicate that the entity path was taken rather than the ranked text-query path, so the agent does not read the absence of relevance scores as a defect.

Completeness is bounded, and the bound SHALL be the same generous over-fetch ceiling the ranked branches use rather than the ranked default page size: an omitted `limit` on the entity path means "every linked memory in scope" up to that ceiling, NOT the small default that is calibrated for a ranked page. Returning eight rows out of twelve under a description promising completeness is a correctness problem, because the agent has no signal that anything was withheld. An explicit `limit` SHALL still bound the page.

`entity` SHALL compose with every other selection filter `memory.search` accepts — `status`, `type`, `tag`, `topic_key` and `include_global` — applying the same predicates with the same meaning as on the ranked path. A filter that is documented as combinable but silently dropped is worse than an unsupported one: an agent that narrows to `type: 'user'` and receives unfiltered rows reads project notes as user preferences. An OMITTED `status`, however, SHALL mean "any but archived" here rather than the ranked branches' `active` default — the same reason an omitted `limit` means the generous bound: this path is specified as complete within scope, and inheriting the ranked default would withhold the `superseded` history exactly as the ranked default page withheld the twelfth row. An explicit `status` SHALL filter exactly, `superseded` and `archived` included. Combining `entity` with a text `query` SHALL narrow within the entity's memories rather than fusing two result sets.

An empty entity result SHALL say whether the index has caught up. The tool's own guidance is "empty means it is not there, so retry with `query`" — which is wrong for as long as the extraction drain is still running, and after a recipe change that is the state of the whole corpus. When an `entity` lookup returns nothing AND the scope still holds memories awaiting their first scan, the response SHALL carry a draining flag, and the argument's description SHALL name it so the agent retries the same lookup rather than degrading to text. A non-empty result and a miss over a fully-scanned scope SHALL NOT carry it, so its presence always means something.

#### Scenario: Retrieving everything known about a file

- **WHEN** `memory.search` is called with an `entity` naming a file path present in scope
- **THEN** every in-scope memory linked to that path SHALL be returned in chronological order

#### Scenario: An omitted limit returns the whole linked set, not a ranked page

- **GIVEN** twelve in-scope memories linked to one entity
- **WHEN** `memory.search` is called with that `entity` and no `limit`
- **THEN** all twelve SHALL be returned

#### Scenario: An omitted status returns the entity's non-archived history

- **GIVEN** three in-scope memories linked to one entity, one `active`, one `superseded` and one `archived`
- **WHEN** `memory.search` is called with that `entity` and no `status`
- **THEN** the `active` and the `superseded` row SHALL be returned and the `archived` row SHALL NOT
- **AND** each of `status: 'active'`, `'superseded'` and `'archived'` SHALL return exactly its own row

#### Scenario: The response distinguishes the entity path

- **WHEN** `memory.search` returns results for an `entity` lookup
- **THEN** the response SHALL indicate that exact-address retrieval was used

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

### Requirement: Memory-returning reads MUST expose the entities a memory is about

An agent that receives a memory SHALL be able to see what it is about, so it can pivot to related knowledge without guessing a query. The three primary memory-returning reads — `memory.search` result rows, batch `memory.get`, and single-id `memory.get` — SHALL include an `entities[]` field listing the entities linked to each memory, each with its kind. The list SHALL be bounded per memory so a content-heavy row cannot inflate a response.

**Scoped to those three deliberately.** `memory.search`'s relation-expansion rows (`expanded[]`) are a fourth surface that returns whole memories and carries no `entities[]` today. The previous wording said "memory-returning reads" without qualification and therefore overclaimed: the shipped repo has never satisfied it for `expanded[]`. The requirement is narrowed to what is true rather than left asserting what is not, and extending the projection to `expanded[]` — which would add a per-turn repository read for up to `RELATION_EXPANSION_CAP` rows on the hottest path — is a scoped decision, not a wording fix. `memory.context` is out of scope for a different reason: it projects no per-memory entity list at all, only an `entities.backlog` diagnostics counter.

**When the bound binds** (`entitiesTotal` exceeds it), the bound SHALL be applied to an order that reflects the memory's own entity composition, not the spelling of a kind name: max-min fair share across the kinds linked to the memory, so every kind present contributes one entity before any kind contributes a second, and the remaining slots fall to the kinds that have more. Consequently a kind linked to the memory SHALL NOT be absent from the projection while another kind occupies two or more slots.

**When the bound does not bind, the projection SHALL be the repository's `(kind, value)` order, unchanged.** This is the case on the overwhelming majority of rows (measured: the bound binds on 2 of 285 production-shaped documents), nothing is withheld, so there is no selection to make fair — and re-interleaving a complete list would change what every existing caller sees to no end. The two paths therefore differ in ORDER, not in membership, and only above the bound.

No kind SHALL be declared to outrank another. The ordering carries no precedence claim: which entity is the better pivot depends on the question being asked and that question is not in the row. Note the one residue this does not remove — when equal-sized kinds compete for a surplus slot, the slot goes to the kind whose name sorts first, so `path` beats `url` at identical counts. That is inherited from the extraction budget's allocator, is reachable with as few as three kinds, and is a far smaller effect than the whole-kind eviction this requirement fixes; it is recorded rather than claimed away.

Within a kind the entities SHALL be ordered by value, and the whole order SHALL be total: two identical reads over unchanged data SHALL return the same entities in the same order. `(kind, value)` is unique per memory, so no tie can be left to scan order.

The bound's effect SHALL be reported as a COUNT, not as an indication that it was hit. Each memory carrying `entities[]` SHALL also carry `entitiesTotal: number` — how many entities are linked to that memory in scope, taken before the bound is applied. It SHALL be present whether or not the bound was reached, so a caller never has to distinguish "nothing was cut" from "the field was omitted", and it SHALL NOT be the returned array's length restated. The count SHALL be unaffected by the ordering: reordering the projection changes which entities are returned, never how many exist.

No companion boolean SHALL be returned: truncation is `entitiesTotal > entities.length`, and a flag beside the number is duplicated state that can disagree with itself. This mirrors the relation-annotation total (see "`memory.search` and `memory.get` MUST expose the annotation bound and its true total"), deliberately, so the two projections describe their bounds the same way.

The count SHALL be exact rather than a lower bound, because the reads behind the projection apply no `LIMIT` and no pool bounds them upstream — the array the bound is applied to already holds every linked entity in scope. It therefore differs from the save-time detected count, which is specified as a floor precisely because its channels scan a bounded pool.

No request argument SHALL raise the number of entities returned, and no tool description SHALL name one. The remedy for a truncated list is the exact-address read the entity index already provides — `memory.search` with an `entity` filter, which is complete within scope — not a wider projection on an unrelated read.

Cross-scope entities SHALL NOT be counted: `entitiesTotal` obeys the same scope isolation as the list it describes.

#### Scenario: A returned memory carries its entities

- **GIVEN** a memory linked to two file paths and a ticket reference
- **WHEN** it is returned by `memory.get` or `memory.search`
- **THEN** its `entities[]` SHALL list those three with their kinds

#### Scenario: The entity list is bounded

- **GIVEN** a memory linked to more entities than the per-memory bound
- **WHEN** it is returned
- **THEN** `entities[]` SHALL hold exactly the bound, and `entitiesTotal` SHALL be the larger true count rather than a flag indicating that the bound was hit

#### Scenario: An untruncated list still carries the count

- **GIVEN** a memory linked to fewer entities than the bound
- **WHEN** it is returned
- **THEN** `entitiesTotal` SHALL equal `entities.length`

#### Scenario: A memory with no entities reports zero

- **WHEN** a memory with no linked entities is returned
- **THEN** `entities[]` SHALL be empty and `entitiesTotal` SHALL be 0

#### Scenario: No companion truncation flag is returned

- **WHEN** any memory-returning response is inspected
- **THEN** it SHALL NOT contain a boolean reporting whether the entity list was truncated

#### Scenario: The count is reported on every memory-returning surface

- **WHEN** a memory is returned by `memory.search`, by a batch `memory.get`, or by a single-id `memory.get`
- **THEN** each SHALL carry `entitiesTotal` on the same terms; a surface that omits it SHALL be treated as a defect

#### Scenario: The count respects scope

- **GIVEN** another project holding entities with the same values
- **WHEN** a memory is returned in scope `project:'A'`
- **THEN** `entitiesTotal` SHALL count only entities linked to that memory within its own scope

#### Scenario: A minority kind is not evicted by a dominant one

- **GIVEN** a memory linked to 21 paths, one ticket, one URL and one environment variable, and a bound of 10
- **WHEN** it is returned
- **THEN** the ticket, the URL and the environment variable SHALL each appear in `entities[]`, the remaining slots SHALL hold paths, and `entitiesTotal` SHALL be 24

#### Scenario: The dominant kind loses the surplus slots, not the whole list

- **GIVEN** the same memory
- **WHEN** it is returned
- **THEN** `entities[]` SHALL still contain paths — a kind SHALL NOT be reduced to zero slots while the bound is not yet filled

#### Scenario: A kind that sorts last alphabetically is still projected

- **GIVEN** a memory linked to more entities than the bound, whose only `uuid` sorts after every other kind present by kind name
- **WHEN** it is returned
- **THEN** that `uuid` SHALL appear in `entities[]`

#### Scenario: The projection is repeatable

- **GIVEN** a memory linked to more entities than the bound
- **WHEN** it is returned twice with no intervening write
- **THEN** both responses SHALL contain the same entities in the same order

#### Scenario: All three surfaces project the same order

- **GIVEN** one memory linked to more entities than the bound
- **WHEN** it is returned by `memory.search`, by a batch `memory.get`, and by a single-id `memory.get`
- **THEN** all three SHALL return the same entities in the same order

#### Scenario: A field projection keeps the order, the bound and the count

- **GIVEN** a memory linked to more entities than the bound
- **WHEN** `memory.search` is called with `fields` including `entities`
- **THEN** `entities[]` SHALL carry the same bounded, fair-shared list as an unprojected read, and `entitiesTotal` SHALL be present with the same value

#### Scenario: More distinct kinds than the bound

- **GIVEN** a memory linked to more distinct entity kinds than the bound allows slots for
- **WHEN** it is returned
- **THEN** `entities[]` SHALL hold one entity from each of the first kinds in ascending kind-name order, the remaining kinds SHALL be absent, and `entitiesTotal` SHALL still report every linked entity

### Requirement: Save candidates MUST identify the entity channel as their source

Save-time candidates already carry a source identifying which retrieval channel proposed them. Candidates proposed by entity overlap SHALL carry a source distinguishing them from lexical and dense candidates, so the agent judging a pair understands why the server thought they were related — an entity-sourced candidate means "these concern the same thing", which is a materially different claim from "these read similarly".

#### Scenario: An entity-sourced candidate is labelled

- **WHEN** a candidate is surfaced because it shares a rare entity with the saved memory
- **THEN** its source SHALL identify the entity channel, and the shared entity SHALL be reported

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

### Requirement: Tool descriptions MUST stay below the client truncation ceiling

Every tool description returned by `tools/list` SHALL be at most `DESCRIPTION_MAX_LENGTH = 1900` characters, measured as `String.length` (UTF-16 code units, NOT bytes, since the client compares `String.length`). A CI test SHALL assert the cap over EVERY tool the server registers, reading each description from a real `tools/list` response rather than from the description constants — 18 of the 23 descriptions are inline at their `registerTool` call site, so a constant-based assertion would silently omit them.

The cap guards a **verified external client limit**, not a self-imposed budget. Claude Code truncates each MCP tool description at 2,048 characters and appends `… [truncated]` (`prompt(){ return U.length > LB ? ma(U, LB) + "… [truncated]" : U }` with `LB = 2048`, verified in the 2.1.220 binary). This distinguishes it from the `instructions` cap, which is set far below its own client ceiling for token-cost reasons (see "The MCP `initialize` response MUST ship a protocol-teaching `instructions` block"). The 148-character margin between 1,900 and 2,048 exists so the guard fires on an edit that APPROACHES the ceiling: a cap set at 2,048 passes at exactly 2,048 and loses content at 2,049, giving no warning.

Truncation is a tail cut, so the LAST content of a description is what is lost first. For `memory.search` the tail is the abstention-and-shortening guidance this specification mandates — the abstention instruction (see "An abstaining search response MUST tell the agent not to invent context") followed by the shortening flag and the full-page caveat (see "The four existing memory tools MUST advertise protocol-teaching descriptions") — which is why an untested ceiling is a live hazard rather than a theoretical one. The cap SHALL NOT be interpreted as a prohibition on description content: content requirements elsewhere in this specification remain authoritative, and this requirement obliges only that they be satisfied within the cap.

A future requirement that mandates ADDITIONAL description content SHALL either fit within the cap or raise the cap deliberately, preserving a margin below the then-current verified client ceiling and recording the new ceiling's provenance. Raising the cap to remove a CI failure without re-verifying the ceiling SHALL NOT be treated as satisfying this requirement.

#### Scenario: Every registered tool description fits the cap

- **WHEN** an MCP client issues `tools/list` against the server
- **THEN** for every tool in the response, `description.length` SHALL be at most 1900
- **AND** the assertion SHALL cover every registered tool, not a named subset

#### Scenario: A description grown past the cap fails CI

- **GIVEN** a developer extends the `memory.search` description past 1900 characters
- **WHEN** the test suite runs
- **THEN** the description-length test SHALL fail, naming the offending tool and its measured length
- **AND** the failure SHALL occur while the description is still below the 2048-character client ceiling, so no content has yet been lost

#### Scenario: The cap is measured in characters, not bytes

- **GIVEN** a description containing multi-byte characters such as `·`, `⊕`, `—`, `≤` or `∈`
- **WHEN** its length is checked against the cap
- **THEN** the measurement SHALL be `String.length` (UTF-16 code units), matching the client's own comparison
- **AND** a description of 1900 characters whose UTF-8 encoding exceeds 1900 bytes SHALL pass

#### Scenario: A new content requirement collides with the cap

- **GIVEN** a change adds a requirement mandating further `memory.search` description content
- **WHEN** the resulting description would exceed 1900 characters
- **THEN** the change SHALL either reword the description to fit the cap, or raise the cap and record both the re-verified client ceiling and the retained margin
- **AND** the collision SHALL be resolved as an explicit decision rather than by truncation

### Requirement: `memory.search` and `memory.get` MUST expose the annotation bound and its true total

A bounded list whose depth is invisible cannot be told from a complete one, and a signal that something was withheld is useless without a way to ask for it. Both tools that project a memory's relation annotations SHALL therefore expose the bound as a parameter and the true count as a response field. (The ordering under that bound belongs to the `memory` capability, "Search results MUST carry relation annotations", and is not restated here.)

`memory.search` and `memory.get` SHALL accept an OPTIONAL `relations_limit` integer that bounds the `relations` array projected per memory. Its DEFAULT SHALL be the surface's existing behaviour — 10 for `memory.search` result rows and for `memory.get`'s batch (`ids`) form, 50 for `memory.get`'s single (`id`) form — so a request that omits it receives exactly the annotations it receives today. Its MAXIMUM SHALL be a single shared value of 50 across all three surfaces, being the largest annotation bound the server already serves.

A `relations_limit` above the maximum SHALL be REJECTED as an invalid argument, not silently clamped, consistent with every other numeric bound on this surface (`limit` rejects above 200). Rejection is only safe if the caller is told how to stay inside the bound, so the parameter's description SHALL state: the default; that `relationsTotal` reports how many annotations exist; that the correct follow-up ask is therefore `min(relationsTotal, <maximum>)`; and that a larger value is rejected rather than clamped. A description that instructs the agent to pass a total which may exceed the maximum SHALL be treated as a defect — it is the failure this repo already fixed once, when a tool description documented passing `pendingJudgmentsTotal` into a parameter that rejected it for exactly the queues worth draining.

A per-row bound does not bound a response. `memory.search` accepts `limit` up to 200 and `memory.get` accepts up to 100 `ids`, each independent of `relations_limit`, so the two maxima multiply into a response the specification permitted and no requirement bounded. The multi-row surfaces SHALL therefore ALSO be bounded in aggregate: the product of the requested row count and the effective per-row annotation bound — `limit × effective relations bound` for `memory.search`, `ids.length × effective relations bound` for batch `memory.get` — SHALL NOT exceed a single named budget constant. The effective bound is the caller's `relations_limit` when supplied and the surface's default otherwise.

The budget SHALL be the largest annotation count the server already serves to a caller who passes nothing — the largest row count ANY branch serves for an omitted `limit`, times the multi-row default — so that no request relying on DEFAULTS can ever be rejected and the aggregate ceiling introduces no payload regime that is not already shipping. The check SHALL be applied to the EFFECTIVE row count — the number of rows the request would actually serve — and not to the value the caller declared. Where a branch substitutes its own page size for an omitted `limit`, budgeting against the declared value bounds nothing on that branch.

It follows that the budget is a TRADE rather than a reduction: a caller MAY spend it on many rows with few annotations each, or few rows with the maximum annotations each, and any combination whose product is within the budget SHALL be served.

A request whose product exceeds the budget SHALL be REJECTED with an invalid-argument error, on the same terms and for the same reason as an over-maximum `relations_limit`: silently serving fewer annotations than asked for would be indistinguishable from a complete list except by comparison against `relationsTotal`, which is the truncation-flag defect in a new place. The rejection SHALL name both parameters, the budget, and at least one legal combination, so the caller can comply in the same turn. Because the constraint spans two parameters it cannot be declared in a single field's schema; the `relations_limit` description SHALL therefore state that the two bounds are jointly limited and how to trade between them, and SHALL name single-id `memory.get` as the way to read one memory's annotations at the maximum.

Every response row carrying `relations` SHALL carry `relationsTotal` alongside it, on the same terms as `pendingJudgmentsTotal`: the count of annotations that exist for that memory, never the returned list's length restated. It SHALL be present whether or not the list was bounded. No companion boolean SHALL be added — truncation is `relationsTotal > relations.length`, and a redundant flag beside a total is duplicated state.

`relations_limit` SHALL NOT alter which memories a read returns, their order, or their scope — it bounds a per-row projection only, like `snippet` and `fields`. The aggregate budget SHALL likewise never change a served response: it either admits the request unchanged or rejects it. In particular the budget SHALL NOT be enforced by serving fewer annotations on some rows than on others, which would make a row's `relations` depend on the other rows in the page.

#### Scenario: The default is unchanged

- **WHEN** `memory.search` is called without `relations_limit`
- **THEN** each result row SHALL carry at most 10 annotations, exactly as before this parameter existed
- **AND** each row SHALL carry `relationsTotal`

#### Scenario: A caller raises the bound to the total it was told

- **GIVEN** a search whose result row reports `relationsTotal: 40` beside 10 annotations
- **WHEN** the caller repeats the search with `relations_limit: 40`
- **THEN** that row SHALL carry 40 annotations and `relationsTotal: 40`

#### Scenario: An over-ask is rejected, not clamped

- **WHEN** `memory.search` or `memory.get` is called with `relations_limit: 51`
- **THEN** the call SHALL fail with an invalid-argument error and SHALL NOT return a clamped result

#### Scenario: A request whose product exceeds the budget is rejected

- **WHEN** `memory.search` is called with the maximum `limit` and the maximum `relations_limit`, whose product exceeds the budget
- **THEN** the call SHALL fail with an invalid-argument error naming both parameters, the budget, and at least one legal combination
- **AND** no partial or reduced-annotation result SHALL be returned

#### Scenario: A default request is never rejected by the budget

- **WHEN** `memory.search` is called at the maximum `limit` without `relations_limit`, or `memory.get` is called with the maximum number of `ids` without `relations_limit`
- **THEN** the request SHALL be served, because the budget is derived from exactly that worst case

#### Scenario: The budget is spendable either way

- **GIVEN** a budget equal to the largest row count any branch serves for an omitted `limit`, times the multi-row default
- **WHEN** the caller asks for few rows with the maximum `relations_limit`, or for the maximum rows at the default annotation bound
- **THEN** both requests SHALL be served, and only a request whose product exceeds the budget SHALL be rejected

#### Scenario: The single-id deep read is unaffected by the budget

- **WHEN** `memory.get` is called with `id` and `relations_limit: 50`
- **THEN** the request SHALL be served, its product being one row times the maximum

#### Scenario: The description teaches the bounded ask

- **WHEN** an MCP client retrieves the tool description for `memory.search` or `memory.get`
- **THEN** the `relations_limit` description SHALL state its default, its maximum, that `relationsTotal` reports the true count, that the follow-up ask is `min(relationsTotal, <maximum>)`, and that a larger value is rejected rather than clamped
- **AND** it SHALL state that `relations_limit` and the row count are jointly bounded, how to trade between them, and that single-id `memory.get` reads one memory's annotations at the maximum

#### Scenario: Both `memory.get` forms agree with search

- **GIVEN** a memory carrying more annotations than 10
- **WHEN** it is read via `memory.search`, via `memory.get` with `ids`, and via `memory.get` with `id`
- **THEN** all three SHALL report the same `relationsTotal`, and each returned list SHALL be a prefix of the same ordered sequence of annotations, differing only in length according to that surface's default or the caller's `relations_limit` — and, for the `reason` field alone, in whether it is bounded (see "Relation annotation reasons MUST be bounded on multi-row reads")

#### Scenario: The bound does not affect selection

- **GIVEN** two searches differing only in `relations_limit`
- **WHEN** both are executed
- **THEN** they SHALL return the same memories in the same order, differing only in the length of each row's `relations` array

### Requirement: `memory.save` MUST report how many candidates its detection produced

A bounded list whose depth is invisible cannot be told from a complete one. `memory.save` returns `candidates[]` capped by `CANDIDATES_PER_SAVE_MAX`, so a caller today cannot distinguish five-of-five from five-of-fifteen, and the pairs beyond the cap have no `memory_relations` row and therefore no `judgmentId` — making them unreachable from `memory.judge`, from `memory.context.pendingJudgments[]`, and from `/dashboard/judgments`, which is a view over that table. (The detection behaviour itself, including why those pairs are deliberately not recorded, belongs to the `memory` capability, "`memory.save` MUST surface candidate conflicts at save-time", and is not restated here.)

`memory.save` SHALL therefore return `candidatesDetected: number` alongside `candidates[]` and `judgmentRequired`. It SHALL be the number of distinct candidate pairs the detection ranked BEFORE `CANDIDATES_PER_SAVE_MAX` was applied. It SHALL be present on every successful save response, whether or not the list was capped, so a caller never has to distinguish "nothing was cut" from "the field was omitted". Existing response fields SHALL be unchanged, and the per-candidate object SHALL NOT gain a field — the count describes the save, not a candidate.

The field SHALL be documented as a LOWER BOUND on how many memories in scope resemble the saved row, never as a scope-wide total, because each detection channel scans a bounded pool before ranking (see the `memory` capability's `CANDIDATE_POOL_SIZE`). It SHALL NOT be named with a `Total` suffix. That suffix is reserved for the true scoped counts this API already ships — `pendingJudgmentsTotal` and the relation-annotation total — and applying it to a floor would teach a caller that a `*Total` in this API may under-report. Equally it SHALL NOT be the returned list's length restated, which is the defect `predecessorCount` exhibits and which carries no information the caller did not already hold.

No companion boolean SHALL be added: truncation is `candidatesDetected > candidates.length`, and a redundant flag beside a number is duplicated state.

`memory.capture_passive` runs the same curation path per extracted learning (see "`memory.capture_passive` MUST use the same curation path as `memory.save`"), so its response SHALL also carry `candidatesDetected` — the SUM over the saves it performed — present on every successful response including one that extracted nothing, where it SHALL be 0. Two write paths through one pipeline SHALL NOT describe that pipeline differently.

When `CANDIDATES_PER_SAVE_MAX` is 0, detection does not run at all, and `candidatesDetected` SHALL be 0. The field reports what detection produced; with surfacing disabled there is nothing to report, and the operator who disabled it is the party reading the number.

Because the count is only actionable if the caller knows what to do with it, the `memory.save` tool description SHALL state:

1. what `candidatesDetected` counts, and that it is a lower bound rather than a total;
2. that only the entries in `candidates[]` carry `judgmentId`s and pending rows, so a high `candidatesDetected` is NOT a queue the agent has just created;
3. that a `candidatesDetected` substantially above the returned count usually means the topic wants converging under one `topic_key` (via `memory.suggest_topic_key`) rather than many separate judgments — the modelling fix, not the symptom;
4. that the unsurfaced remainder is re-derivable with `memory.search` and recordable per pair with `memory.compare`.

The description SHALL NOT name any request argument that raises the surfaced count, because none exists: the bound is the operator setting `CANDIDATES_PER_SAVE_MAX`, and the description SHALL say so. A description that instructs an agent to pass a value the input schema rejects SHALL be treated as a defect — it is the failure this repo already fixed once, when a tool description documented passing `pendingJudgmentsTotal` into a parameter that rejected it with an invalid-argument error for exactly the queues worth draining.

`candidatesDetected` SHALL NOT change which candidates are surfaced, their order, the rows written, or any input schema. No MCP tool input gains an argument, so no client change is required.

#### Scenario: A truncated save reports the larger number

- **GIVEN** `CANDIDATES_PER_SAVE_MAX = 5` and a save whose detection ranks 12 candidates
- **WHEN** `memory.save` returns
- **THEN** the response SHALL carry `candidates` with 5 entries, `judgmentRequired: true`, and `candidatesDetected: 12`

#### Scenario: An untruncated save still carries the field

- **WHEN** a save's detection ranks 2 candidates under a cap of 5
- **THEN** the response SHALL carry `candidates` with 2 entries and `candidatesDetected: 2`

#### Scenario: A save with no candidates reports zero

- **WHEN** a save's detection ranks no candidates
- **THEN** the response SHALL be `{ id, status, createdAt, candidates: [], judgmentRequired: false, candidatesDetected: 0 }`

#### Scenario: No companion truncation flag is returned

- **WHEN** any `memory.save` response is inspected
- **THEN** it SHALL NOT contain a boolean reporting whether the candidate list was truncated; that fact SHALL be derivable as `candidatesDetected > candidates.length`

#### Scenario: Only surfaced candidates create judgeable rows

- **GIVEN** a response carrying 5 candidates and `candidatesDetected: 12`
- **WHEN** the agent closes every `judgmentId` it received
- **THEN** exactly 5 judgments SHALL have existed to close, and no `judgmentId` SHALL exist for the other 7 pairs

#### Scenario: Surfacing disabled reports zero rather than a detected count

- **GIVEN** `CANDIDATES_PER_SAVE_MAX = 0`
- **WHEN** `memory.save` returns
- **THEN** the response SHALL carry `candidates: []`, `judgmentRequired: false` and `candidatesDetected: 0`

#### Scenario: `memory.capture_passive` reports the sum across its saves

- **GIVEN** a passive capture that extracts 3 learnings whose detections rank 4, 0 and 7 candidates respectively
- **WHEN** `memory.capture_passive` returns
- **THEN** the response SHALL carry `candidatesDetected: 11`

#### Scenario: `memory.capture_passive` extracting nothing reports zero

- **WHEN** `memory.capture_passive` finds no extractable section and saves nothing
- **THEN** the response SHALL carry `saved: 0` and `candidatesDetected: 0`

#### Scenario: The description teaches the actions and names no rejected ask

- **WHEN** an MCP client retrieves the tool description for `memory.save`
- **THEN** it SHALL state what `candidatesDetected` counts and that it is a lower bound; that only `candidates[]` carries `judgmentId`s; that a high value points at `topic_key` convergence via `memory.suggest_topic_key`; and that the remainder is re-derivable with `memory.search` and recordable with `memory.compare`
- **AND** it SHALL NOT instruct the agent to pass any argument raising the surfaced count, naming `CANDIDATES_PER_SAVE_MAX` as an operator setting instead

#### Scenario: The description stays under the client truncation ceiling

- **WHEN** the `memory.save` description is measured after the addition
- **THEN** its length SHALL remain below `DESCRIPTION_MAX_LENGTH` (see "Tool descriptions MUST stay below the client truncation ceiling")

#### Scenario: The field does not alter save behaviour

- **GIVEN** two identical saves against identical corpora, one on a build carrying the field and one on a build without it
- **WHEN** both complete
- **THEN** both SHALL return the same `candidates[]` in the same order and SHALL have written the same number of pending `memory_relations` rows

### Requirement: Relation annotation reasons MUST be bounded on multi-row reads

A judged annotation carries the judgment's `reason`, which `memory.judge` and `memory.compare`
accept at up to 2 000 characters. On a read that projects annotations for MANY memories that field
is the only term in an annotation that is not fixed-size, and it is multiplied by the row count.
It SHALL therefore be bounded on those reads, exactly as `memory.context` already bounds every
other stored-text projection it emits in a multi-item list.

On the multi-row annotation surfaces — `memory.search` result rows and the batch (`ids`) form of
`memory.get` — each judged annotation's `reason` SHALL be projected through the same truncation
semantics `memory.context` uses (slice to a named character bound and append an ellipsis when the
stored value is longer). The bound SHALL be a single named constant, applied identically at every
multi-row surface, so no two multi-row reads can disagree about how much of a reason they show.

The truncated value SHALL be a PREFIX of the stored value (plus the ellipsis marker), so a bounded
reason can never misrepresent the judgment by rearrangement or summary.

The single-id (`id`) form of `memory.get` SHALL project `reason` VERBATIM. It returns one memory,
so its annotation exposure is the per-row bound rather than the per-row bound times a page, and it
is the read a caller uses to drill into a specific memory — a bound there would make a stored
reason unreachable over MCP. The operator dashboard likewise SHALL continue to show the full
stored reason.

The bound SHALL be a read projection only. No stored `memory_relations.reason` SHALL be rewritten,
shortened or re-validated by this bound, and the input cap on `reason` SHALL NOT change.

#### Scenario: A long reason is bounded in search results

- **GIVEN** a judged annotation on memory M whose stored `reason` is 2 000 characters
- **WHEN** `memory.search` returns M
- **THEN** that annotation's `reason` SHALL be at most the named character bound, SHALL end with the
  ellipsis marker, and its leading characters SHALL match the stored value

#### Scenario: The deep read returns the reason verbatim

- **WHEN** `memory.get` is called with `id` for the same memory M
- **THEN** that annotation's `reason` SHALL be the stored 2 000-character value, untruncated

#### Scenario: Both multi-row surfaces bound it identically

- **WHEN** memory M is read via `memory.search` and via `memory.get` with `ids`
- **THEN** the same annotation's `reason` SHALL be identical in both responses

#### Scenario: A short reason is untouched

- **GIVEN** a judged annotation whose stored `reason` is shorter than the bound
- **WHEN** `memory.search` returns its memory
- **THEN** the returned `reason` SHALL be the stored value with no ellipsis appended

#### Scenario: The stored row is unchanged

- **GIVEN** any number of reads that bound the reason
- **WHEN** the `memory_relations` row is inspected
- **THEN** its `reason` column SHALL hold the full original text

### Requirement: The worst-case annotation payload MUST be bounded by a named ceiling asserted in CI

The annotation term of a response is entirely SCHEMA-derived: it is the product of the row bound
(`limit`, or `ids.length`), the per-row annotation bound, and the per-annotation size bound. A
product of declared bounds can be bounded in advance and MUST be, because a tool result larger
than the caller's context window is not a degraded answer but a guaranteed overflow of the context
the memory server exists to protect.

A single named constant SHALL express the maximum serialized size the annotation projection of any
LEGAL request may reach. A CI test SHALL assert it by constructing the largest legal request at
every annotation surface (`memory.search` rows, batch `memory.get`, single-id `memory.get`) against
a corpus of memories each carrying the maximum number of annotations at the maximum stored `reason`
length, invoking the real tools, and measuring the serialized `CallToolResult`. The measurement
SHALL count EVERY copy of the payload the result carries: the MCP result emits the payload both as
a `text` content block and as `structuredContent`, so a measurement of one copy understates the
transported size.

The ceiling SHALL be derived from that measurement and committed with it. It SHALL NOT be derived
by multiplying the constants, because such an assertion can pass while the serializer disagrees —
JSON indentation, key names and the differing pending/judged annotation shapes are not in the
arithmetic.

A later change that raises the row bound, the per-row annotation bound, the annotation reason bound
or the aggregate budget SHALL cause this assertion to fail rather than silently re-opening the
ceiling. Such a collision SHALL be resolved as an explicit decision — either the change fits under
the ceiling, or it raises the ceiling and records the re-measured worst case — and SHALL NOT be
resolved by weakening the measurement.

This requirement bounds the annotation term ONLY. A memory's `content` has no maximum at save and
is therefore data-derived, not schema-derived; no claim is made here that a response's total size is
bounded, and `snippet`, `fields` and `limit` remain the caller's instruments for that.

#### Scenario: The worst legal request stays inside the ceiling

- **WHEN** the largest legal `memory.search` request is issued against memories each carrying the
  maximum number of annotations at the maximum stored `reason` length
- **THEN** the serialized `CallToolResult`, counting both the `text` block and `structuredContent`,
  SHALL be within the named ceiling

#### Scenario: Every annotation surface is covered

- **WHEN** the CI assertion runs
- **THEN** it SHALL measure `memory.search` rows, batch `memory.get`, and single-id `memory.get`,
  each at its own largest legal request

#### Scenario: Raising a bound fails the assertion

- **GIVEN** a change that raises the per-row annotation bound, the aggregate budget, or the
  annotation reason bound so that the measured worst case exceeds the ceiling
- **WHEN** the test suite runs
- **THEN** the assertion SHALL fail, and the change SHALL either fit under the ceiling or raise it
  and record the re-measured worst case

### Requirement: `include_global` MUST be ignored unless the connection is authorized for global reads

`memory.search` accepts `include_global` to admit `global` rows into a project-scoped result. The argument SHALL take effect only where both the connection and the token permit it, and SHALL be silently ignored otherwise — never rejected, so a client that passes it habitually degrades to project-only results instead of failing.

Two independent conditions gate it:

1. **Connection.** On a path-scoped connection the argument SHALL be ignored regardless of token scope, per the existing strict-isolation requirement. That requirement's verb is "ignored", and this requirement does not weaken it: on a path-scoped connection a `*` token receives that project's rows only.
2. **Token.** On a connection that reached `project` scope through `project.use` rather than a path slug, the argument SHALL take effect only when the token authorizes a global read.

The gate SHALL apply uniformly to every branch the argument reaches — the ranked lexical branch, the dense branch, and the `entity` branch — so a single call cannot be widened through one path while narrowed through another. `memory.get` gains no widening from this requirement.

This requirement governs the widening argument only, and therefore cannot constrain a connection whose _base_ scope is already global. On a path-scoped connection the base scope can no longer be global: a slug that names no project is refused with `project_not_found` rather than resolved, per the strict-isolation requirement. The isolation guarantees above therefore hold for every path-scoped connection, resolvable or not.

#### Scenario: Path-scoped connection with a full-access token

- **GIVEN** a path-scoped connection at `/mcp/foo` whose slug resolves to an existing project, with a token whose scope is `*`, and at least one memory with `scope = 'global'`
- **WHEN** the client calls `memory.search` with `include_global = true`
- **THEN** the response SHALL contain no memory whose `scope = 'global'`

#### Scenario: Path-scoped connection whose slug names no project

- **GIVEN** a connection at `/mcp/no-such-project`, a token whose scope is `*`, and at least one memory with `scope = 'global'`
- **WHEN** the client calls `memory.search` with `include_global = true`
- **THEN** the call SHALL be refused with `code: 'project_not_found'` and the response SHALL contain no memory

#### Scenario: `project.use` scope with an authorized token

- **GIVEN** a path-less `/mcp` connection with a token whose scope is `*`, which has called `project.use({slug: 'foo'})`
- **WHEN** the client calls `memory.search` with `include_global = true`
- **THEN** global memories SHALL be returned alongside project `foo`'s own, and no other project's memories SHALL be returned

#### Scenario: `project.use` scope with a project-restricted token

- **GIVEN** a path-less `/mcp` connection with a token whose scope is `project:<id of foo>`, which has called `project.use({slug: 'foo'})`
- **WHEN** the client calls `memory.search` with `include_global = true`
- **THEN** the call SHALL succeed and the response SHALL contain no memory whose `scope = 'global'`

#### Scenario: The entity branch is gated identically

- **GIVEN** a global memory and a project memory both linked to the same entity value, on a path-scoped connection
- **WHEN** the client calls `memory.search` with that `entity` and `include_global = true`
- **THEN** only the in-scope project memory SHALL be returned

### Requirement: A `supersedes` verdict MUST be refused when either endpoint is no longer active

`supersedes` is the only verdict that rewrites the lifecycle of both memories it names: the target transitions to `superseded` and the source's `replaces[]` gains the target's id. That rewrite is only meaningful while both rows still represent live knowledge. The server SHALL therefore verify that the source AND the target are both `status = 'active'` before applying the side effect, and SHALL reject the call with structured code `conflict` otherwise, persisting nothing — neither the lifecycle flip nor the `memory_relations` transition that accompanies it.

The check SHALL apply to every entry point that can produce the verdict, `memory.judge` and `memory.compare` alike, including `memory.compare`'s update-in-place path over an already-judged row. The existing scenarios for those tools already state both endpoints as `active`; this requirement makes that precondition normative rather than incidental.

The check SHALL NOT apply where the requested end state already holds — the target is already `superseded` and the source's `replaces` already names it. Re-applying that is a no-op, not the rewrite this requirement guards, and `memory.compare` is specified as last-call-wins and carries `idempotentHint: true`, so an identical retry SHALL succeed rather than raise `conflict`.

The `topic_key` upsert path is unaffected because it does not reach this check at all: the `memory_relations` row with `marked_by_kind = 'agent_topic_key'` is written by `memory.save` inside the SAME transaction as the insert and the supersede, as the `memory` capability already requires, rather than by a follow-up verdict.

No other relation SHALL be constrained this way. `not_conflict`, `conflicts_with`, `duplicate`, `related`, `compatible` and `scoped` SHALL remain closable when either endpoint has been retired, because they record an observation about a pair rather than rewriting it — and because a `not_conflict` dismissal recorded against a retired source is deliberately carried forward to every later revision of the topic through the `replaces` ancestry, so refusing it would discard suppression the `memory` capability specifies and leave the pair to orphan with no verdict at all.

#### Scenario: Judging supersedes from a retired source

- **GIVEN** a pending row J whose source S has `status = 'superseded'` and whose target L has `status = 'active'`
- **WHEN** the agent calls `memory.judge({judgmentId: J, relation: 'supersedes'})`
- **THEN** the call SHALL be rejected with code `conflict`, L SHALL remain `active`, S's `replaces` SHALL be unchanged, and J SHALL remain `pending`

#### Scenario: Judging supersedes against a retired target

- **GIVEN** a pending row J whose source S has `status = 'active'` and whose target T has `status = 'archived'`
- **WHEN** the agent calls `memory.judge({judgmentId: J, relation: 'supersedes'})`
- **THEN** the call SHALL be rejected with code `conflict` and nothing SHALL be persisted

#### Scenario: Other verdicts stay closable on a retired pair

- **GIVEN** a pending row J whose source S has `status = 'superseded'`
- **WHEN** the agent calls `memory.judge({judgmentId: J, relation: 'not_conflict'})`
- **THEN** the call SHALL succeed and J SHALL transition to `status = 'judged'` with `relation = 'not_conflict'`

#### Scenario: A topic_key upsert records its audit relation atomically

- **GIVEN** an active memory M holding `topic_key = 't'`
- **WHEN** `memory.save` is called with the same `topic_key = 't'`
- **THEN** within that one save transaction M SHALL transition to `superseded`, the new row N SHALL carry M's id in `replaces`, and a `memory_relations` row SHALL exist with source N, target M, `relation = 'supersedes'`, `status = 'judged'` and `marked_by_kind = 'agent_topic_key'` — with no follow-up verdict, so this requirement's check is never consulted

#### Scenario: Re-applying a supersede that already holds

- **GIVEN** an `active` memory N whose `replaces` names M, and M with `status = 'superseded'`
- **WHEN** the caller invokes `memory.compare({sourceId: N, targetId: M, relation: 'supersedes'})` again
- **THEN** the call SHALL succeed, M SHALL remain `superseded`, and N's `replaces` SHALL be unchanged

#### Scenario: `memory.compare` is refused on the same terms

- **GIVEN** an `active` memory L and a `superseded` memory S in the same scope
- **WHEN** the caller invokes `memory.compare({sourceId: S, targetId: L, relation: 'supersedes'})`, whether or not a judged row for that pair already exists
- **THEN** the call SHALL be rejected with code `conflict`, L SHALL remain `active`, and no `memory_relations` row SHALL be inserted or updated

### Requirement: MCP error messages MUST NOT instruct the agent to perform an action it cannot perform

An error message on the MCP surface is read by an agent that will act on it, so a message naming an unreachable remedy costs a wasted turn and, worse, teaches the agent a false model of its own connection. Every structured error message SHALL name only remedies reachable by the party it addresses, and SHALL NOT contradict the `instructions` block delivered on the same connection.

Two consequences are normative:

- The `scope_locked` message returned for `memory.save({scope: 'global'})` on a path-scoped connection SHALL NOT instruct the agent to open a second MCP connection. An agent cannot: each client has one MCP entry and the bridge derives its URL path from the project's `.rembric` file, so only the operator can add another. The message SHALL name the bound project (as already required), SHALL state that user-wide memory is not reachable on this connection, in agreement with the path-scoped `instructions` note, and SHALL name a remedy the agent or the operator can actually apply.
- The `forbidden` message returned when a token pinned to exactly one project is denied a global-scope action on a path-less connection SHALL name the way out — activating that project with `project.use({slug})`, or reconnecting at `/mcp/<slug>`. Naming only the token scope and the denied target reads as a misconfigured token and hides a one-call fix. This requirement changes no authorization outcome: the denial itself is correct and unchanged.

#### Scenario: `scope_locked` does not promise a second connection

- **GIVEN** a path-scoped connection at `/mcp/foo`
- **WHEN** the client calls `memory.save` with `scope='global'`
- **THEN** the error message SHALL contain the bound project's slug
- **AND** the message SHALL NOT instruct opening or connecting to a second MCP connection
- **AND** the message SHALL state that user-wide memory is not reachable on this connection

#### Scenario: `scope_locked` agrees with the connection's own instructions

- **WHEN** the path-scoped `instructions` variant and the `scope_locked` message are compared for the same connection
- **THEN** neither SHALL assert that user-wide memory is reachable from this connection

#### Scenario: A project-pinned token on a path-less connection is told the remedy

- **GIVEN** a path-less `/mcp` connection with a token whose scope is `project:<id of foo>` and no active project
- **WHEN** the client calls `memory.context` or `memory.search`
- **THEN** the call SHALL be refused with `code: 'forbidden'` (unchanged)
- **AND** the message SHALL name `project.use` and SHALL name the slug `foo`

#### Scenario: A full-access token's denial message is unaffected

- **GIVEN** a path-less `/mcp` connection with a token whose scope is `read:*`
- **WHEN** the client calls a write-classified tool
- **THEN** the refusal SHALL carry `code: 'forbidden'` and the message SHALL NOT suggest `project.use`, since no project pin exists to activate

### Requirement: A tool's description and its response MUST agree, and neither may promise an unreachable state

An MCP tool description is read by the model on every call and is the only contract most agents ever see. It SHALL NOT teach a state the tool cannot produce, SHALL NOT present as closed an enumeration of the response that omits a field the tool always returns, and SHALL NOT offer a cause for an observable divergence that is not the actual cause. Equivalently: the description, the declared `outputSchema` and the emitted payload SHALL agree, and where they disagree the disagreement is a defect regardless of which of the three is wrong.

Three failure modes are in scope, and an instance SHALL be classified as one of them before it is fixed, because the correct remedy differs:

1. **A field reporting an unreachable state.** Where a tool's declared input schema REJECTS an out-of-range argument, the response SHALL NOT carry a field whose purpose is to report the out-of-range handling that therefore never occurs; likewise a field SHALL NOT be published whose only other value is reachable solely in a state where the tool cannot answer at all. A field that can hold one value forever carries no information and costs a line of the model's attention on every call.
2. **A description that misstates the response.** A closed-form enumeration ("Returns: { … }") SHALL name every field the `outputSchema` marks required. Where a required field answers the question the tool exists to answer, omitting it from the description is the more severe form of this defect, not the milder one.
3. **A description whose stated cause is not the actual cause.** Where a description explains why two surfaces report different numbers, it SHALL name every cause that can produce the divergence. Naming one of two causes is worse than naming none, because a reader who checks the named cause and finds it inapplicable concludes that one of the two numbers is stale.

An instance SHALL be closed in ONE of exactly three ways, and the change closing it SHALL state which:

- **Remove the field or claim** — appropriate when no reachable meaning exists that does not require relaxing the bound the input schema enforces. Relaxing a bound in order to make a clamp-receipt field reachable SHALL NOT be treated as an available option; rejection rather than clamping is the surface-wide rule (see "`memory.search` and `memory.get` MUST expose the annotation bound and its true total").
- **Correct the description** — appropriate when the payload is right and the text is wrong.
- **Correct the CODE** — appropriate when the description states the intended contract and a code path fails to honour it. A description SHALL NOT be weakened to match a defective implementation; where the two disagree, which one moves is a decision the change SHALL record.

Where the remedy is removing a field, the change SHALL take it out of the tool's declared `outputSchema` AND out of the emitted payload together, because the MCP SDK validates `structuredContent` against the schema published at registration: dropping only the key fails output validation, and dropping only the schema entry publishes an undeclared key.

Where the boundary rejects, the tool description SHALL teach the bound rather than promise a receipt. It SHALL name the maximum of every bounded numeric argument it accepts and SHALL state that a larger value is rejected rather than clamped — the same safety condition the annotation-bound requirement states as "Rejection is only safe if the caller is told how to stay inside the bound". `memory.timeline` is the model to match: its handler rejects an over-budget combined window AND names the remedy in the error message, referring the caller to `memory.search`.

Every obligation in this requirement SHALL be discharged in the tool's top-level description text and SHALL NOT be expressed only in a per-argument zod `describe()`, which some clients do not surface to the model. Every obligation SHALL be satisfied within `DESCRIPTION_MAX_LENGTH` (see "Tool descriptions MUST stay below the client truncation ceiling"); where content must be reclaimed, the reclaimed clause SHALL be named by the change that removes it.

An in-process bound sitting behind the rejecting boundary MAY be retained as a defensive clamp for a future direct caller that bypasses the input schema. Retaining it SHALL NOT be treated as a violation: a bound with nothing reporting on it makes no claim to the agent. What this requirement forbids is the CLAIM, not the clamp.

#### Scenario: `memory.get`'s two forms carry the same review signal

- **GIVEN** one `active` in-scope memory whose derived `reviewState` is `'needs_review'`
- **WHEN** an MCP client calls `memory.get({ id })` and `memory.get({ ids: [id] })` on the same connection for that same row
- **THEN** both responses SHALL carry `reviewState`, `reviewAfter` and `reviewEscalated` for it, with equal values
- **AND** the `memory.get` description's unconditional promise of that metadata SHALL hold for both forms, since it distinguishes neither
- **AND** the remedy for a divergence here SHALL be to compute the metadata on the deficient path, NOT to qualify the description

#### Scenario: `memory.session_start`'s description names every required output field

- **WHEN** an MCP client reads the `memory.session_start` description from a real `tools/list` response and its declared `outputSchema`
- **THEN** every field the `outputSchema` marks required SHALL be named in the description
- **AND** the description SHALL state what `reused` means, because it is the field that answers whether the call adopted the host's session or started a second one

#### Scenario: `memory.doctor`'s description names both causes of the divergence

- **WHEN** an MCP client reads the `memory.doctor` description from a real `tools/list` response
- **THEN** it SHALL name both causes by which its counters diverge from `memory.stats`': the population, and — for the pending-judgment counter specifically — the adjudicability filter
- **AND** naming only the population SHALL NOT satisfy this scenario, because a reader who confirms both calls resolve to one project would then conclude a number is stale

#### Scenario: `memory.context` and `memory.search_prompts` publish no clamp receipt

- **GIVEN** every bounded numeric argument of both tools is rejected above its maximum by the declared input schema
- **WHEN** an MCP client reads each tool's `outputSchema` from `tools/list` and then calls it
- **THEN** neither `outputSchema`'s `required` list SHALL contain `clamped`, and neither returned `structuredContent` SHALL contain a `clamped` key
- **AND** this SHALL hold for a call with no arguments and for a call passing every bounded argument at its maximum

#### Scenario: `memory.doctor` publishes no field whose false value is unreachable

- **GIVEN** the report can only be produced on a request that already read the database to authenticate
- **WHEN** an MCP client calls `memory.doctor`
- **THEN** the report SHALL NOT carry a `db.open` field, whose `false` value is reachable only in a state where the call cannot be served at all
- **AND** a database fault that does not prevent the call SHALL be reported through `warnings` and `db.integrity`, which do vary

#### Scenario: The over-max argument is rejected and the maximum itself is accepted

- **WHEN** each bounded numeric argument of `memory.context`, `memory.search_prompts` and `memory.timeline` is passed above its maximum, each in its own call
- **THEN** every such call SHALL be rejected as an invalid argument and SHALL NOT return a payload
- **AND** the same argument passed AT its maximum SHALL succeed — without that control a rejection cannot be distinguished from a broken probe

#### Scenario: Each description teaches every bound its tool enforces

- **WHEN** the descriptions of `memory.context`, `memory.search_prompts` and `memory.timeline` are read from a real `tools/list` response
- **THEN** each SHALL name the maximum of every bounded numeric argument it accepts
- **AND** each SHALL state that a value above a maximum is rejected rather than clamped
- **AND** none SHALL state that the response carries a flag reporting a clamp, nor list such a field in the response shape it advertises
- **AND** a CI test SHALL assert these substrings against the live `tools/list` string, so a reintroduction fails the build

#### Scenario: A newly found instance is closed by one of the three remedies

- **GIVEN** a tool is found whose description, `outputSchema` and payload do not agree
- **WHEN** the defect is addressed
- **THEN** the change SHALL classify it as one of the three failure modes and apply the corresponding remedy
- **AND** keeping the disagreement SHALL NOT satisfy this requirement, whether or not the description is partially corrected
- **AND** the closing change SHALL be recorded as a scenario of this requirement rather than as a new requirement, so the rule stays stated once
