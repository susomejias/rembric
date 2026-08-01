## MODIFIED Requirements

### Requirement: The MCP server MUST expose three research tools

The `/mcp` and `/mcp/<slug>` endpoints SHALL register `memory.context`, `memory.timeline`, and `memory.capture_passive` with the following contracts. Note that `memory.save_prompt` (write side) and `memory.search_prompts` (read side) are registered in their own dedicated requirements; this requirement scopes the research/context tools only.

Both of `memory.context`'s queue channels SHALL be returned with the scoped TOTAL of the queue they page, because a page whose depth is invisible cannot be told from an exhausted queue. `needsReview` has carried `needsReviewTotal` since it was introduced; `pendingJudgments` SHALL carry `pendingJudgmentsTotal` on the same terms.

Both of those pending channels SHALL be restricted to ADJUDICABLE pairs — a pending relation whose source AND target are both `status = 'active'` (see the `memory` capability, "A pending judgment MUST be withheld from the agent queue once either endpoint is retired"). The list and the total SHALL apply that restriction identically, so the total remains the depth of the queue the list pages rather than a depth the list can never reach.

#### Scenario: `memory.context` returns a bootstrap snapshot

- **WHEN** an MCP client calls `memory.context` with `{ sessions?: number, prompts?: number, memories?: number, judgments?: number, includeArchived?: boolean }`
- **THEN** the server SHALL return `{ recentSessions, recentPrompts, recentMemories, pendingJudgments, pendingJudgmentsTotal, needsReview, needsReviewTotal }`, with each list scoped to the request context (global vs path-scoped project)
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

- **WHEN** the caller passes `sessions > 25`, `prompts > 50`, `memories > 100`, or `judgments > 50`
- **THEN** the server SHALL silently clamp to the maximum and SHALL include a `clamped: true` field in the response
- **AND** `judgments` SHALL be bounded on the same terms as its three siblings — including the declared input-schema maximum, which over the MCP transport rejects an out-of-range value with `invalid_input` BEFORE the handler's clamp is reached, so the `clamped` flag is the in-process defence rather than the wire behaviour. This layering is pre-existing and identical for all four arguments; `judgments` SHALL NOT introduce a different one
- **AND** a `judgments` value at or below 50 that exceeds the number of pending relations in scope SHALL return every one that exists, with `clamped` false — asking for more than the queue holds is not an error

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
- **AND** the description SHALL satisfy `DESCRIPTION_MAX_LENGTH` (see "Tool descriptions MUST stay below the client truncation ceiling"); if the clause does not fit, prose SHALL be cut from the description rather than the constant raised

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
