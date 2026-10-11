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
