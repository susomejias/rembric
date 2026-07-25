## MODIFIED Requirements

### Requirement: Memory retrieval MUST expose history

`memory.get(id)` SHALL return the memory along with its ancestry: the predecessors reachable via `replaces`, the count of AFFIRMING confirmations against the current head, AND the set of judged relations involving the memory (sourced from `memory_relations`).

The ancestry projection is bounded and content-free — see "Supersedes-chain reads MUST be bounded and content-free", which governs it: each predecessor is `{id, title, status, createdAt}`, the traversal stops at a compile-time cap, and the response reports `predecessorCount` and `truncated`. "Full ancestry" therefore means "every predecessor up to the cap, identified but not quoted": a caller that needs a predecessor's content fetches it by id, which is what the batch read exists for. Predecessor **content snapshots** SHALL NOT be returned, because a deep `topic_key` chain would otherwise multiply one call's token cost by its own history.

#### Scenario: Retrieving a merged memory

- **WHEN** `memory.get('M')` is called and M was formed by merging A and B
- **THEN** the response SHALL include the content of M, the predecessor projections for `['A','B']` (id, title, status, createdAt — no content), the current affirmation count for M, and a `relations` array containing the `supersedes` entries for A and B

#### Scenario: Retrieving a memory with a pending judgment

- **GIVEN** memory N was just saved and a candidate-detection step inserted a `memory_relations` row with `status = 'pending'` referencing memory M
- **WHEN** `memory.get('N')` is called
- **THEN** the response's `relations` array SHALL include `{ kind: 'pending_conflict', targetId: 'M', judgmentId, status: 'pending' }`

### Requirement: Recall MUST be able to return nothing

The text-query branch SHALL be able to report that it found nothing relevant, rather than always returning the highest-scoring available rows. A confidently-irrelevant result is worse than an empty one, because the calling agent has no signal to distrust it and will treat it as established project knowledge.

Abstention SHALL be decided by two bounded arithmetic gates over scores the system already computes. The two gates read DIFFERENT score spaces, and the difference is load-bearing rather than incidental, so it is stated here:

- The **floor** is absolute and applies to the best per-branch normalised retrieval score (the higher of the lexical and dense branch bests) BEFORE fusion. Fused RRF scores are a function of rank position, not of match quality, so a floor applied after fusion would measure the shape of the result list rather than its relevance.
- The **gap ratio** is a tail filter over the final fused-and-boosted list, evaluated between CONSECUTIVE rows: the list is truncated at the first position where `next/current` falls below the ratio. It is not a fraction of the best score — a per-best test would keep a long flat tail whose every member is individually far from the leader, which is the case the filter exists to cut.

The response SHALL carry an explicit abstention flag and reason when the floor rejects everything.

Both gates SHALL be disabled by default and SHALL be enabled only with values calibrated against the evaluation harness, because an uncalibrated floor silently removes recall.

#### Scenario: A query with nothing relevant abstains

- **GIVEN** abstention is enabled with calibrated values, and a scope whose memories are all unrelated to the query
- **WHEN** `memory.search` is called
- **THEN** the response SHALL contain no results and SHALL report abstention with a reason

#### Scenario: A sharp query returns a short result set

- **GIVEN** abstention is enabled, and a scope containing one strongly-matching memory and several weak ones
- **WHEN** `memory.search` is called with a limit larger than one
- **THEN** the list SHALL be truncated at the first consecutive-pair drop below the gap ratio, and the response SHALL NOT be padded to the requested limit

#### Scenario: The two gates are not evaluated in the same score space

- **WHEN** the floor and the gap ratio are both enabled
- **THEN** the floor SHALL be compared against a pre-fusion normalised branch score and the gap ratio against post-fusion, post-boost scores, and neither value SHALL be interpreted as a threshold on the other's scale

#### Scenario: Abstention is off by default

- **WHEN** the system runs without calibrated abstention values configured
- **THEN** the text-query branch SHALL behave exactly as it does today, returning up to the requested limit

### Requirement: Active memories MUST expose a derived review state

Each memory with `status = 'active'` SHALL expose a **derived, read-time-only** review state on retrieval. The state is computed, never stored: no column SHALL be added to `memory`, and no row SHALL be mutated to record it.

For an `active` memory of type `T`:

- `reviewBaseline` SHALL be `max(created_at, latest AFFIRMING confirmation event_ts)` — the last time the memory was **affirmed** (its own creation, or a `memory.confirm` with verdict `affirm` recorded against the head of its supersedes chain). A refuting confirmation SHALL NOT advance it. `last_seen_at` SHALL NOT be used as the baseline: it is the ACCESS signal, advanced by dereferencing a memory (`memory.get` on a single id), by an affirming `memory.confirm`, and by an operator undoing a decay archival — never by a search returning a row, and never by the batch `memory.get({ids})` form. Access and affirmation are different facts about a memory, which is the whole reason the two axes exist.
- `reviewAfter` SHALL be `reviewBaseline + REVIEW_TTL_MS[T]` when `REVIEW_TTL_MS` has an entry for `T`, and `null` otherwise.
- `reviewState` SHALL be `'needs_review'` when `reviewAfter` is non-null AND `reviewAfter <= now`; otherwise `'fresh'`.
- A refutation newer than `reviewBaseline` SHALL force `reviewState = 'needs_review'` regardless of `T`'s TTL, and `reviewAfter` SHALL then report the refutation's timestamp.

`REVIEW_TTL_MS` SHALL be a per-`type` shelf-life map exported from a single source (`apps/server/src/services/review.ts`). A type with no entry SHALL never produce `needs_review` on the clock. The shelf life is a soft re-verification nudge, not a hard expiry: a `needs_review` memory SHALL remain `active` and SHALL be unaffected in ranking, scope isolation, or decay eligibility.

Memories whose `status` is `superseded` or `archived` SHALL NOT carry a review state (`reviewState` is omitted / null for them).

The time derivation SHALL live in one pure function (`deriveReviewState`) so it is independently unit-testable and so the read projection and the scoped `needsReview` query agree by construction.

#### Scenario: A freshly created memory is fresh

- **GIVEN** an `active` memory of a type that has a `REVIEW_TTL_MS` entry, created `now`, with no confirmations
- **WHEN** its review state is derived at `now`
- **THEN** `reviewAfter` SHALL equal `created_at + REVIEW_TTL_MS[type]` and `reviewState` SHALL be `'fresh'`

#### Scenario: An unaffirmed memory past its shelf life needs review

- **GIVEN** an `active` memory whose `reviewBaseline` is older than `now - REVIEW_TTL_MS[type]` and which has no confirmation newer than that baseline
- **WHEN** its review state is derived at `now`
- **THEN** `reviewState` SHALL be `'needs_review'`

#### Scenario: Confirming a memory clears needs_review

- **GIVEN** an `active` memory currently deriving `reviewState = 'needs_review'`
- **WHEN** `memory.confirm` records an affirming confirmation event at `now`
- **THEN** the next derivation SHALL use `reviewBaseline = now`, yielding `reviewAfter = now + REVIEW_TTL_MS[type]` and `reviewState = 'fresh'`
- **AND** no `memory` row SHALL have been mutated to achieve this (the confirmation is the only write, plus the access-signal touch that an affirmation carries)

#### Scenario: Reading a memory does NOT clear needs_review

- **GIVEN** an `active` memory deriving `reviewState = 'needs_review'`
- **WHEN** the memory is dereferenced via `memory.get({id})` (which advances `last_seen_at`), fetched via `memory.get({ids})` (which does not), or returned by `memory.search` (which does not)
- **THEN** its derived `reviewState` SHALL remain `'needs_review'` in all three cases — access does not count as affirmation, whether or not the read advanced the access signal

#### Scenario: A type without a TTL never needs review on the clock

- **GIVEN** an `active` memory whose `type` has no `REVIEW_TTL_MS` entry, created arbitrarily long ago, never confirmed and never refuted
- **WHEN** its review state is derived
- **THEN** `reviewAfter` SHALL be `null` and `reviewState` SHALL be `'fresh'`

#### Scenario: A refuted TTL-less memory still needs review

- **GIVEN** an `active` `reference` memory (no TTL) that has been refuted since its affirmation baseline
- **WHEN** its review state is derived
- **THEN** `reviewState` SHALL be `'needs_review'` and `reviewAfter` SHALL be the refutation's timestamp

#### Scenario: Non-active memories carry no review state

- **GIVEN** a memory with `status = 'superseded'` or `status = 'archived'`
- **WHEN** it is retrieved
- **THEN** `reviewState` SHALL be omitted (or null) and `reviewAfter` SHALL be omitted

### Requirement: The system MUST accept a negative affirmation, recorded append-only

The only affirmation verb today is positive, and autonomous archival is deliberately forbidden. An agent that surfaces a memory, acts on it, and discovers it is stale or wrong therefore has no way to record that — while the act of retrieving it has advanced its access signal, making it more durable than an untouched memory. The system SHALL accept a refutation against a memory, recorded as an append-only event carrying the refuting agent's reason.

A refutation SHALL NOT advance the memory's access signal, SHALL NOT mutate or delete the memory, and SHALL NOT itself archive it. It SHALL be an input to the read-time derivation of review state, so review state remains derived and never stored.

Its consequences for the review queue SHALL be exactly these:

- A refuted memory SHALL surface in the review queue immediately, whatever its type's shelf life and whether or not its type has one.
- A refutation SHALL NOT advance the affirmation baseline. Refuting is not affirming, so the ordering signal the queue uses to find the least-recently-affirmed memory SHALL be untouched by it.
- Because the baseline is untouched, a freshly-refuted memory would sort LAST under baseline ordering — so the queue SHALL surface refuted rows ahead of merely-expired ones, bounded as the sibling requirement specifies.
- An affirming `memory.confirm` newer than the refutation SHALL clear the state: the baseline advances past the refutation and the memory derives `fresh` again. That is the ONLY way a refuted memory leaves the queue short of being superseded or archived — there is no second verb, and reading it does not clear it.
- Affirmation counts SHALL count affirming events only, so a refutation never inflates the confidence signal that decay reads.

#### Scenario: A refuted memory needs review immediately

- **GIVEN** an active memory whose derived review state is `fresh`
- **WHEN** an agent refutes it
- **THEN** its derived review state SHALL become `needs_review` without waiting out its type TTL

#### Scenario: A refutation is not an access

- **WHEN** an agent refutes a memory
- **THEN** the memory's access signal SHALL be unchanged

#### Scenario: A refutation preserves the memory

- **WHEN** an agent refutes a memory
- **THEN** the memory's `content`, `title` and `status` SHALL be unchanged, and the refutation SHALL be recoverable as an event

#### Scenario: A refutation does not advance the affirmation baseline

- **GIVEN** an active memory with a known `reviewBaseline`
- **WHEN** an agent refutes it
- **THEN** `reviewBaseline` SHALL be unchanged and the affirmation count SHALL be unchanged

#### Scenario: A refuted memory can be re-affirmed

- **GIVEN** a memory that was refuted and subsequently confirmed
- **WHEN** its review state is derived
- **THEN** the later confirmation SHALL advance the affirmation baseline, and the memory SHALL derive `fresh` and leave the review queue

### Requirement: The review queue MUST have a terminal state

A memory that is retrieved regularly but never re-affirmed crosses its review TTL and then remains `needs_review` indefinitely: reads deliberately do not clear it, and — because reads advance the access signal — decay cannot archive it either. The two staleness axes do not cover this case, and the affected population only grows.

The escalation SHALL be a **read-time derived signal**, `reviewEscalated`, true once the memory has been unaffirmed for a bounded multiple of its own type TTL (`reviewBaseline + ttl * (1 + ESCALATION_MULTIPLIER) <= now`). It SHALL be derived by the same pure function as the rest of the review state, exposed alongside `reviewState`/`reviewAfter` on the reads that carry them, and SHALL introduce no column, no sweep and no new mutation verb. It SHALL NOT be produced by the decay axis: the decay pass reads `last_seen_at` and the confidence floor only, and coupling it to the review clock would break the orthogonality the two axes are built on.

Two populations are deliberately outside the escalation clock, and both are stated rather than left implicit:

- A type with no TTL has no clock to be a multiple of, so it never escalates. It also never enters the queue on the clock, so this is closure, not limbo.
- A **refuted** memory of a TTL-less type is the one genuinely open case: it is in the queue with no TTL to escalate against, so it stays `needs_review` until it is re-affirmed, superseded, or archived by explicit action. This exemption is deliberate. The limbo the escalation signal exists to close is the one nobody chose — a memory nobody ever formed an opinion about — whereas a refutation is an explicit, attributed, reasoned claim that the memory is wrong; expiring that claim on a timer would discard the strongest evidence in the system on the grounds that it had been ignored for long enough. Its queue POSITION is time-bounded (see the sibling requirement) so it cannot starve the rest of the queue; its STATE is not.

#### Scenario: A long-unaffirmed but frequently-read memory escalates

- **GIVEN** an active memory that has been `needs_review` for a bounded multiple of its type TTL, and whose access signal has been advanced throughout that period
- **WHEN** its review state is derived
- **THEN** `reviewEscalated` SHALL be true, distinguishing it from a memory that has only just entered `needs_review`

#### Scenario: Escalation stores no state

- **WHEN** a memory escalates within the review axis
- **THEN** no column SHALL record the escalation and no sweep SHALL be required to produce it

#### Scenario: A recently-expired memory is not escalated

- **GIVEN** an active memory one day past its `reviewAfter`
- **WHEN** its review state is derived
- **THEN** `reviewState` SHALL be `'needs_review'` and `reviewEscalated` SHALL be false

#### Scenario: A TTL-less type never escalates

- **GIVEN** an active memory of a type with no `REVIEW_TTL_MS` entry, refuted long ago and never re-affirmed
- **WHEN** its review state is derived
- **THEN** `reviewState` SHALL be `'needs_review'` and `reviewEscalated` SHALL be false

### Requirement: The rank window MUST be wide enough for the rank constant it uses

Reciprocal Rank Fusion with rank constant `k` only preserves the intended ordering when the rank window is wide enough that a bottom-of-window row present in both branches cannot outscore a rank-1 row present in one branch. That condition is `2/(k + window) <= 1/(k + 1)`, i.e. the window must be at least `k + 2`. With `k = 60` and the default result limit the window is currently 38, well below the crossover, so the invariant is violated on the default path.

The rank window SHALL be floored at or above the crossover implied by the rank constant, so that a single-branch rank-1 match is never displaced by rows whose only advantage is appearing in both branches' windows. Both retrievers already over-fetch and the dense kNN cost is flat in `k`, so the floor SHALL be implemented by widening the window rather than by lowering the rank constant. This guarantee is bounded by construction: at most `window - (rank_constant + 2)` rows can simultaneously rank below the crossover in both branches. A single-branch match displaced by more genuinely-relevant competitors than fit on a page is not a violation of this requirement — no window floor can or should prevent a page from filling with better matches.

The guarantee is a property of **fusion**, and it holds over fused RRF scores only. The post-fusion boost is applied afterwards and is explicitly licensed to reorder near-ties (see "The post-fusion boost's documented guarantee MUST match its behavior"): its reachable multiplier spread is far wider than the fusion margin this floor protects, so a boosted row CAN overtake a single-branch rank-1 row. That is the boost doing its job, not a window violation, and the two requirements SHALL be read in that order.

#### Scenario: An exact single-branch match outranks a both-branches pair

- **GIVEN** a query whose exact-token match is returned at rank 1 by the lexical branch and is absent from the dense branch's window
- **AND** two rows that appear near the bottom of both branches' windows
- **WHEN** the ranked lists are fused at the default result limit
- **THEN** the exact match SHALL outrank both of those rows in the FUSED ordering, before the boost is applied

#### Scenario: The boost may reorder what fusion ordered

- **GIVEN** the same fused ordering
- **WHEN** the post-fusion boost is applied and a trailing row carries a materially higher boost
- **THEN** the reordering SHALL be permitted, and SHALL NOT be treated as a failure of the window floor

#### Scenario: An identifier query returns the memory naming it

- **GIVEN** an active memory whose content contains a rare identifier, and no more than `window - (rank_constant + 2)` other memories ranked below the crossover in both branches
- **WHEN** `memory.search` is called with that identifier at the default limit
- **THEN** the memory containing the identifier SHALL appear in the returned page

#### Scenario: Large-limit behavior is unchanged

- **WHEN** `memory.search` is called with a limit whose derived window already exceeds the crossover
- **THEN** the window SHALL be unchanged by the floor

## ADDED Requirements

### Requirement: A refutation MUST lead the review queue only while it is recent

The review queue is ordered by affirmation baseline, oldest first, and a refutation deliberately does not advance that baseline — so a just-refuted memory sorts LAST and the agent that called it wrong never sees it come back. Refuted rows therefore lead the queue. That lead SHALL NOT be permanent: `memory.context` returns three rows, so a handful of refuted memories nobody attends to would hold the head of the queue forever and every TTL-expired memory in the corpus would be starved out of the only channel that surfaces it. The failure is silent and it worsens monotonically, because refuted rows only accumulate.

The queue SHALL order by a **time-bounded** refutation lead: a row whose refutation is newer than a bounded window sorts ahead of the rest, and past that window it queues by affirmation baseline like any other expired row. Crossing the window SHALL NOT change the row's `reviewState` — it is still `needs_review` and still counted in the queue depth; only its position changes. The window SHALL be a single named constant declared beside `REVIEW_TTL_MS`, and the ordering SHALL be computed in one place so the scoped queue read and its unscoped dashboard twin cannot drift apart.

#### Scenario: A fresh refutation leads

- **GIVEN** a scope containing a memory refuted today whose affirmation baseline is the newest in scope, and older memories past their TTL
- **WHEN** the review queue is read with a limit of one
- **THEN** the refuted memory SHALL be returned

#### Scenario: An unattended refutation stops starving the queue

- **GIVEN** three memories whose refutations are all older than the lead window, and one memory past its TTL whose affirmation baseline is the oldest in scope
- **WHEN** the review queue is read with a limit of three
- **THEN** the TTL-expired memory SHALL be in the page

#### Scenario: Losing the lead does not leave the queue

- **GIVEN** the same corpus
- **WHEN** the queue depth is counted
- **THEN** all four memories SHALL still be counted as needing review

### Requirement: Retrieval and lifecycle constants MUST be named and bounded in one place

Ranking, projection and lifecycle behaviour is governed by a set of compile-time constants that no requirement previously named, which made each one invisible to review and free to drift. None SHALL be operator-configurable or exposed as a per-request tunable, and each SHALL be declared once, as a named constant, in the module that owns the behaviour:

- `RANK_WINDOW_MARGIN` — the over-fetch added to `limit + offset` before the floor and ceiling are applied, so a page near a window edge still fuses over more candidates than it returns.
- `RANK_WINDOW_CEILING` — the hard cap on that window, set strictly above the maximum `limit`. It doubles as the entity path's page size when no `limit` is given (see `mcp-api`), so exact-address retrieval is complete-within-a-bound rather than truncated to a ranked default.
- `RELEVANCE_LIMIT` — the cap on `memory.context`'s relevance channel, shared by its entity pre-pass and its ranked pass.
- `ENTITY_RARITY_THRESHOLD` — the maximum share of a scope's active memories an entity may be linked to before it stops proposing save-time candidates. A proportion, not an absolute count, so it does not become inert as a corpus grows.
- `ENTITIES_PROJECTION_CAP` — the per-memory bound on the `entities[]` projection, whose exhaustion is reported to the caller.
- `PREDECESSOR_CAP` — the bound on the supersedes-chain walk.
- `ESCALATION_MULTIPLIER` — the multiple of its own TTL a memory sits `needs_review` before `reviewEscalated` derives true.
- `REBUILD_MAX_BATCHES` — the bound on one operator-triggered derived-index rebuild pass, so the rebuild cannot become an unbounded blocking loop.

Two gates SHIP DISABLED (`null`) and SHALL remain so until calibrated against the evaluation harness, and their disabled state is part of the contract rather than a temporary condition to be quietly flipped: the abstention floor and gap ratio (see "Recall MUST be able to return nothing"), and the per-session `DIVERSITY_CAP`. The diversity cap is disabled for a measured reason: it is applied to the whole fused pool before the page is sliced, so a held-back row is replaced by whatever ranked next in a 64–400 row pool rather than by a comparable row, and on a single-topic session that measurably swaps most of page 1 for noise. The evaluation corpus cannot see the regression because every corpus row carries a null session id, which is never grouped — so re-enabling it SHALL require a session-labelled fixture first.

#### Scenario: A constant is not reachable as a request parameter

- **WHEN** any MCP tool input schema is inspected
- **THEN** none of the constants above SHALL be settable per request

#### Scenario: A disabled gate stays disabled without a calibration

- **WHEN** the abstention floor, the gap ratio, or the diversity cap is enabled
- **THEN** the change SHALL be accompanied by a measurement on the evaluation harness, and for the diversity cap by a session-labelled fixture the harness can see the regression through
