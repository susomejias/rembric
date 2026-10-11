## MODIFIED Requirements

### Requirement: Active memories MUST expose a derived review state

Each memory with `status = 'active'` SHALL expose a **derived, read-time-only** review state on retrieval. The state is computed, never stored: no column SHALL be added to `memory`, and no row SHALL be mutated to record it.

For an `active` memory of type `T`:

- `reviewBaseline` SHALL be `max(created_at, latest AFFIRMING confirmation event_ts)` — the last time the memory was **affirmed** (its own creation, or a `memory.confirm_batch` with verdict `affirm` recorded against the head of its supersedes chain). A refuting confirmation SHALL NOT advance it. `last_seen_at` SHALL NOT be used as the baseline: it is the ACCESS signal, advanced by every successfully served dereference through `memory.get_batch`, whether one or many IDs are requested, by an affirming `memory.confirm_batch`, and by an operator undoing a decay archival — never by a search returning a row. A successful batch dereference SHALL advance the resolved head, not every projected predecessor; failed, missing and out-of-scope targets SHALL not be touched. Access and affirmation are different facts about a memory, which is the whole reason the two axes exist.
- `reviewAfter` SHALL be `reviewBaseline + REVIEW_TTL_MS[T]` when `REVIEW_TTL_MS` has an entry for `T`, and `null` otherwise.
- `reviewState` SHALL be `'needs_review'` when `reviewAfter` is non-null AND `reviewAfter <= now`; otherwise `'fresh'`.
- A refutation newer than `reviewBaseline` SHALL force `reviewState = 'needs_review'` regardless of `T`'s TTL, and `reviewAfter` SHALL then report the refutation's timestamp.

`REVIEW_TTL_MS` SHALL be a per-`type` shelf-life map exported from a single source (`packages/core/src/services/review.ts`). A type with no entry SHALL never produce `needs_review` on the clock. The shelf life is a soft re-verification nudge, not a hard expiry: a `needs_review` memory SHALL remain `active` and SHALL be unaffected in ranking, scope isolation, or decay eligibility.

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
- **WHEN** `memory.confirm_batch` records an affirming confirmation event at `now`
- **THEN** the next derivation SHALL use `reviewBaseline = now`, yielding `reviewAfter = now + REVIEW_TTL_MS[type]` and `reviewState = 'fresh'`
- **AND** no `memory` row SHALL have been mutated to achieve this (the confirmation is the only write, plus the access-signal touch that an affirmation carries)

#### Scenario: Reading a memory does NOT clear needs_review

- **GIVEN** an `active` memory deriving `reviewState = 'needs_review'`
- **WHEN** the memory is successfully dereferenced via `memory.get_batch({ids: [id]})` or a multi-item `memory.get_batch` (both advance the resolved head's `last_seen_at`), or returned by `memory.search` (which does not)
- **THEN** its derived `reviewState` SHALL remain `'needs_review'` in every case — access does not count as affirmation, whether or not the read advanced the access signal

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

### Requirement: Being returned by a search MUST NOT be sufficient to confer durability

A memory appearing in a page of search results is evidence that it ranked, not that it was useful. The access signal that drives decay eligibility and the retrieval recency boost SHALL NOT be advanced merely by a row being included in a result page, because doing so makes ranking self-reinforcing: a row that ranks well becomes decay-immune, gains a recency boost that helps it rank well again, and is pinned to the top of subsequent context pulls, with no evidence the agent read past its title.

Whatever signal the system adopts for "accessed", it SHALL be advanced only by an interaction that distinguishes a dereferenced memory from a listed one, and any row that is filtered out before reaching the caller SHALL NOT have its access signal advanced.

Search SHALL advance the access signal for **no** row — neither the rows it returns nor the rows it drops — and every successful `memory.get_batch` dereference, whether selected by IDs or creation period, SHALL advance its resolved head's access signal, regardless of batch size. Failed, missing and foreign targets, and merely projected predecessors, SHALL NOT be touched. The drop-before-return scenario remains a stated requirement so that a future re-introduction of a search-time touch cannot reach a row the caller never saw.

#### Scenario: A broad search does not confer durability on every hit

- **GIVEN** a corpus in which a memory is old enough to be decay-eligible
- **WHEN** a search returns that memory in a page of results and the caller does not dereference it
- **THEN** the memory SHALL remain decay-eligible

#### Scenario: A dereferenced memory is treated as accessed

- **WHEN** a memory is successfully fetched by explicit ID or creation period through `memory.get_batch`, in a batch of one or many
- **THEN** its resolved head's access signal SHALL be advanced
- **AND** no mere predecessor projection or failed target SHALL receive an access update

#### Scenario: A row dropped before return is not touched

- **GIVEN** a row retrieved by a retrieval branch but excluded by the live-status re-check before the response is built
- **WHEN** the search completes
- **THEN** that row's access signal SHALL NOT have been advanced

### Requirement: Term-statistics lookups MUST be keyed on the index's own terms

The terms whose document frequencies are read SHALL be obtained from the full-text index's own tokenizer, by tokenising the query text through an FTS5 table declared with that same tokenizer and reading the resulting terms back, in the same read that resolves their document frequencies. The application SHALL NOT reproduce the index's tokenizer in order to key that read.

The relevance level looks a term up in the index's own statistics, so a token the tokenizer would never have produced finds no entry, receives the weight reserved for a term the corpus has never seen — the maximum — and the level silently treats the corpus's commonest word as its rarest. A term is therefore only safe to look up if the index itself produced it.

Reproducing it is not merely undesirable, it is unavailable, and the requirement is written this way because the alternative was measured and does not exist. The index's rule disagrees with any application-side rule in at least three independent ways — which characters delimit a term, whether text is compared decomposed or precomposed, and whether case folding is per-codepoint or context-sensitive — and its diacritic-folding table is neither "fold everything" nor "fold nothing", so agreement cannot be recovered by choosing a folding option on either side. A rule that agrees on one set of scripts trades away another.

Because the terms come from the index's tokenizer, absence becomes evidence rather than inference. The read SHALL distinguish a term the index holds from a term it does not, explicitly, so that the maximum weight is applied because the index reported no such term and not because a lookup key was missing from a map. A term reported absent SHALL carry the maximum weight; that is the same rule as before, and it is only correct under this requirement.

The declaration of the tokenising table SHALL be derived from the shipped declaration of the full-text index, read from the database's own schema at startup, so that the two cannot be separately edited into disagreement. A declaration option the derivation does not recognise SHALL fail startup rather than be silently dropped: a tokenizer option carried by the index and not by the tokenising table would reintroduce exactly the divergence this requirement removes, and would do so invisibly.

The tokenising table SHALL store no text. It exists to produce terms, not to hold a copy of the query, and SHALL NOT write to the durable database.

**The row-membership half of the lexical component is NOT covered by this requirement, deliberately.** Deciding which of the query's terms a candidate row contains is a separate operation over the whole fused pool, and the two families priced for doing it through the index — tokenising the pool at query time, and reading the index's term-major structures — were measured at eight to twenty-nine times the change's own cost budget. The one term-major variant that measures under the budget does so only while a per-row cache holds about a single pool's worth of rows, and the reason is structural: a term-major read has the term constraint pushed down and decides document membership only afterwards, so its cost tracks the corpus rather than the pool, and one and the same pool measures forty-six times as expensive at a corpus-sized cache as at a pool-sized one. It therefore continues to use the application's own tokenisation, and the consequence SHALL be bounded rather than hidden: a disagreement there can only cause a term the row does contain to be counted as not covered, which lowers that row's lexical component. It SHALL NOT be able to produce the absent-term maximum weight, SHALL NOT raise any row's level, and SHALL leave the dense branch's contribution to the level untouched — so a row the lexical component under-counts is still reachable on its cosine. This asymmetry SHALL be stated wherever the lexical component is specified; it SHALL NOT be described as agreement.

There SHALL be ONE application-side tokenisation shared by the search path's row-membership test and the save-time candidate path, so those two cannot disagree about what a token is.

#### Scenario: A term the index holds resolves to its real document frequency

- **GIVEN** a corpus containing a word whose index term differs from what an application-side tokenisation of the same word would produce — a Greek word ending in a final sigma, or a Cyrillic word containing a precomposed accented character
- **WHEN** that word is issued as a query term and its weight is resolved
- **THEN** it SHALL resolve to the document frequency the index records for it, and SHALL NOT resolve to the weight of a term absent from the index

#### Scenario: A term the index has never seen is reported absent, not zero

- **GIVEN** a query containing a term no indexed row contains
- **WHEN** the term statistics for that query are read
- **THEN** the term SHALL appear in the result marked as absent, distinguishably from a term the index holds, and SHALL receive the maximum weight on that basis

#### Scenario: The tokenising table inherits the index's declared tokenizer

- **WHEN** the tokenising table is created
- **THEN** its tokenizer declaration SHALL have been read from the shipped declaration of the full-text index in the database's schema, and SHALL NOT be restated independently anywhere in the source

#### Scenario: An unrecognised declaration option fails startup

- **GIVEN** a full-text index whose shipped declaration carries a tokenizer option the derivation does not recognise
- **WHEN** startup derives the tokenising table's declaration
- **THEN** startup SHALL fail naming the option, and SHALL NOT proceed with an option silently omitted

#### Scenario: A row-side tokenisation disagreement can only under-count

- **GIVEN** a candidate row containing a query term whose application-side tokenisation differs from the index's
- **WHEN** that row's relevance level is computed
- **THEN** the term SHALL be counted as not covered, the row's lexical component SHALL be no higher than if the term were absent from the row, and the row's level SHALL still be at least its dense-branch cosine

#### Scenario: Query text is not written to the durable database

- **GIVEN** a sequence of searches
- **WHEN** the durable database file and its write-ahead log are inspected before and after
- **THEN** neither SHALL have grown on account of tokenising the queries, and no table in the durable schema SHALL hold the query text

### Requirement: `procedural` MUST be a first-class memory type

The memory-type enum SHALL include `procedural`, with its own review TTL and its own decay window, distinct from `reference`. Existing rows SHALL NOT be reclassified: assigning a type is a content judgement, and the server SHALL NOT make it on the agent's behalf.

Procedural knowledge — how a task is performed in this codebase, a runbook, a workflow — is the highest-value memory class for a coding agent and has a shelf life unlike any existing type. It is currently expressible only as `reference`, which deliberately carries **no** review TTL and a ten-year decay window on the grounds that a reference is a pointer whose staleness surfaces when used. A runbook is not a pointer: it goes stale silently when the underlying process changes, and a stale runbook actively misleads.

#### Scenario: A procedural memory needs review on its own schedule

- **GIVEN** an active `procedural` memory older than its type TTL and never re-affirmed
- **WHEN** its review state is derived
- **THEN** it SHALL be `needs_review`, independently of what a `reference` memory of the same age would report

#### Scenario: Existing reference memories are untouched by the migration

- **GIVEN** a database containing `reference` memories, some of which describe procedures
- **WHEN** the migration introducing `procedural` runs
- **THEN** every existing row SHALL retain its current type

#### Scenario: The type is accepted at the tool boundary

- **WHEN** `memory.save` is called with `type = 'procedural'`
- **THEN** the row SHALL be persisted with that type and SHALL be filterable by it

### Requirement: The review queue MUST have a terminal state

The escalation SHALL be a **read-time derived signal**, `reviewEscalated`, true once the memory has been unaffirmed for a bounded multiple of its own type TTL (`reviewBaseline + ttl * (1 + ESCALATION_MULTIPLIER) <= now`). It SHALL be derived by the same pure function as the rest of the review state, SHALL be reported on the single-`id` `memory.get` read alongside `reviewState`/`reviewAfter` (see `mcp-api`), and SHALL introduce no column, no sweep and no new mutation verb. It SHALL NOT be produced by the decay axis: the decay pass reads `last_seen_at` and the confidence floor only, and coupling it to the review clock would break the orthogonality the two axes are built on.

A memory that is retrieved regularly but never re-affirmed crosses its review TTL and then remains `needs_review` indefinitely: reads deliberately do not clear it, and — because reads advance the access signal — decay cannot archive it either. The two staleness axes do not cover this case, and the affected population only grows.

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

The rank window SHALL be floored at or above the crossover implied by the rank constant, so that a single-branch rank-1 match is never displaced by rows whose only advantage is appearing in both branches' windows. Both retrievers already over-fetch and the dense kNN cost is flat in `k`, so the floor SHALL be implemented by widening the window rather than by lowering the rank constant. This guarantee is bounded by construction: at most `window - (rank_constant + 2)` rows can simultaneously rank below the crossover in both branches. A single-branch match displaced by more genuinely-relevant competitors than fit on a page is not a violation of this requirement — no window floor can or should prevent a page from filling with better matches.

Reciprocal Rank Fusion with rank constant `k` only preserves the intended ordering when the rank window is wide enough that a bottom-of-window row present in both branches cannot outscore a rank-1 row present in one branch. That condition is `2/(k + window) <= 1/(k + 1)`, i.e. the window must be at least `k + 2`. With `k = 60` and the default result limit the window is currently 38, well below the crossover, so the invariant is violated on the default path.

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
