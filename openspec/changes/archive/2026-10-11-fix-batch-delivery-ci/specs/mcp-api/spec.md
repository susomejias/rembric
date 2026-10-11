## MODIFIED Requirements

### Requirement: The MCP server MUST expose three research tools

The `/mcp` and `/mcp/<slug>` endpoints SHALL register `memory.context`, `memory.timeline`, and `memory.capture_passive` with the following contracts. Note that `memory.save_prompt` (write side) and `memory.search_prompts` (read side) are registered in their own dedicated requirements; this requirement scopes the research/context tools only.

Both of `memory.context`'s queue channels SHALL be returned with the scoped TOTAL of the queue they page, because a page whose depth is invisible cannot be told from an exhausted queue. `needsReview` has carried `needsReviewTotal` since it was introduced; `pendingJudgments` SHALL carry `pendingJudgmentsTotal` on the same terms.

Both of those pending channels SHALL be restricted to ADJUDICABLE pairs — a pending relation whose source AND target are both `status = 'active'` (see the `memory` capability, "A pending judgment MUST be withheld from the agent queue once either endpoint is retired"). The list and the total SHALL apply that restriction identically, so the total remains the depth of the queue the list pages rather than a depth the list can never reach.

`memory.context`'s four size arguments are bounded by its declared input schema — `sessions` 25, `prompts` 50, `memories` 100, `judgments` 50 — and a value above a maximum SHALL be REJECTED as an invalid argument rather than silently clamped, consistent with every other numeric bound on this surface (see "`memory.search` and `memory.get_batch` MUST expose the annotation bound and its true total"). Because no clamping can occur over the transport, the response SHALL NOT carry a field reporting that an argument was clamped (see "A tool's description and its response MUST agree, and neither may promise an unreachable state"). The handler MAY retain an in-process clamp as a defensive bound for a future direct caller that bypasses the input schema; such a clamp is unobservable over the transport and SHALL NOT be reported in the response.

#### Scenario: `memory.context` returns a bootstrap snapshot

- **WHEN** an MCP client calls `memory.context` with `{ sessions?: number, prompts?: number, memories?: number, judgments?: number, includeArchived?: boolean }`
- **THEN** the server SHALL return `{ scope, recentSessions, recentPrompts, recentMemories, relevantMemories, pendingJudgments, pendingJudgmentsTotal, needsReview, needsReviewTotal }` — where `scope` is the resolved scope label, as on `memory.stats` — plus `rankedPass` when the ranked pass executed (see "`memory.context` MUST offer a relevance channel alongside recency"), with each list scoped to the request context (the connection's one project)
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
- **WHEN** an MCP client scoped to project A calls `memory.context`
- **THEN** `pendingJudgmentsTotal` SHALL NOT count it

#### Scenario: `needsReview` is unary and disjoint from `pendingJudgments`

- **GIVEN** a scope containing one `active` memory past its review shelf life AND one aged pending relation between two other memories
- **WHEN** an MCP client calls `memory.context`
- **THEN** the stale single memory SHALL appear only in `needsReview` (carrying `id`, not `sourceId`/`targetId`) and the aged relation SHALL appear only in `pendingJudgments` — no entry SHALL appear in both lists

#### Scenario: `needsReview` respects scope

- **GIVEN** an `active` memory past its review shelf life that belongs to project B
- **WHEN** an MCP client calls `memory.context` on a connection scoped to project A
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

### Requirement: Memory-returning reads MUST expose the entities a memory is about

An agent that receives a memory SHALL be able to see what it is about, so it can pivot to related knowledge without guessing a query. The three primary memory-returning reads — `memory.search` result rows, batch `memory.get`, and single-id `memory.get` — SHALL include an `entities[]` field listing the entities linked to each memory, each with its kind. The list SHALL be bounded per memory so a content-heavy row cannot inflate a response.

**Scoped to those three deliberately.** `memory.search`'s relation-expansion rows (`expanded[]`) are a fourth surface that returns whole memories and carries no `entities[]` today. The previous wording said "memory-returning reads" without qualification and therefore overclaimed: the shipped repo has never satisfied it for `expanded[]`. The requirement is narrowed to what is true rather than left asserting what is not, and extending the projection to `expanded[]` — which would add a per-turn repository read for up to `RELATION_EXPANSION_CAP` rows on the hottest path — is a scoped decision, not a wording fix. `memory.context` is out of scope for a different reason: it projects no per-memory entity list at all, only an `entities.backlog` diagnostics counter.

**When the bound binds** (`entitiesTotal` exceeds it), the bound SHALL be applied to an order that reflects the memory's own entity composition, not the spelling of a kind name: max-min fair share across the kinds linked to the memory, so every kind present contributes one entity before any kind contributes a second, and the remaining slots fall to the kinds that have more. Consequently a kind linked to the memory SHALL NOT be absent from the projection while another kind occupies two or more slots.

**When the bound does not bind, the projection SHALL be the repository's `(kind, value)` order, unchanged.** This is the case on the overwhelming majority of rows (measured: the bound binds on 2 of 285 production-shaped documents), nothing is withheld, so there is no selection to make fair — and re-interleaving a complete list would change what every existing caller sees to no end. The two paths therefore differ in ORDER, not in membership, and only above the bound.

No kind SHALL be declared to outrank another. The ordering carries no precedence claim: which entity is the better pivot depends on the question being asked and that question is not in the row. Note the one residue this does not remove — when equal-sized kinds compete for a surplus slot, the slot goes to the kind whose name sorts first, so `path` beats `url` at identical counts. That is inherited from the extraction budget's allocator, is reachable with as few as three kinds, and is a far smaller effect than the whole-kind eviction this requirement fixes; it is recorded rather than claimed away.

Within a kind the entities SHALL be ordered by value, and the whole order SHALL be total: two identical reads over unchanged data SHALL return the same entities in the same order. `(kind, value)` is unique per memory, so no tie can be left to scan order.

The bound's effect SHALL be reported as a COUNT, not as an indication that it was hit. Each memory carrying `entities[]` SHALL also carry `entitiesTotal: number` — how many entities are linked to that memory in scope, taken before the bound is applied. It SHALL be present whether or not the bound was reached, so a caller never has to distinguish "nothing was cut" from "the field was omitted", and it SHALL NOT be the returned array's length restated. The count SHALL be unaffected by the ordering: reordering the projection changes which entities are returned, never how many exist.

No companion boolean SHALL be returned: truncation is `entitiesTotal > entities.length`, and a flag beside the number is duplicated state that can disagree with itself. This mirrors the relation-annotation total (see "`memory.search` and `memory.get_batch` MUST expose the annotation bound and its true total"), deliberately, so the two projections describe their bounds the same way.

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

### Requirement: A tool's description and its response MUST agree, and neither may promise an unreachable state

An MCP tool description is read by the model on every call and is the only contract most agents ever see. It SHALL NOT teach a state the tool cannot produce, SHALL NOT present as closed an enumeration of the response that omits a field the tool always returns, and SHALL NOT offer a cause for an observable divergence that is not the actual cause. Equivalently: the description, the declared `outputSchema` and the emitted payload SHALL agree, and where they disagree the disagreement is a defect regardless of which of the three is wrong.

Three failure modes are in scope, and an instance SHALL be classified as one of them before it is fixed, because the correct remedy differs:

1. **A field reporting an unreachable state.** Where a tool's declared input schema REJECTS an out-of-range argument, the response SHALL NOT carry a field whose purpose is to report the out-of-range handling that therefore never occurs; likewise a field SHALL NOT be published whose only other value is reachable solely in a state where the tool cannot answer at all. A field that can hold one value forever carries no information and costs a line of the model's attention on every call.
2. **A description that misstates the response.** A closed-form enumeration ("Returns: { … }") SHALL name every field the `outputSchema` marks required. Where a required field answers the question the tool exists to answer, omitting it from the description is the more severe form of this defect, not the milder one.
3. **A description whose stated cause is not the actual cause.** Where a description explains why two surfaces report different numbers, it SHALL name every cause that can produce the divergence. Naming one of two causes is worse than naming none, because a reader who checks the named cause and finds it inapplicable concludes that one of the two numbers is stale.

An instance SHALL be closed in ONE of exactly three ways, and the change closing it SHALL state which:

- **Remove the field or claim** — appropriate when no reachable meaning exists that does not require relaxing the bound the input schema enforces. Relaxing a bound in order to make a clamp-receipt field reachable SHALL NOT be treated as an available option; rejection rather than clamping is the surface-wide rule (see "`memory.search` and `memory.get_batch` MUST expose the annotation bound and its true total").
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
