## ADDED Requirements

### Requirement: Active memories MUST expose a derived review state

Each memory with `status = 'active'` SHALL expose a **derived, read-time-only** review state on retrieval. The state is computed, never stored: no column SHALL be added to `memory`, and no row SHALL be mutated to record it.

For an `active` memory of type `T`:

- `reviewBaseline` SHALL be `max(created_at, latest confirmation event_ts)` — the last time the memory was **affirmed** (its own creation, or a `memory.confirm` recorded against the head of its supersedes chain). `last_seen_at` SHALL NOT be used as the baseline, because `last_seen_at` advances on every read (access), not on affirmation.
- `reviewAfter` SHALL be `reviewBaseline + REVIEW_TTL_MS[T]` when `REVIEW_TTL_MS` has an entry for `T`, and `null` otherwise.
- `reviewState` SHALL be `'needs_review'` when `reviewAfter` is non-null AND `reviewAfter <= now`; otherwise `'fresh'`.

`REVIEW_TTL_MS` SHALL be a per-`type` shelf-life map exported from a single source (`apps/server/src/services/review.ts`). A type with no entry SHALL never produce `needs_review`. The shelf life is a soft re-verification nudge, not a hard expiry: a `needs_review` memory SHALL remain `active` and SHALL be unaffected in ranking, scope isolation, or decay eligibility.

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
- **WHEN** `memory.confirm` records a confirmation event at `now`
- **THEN** the next derivation SHALL use `reviewBaseline = now`, yielding `reviewAfter = now + REVIEW_TTL_MS[type]` and `reviewState = 'fresh'`
- **AND** no `memory` row SHALL have been mutated to achieve this (the confirmation is the only write)

#### Scenario: Reading a memory does NOT clear needs_review

- **GIVEN** an `active` memory deriving `reviewState = 'needs_review'`
- **WHEN** the memory is fetched via `memory.get` or returned by `memory.search` (both of which touch `last_seen_at`)
- **THEN** its derived `reviewState` SHALL remain `'needs_review'` — access does not count as affirmation

#### Scenario: A type without a TTL never needs review

- **GIVEN** an `active` memory whose `type` has no `REVIEW_TTL_MS` entry, created arbitrarily long ago, never confirmed
- **WHEN** its review state is derived
- **THEN** `reviewAfter` SHALL be `null` and `reviewState` SHALL be `'fresh'`

#### Scenario: Non-active memories carry no review state

- **GIVEN** a memory with `status = 'superseded'` or `status = 'archived'`
- **WHEN** it is retrieved
- **THEN** `reviewState` SHALL be omitted (or null) and `reviewAfter` SHALL be omitted
