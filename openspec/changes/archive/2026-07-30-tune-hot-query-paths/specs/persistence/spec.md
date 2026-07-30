## ADDED Requirements

### Requirement: The index set MUST be exactly the measured one, and snapshot-asserted

The declared index set is a contract, not an accretion. Every index below was
created and its plan re-captured before it shipped; every index dropped below was
shown to be unusable by any query predicate that exists. An index no plan selects
is pure write cost.

Added by `0027_tune_hot_query_paths.sql`:

```
memory (scope, project_id, status, created_at)
memory (scope, project_id, type)
memory (status, created_at)
sessions (token_id, project_id, COALESCE(last_activity_at, started_at) DESC)
        WHERE status = 'active' AND deleted_at IS NULL
memory_relations (created_at)
prompts (created_at) WHERE deleted_at IS NULL
prompts (deleted_at) WHERE deleted_at IS NOT NULL
```

Two DROPs ship in the same migration because each is paired with the addition
that supersedes it, and separating them would leave the tree briefly with
neither: `memory_scope_project_status_idx` is a strict prefix of the four-column
index that replaces it, and `memory_status_last_seen_idx`'s second column served
no query — its reader filters by scope and is served by `memory_scope_seen_idx`.

Removed by `0028_drop_unusable_indexes.sql`, in a **separate migration and
commit** so a bisect can tell a removal from an addition:

```
confirmations_event_ts_idx
consolidation_ops_reverted_at_idx
oauth_tokens_expires_at_idx
tokens_revoked_at_idx
dashboard_sessions_token_id_idx
```

Each removal rests on a predicate argument, which is a property of the SQL rather
than of the data and therefore holds at any volume:

- `confirmations_event_ts_idx` — every reader takes `MAX(event_ts)` **inside** a `memory_id`-filtered subquery, which a bare `(event_ts)` index cannot serve. Plans re-captured with and without it: **unchanged**, and `confirmations_memory_verdict_ts_idx` serves both readers.
- `consolidation_ops_reverted_at_idx` — `reverted_at` appears only as `run_id = ? AND reverted_at IS NULL`, led by `run_id` and served by its index, and as a bare `count(reverted_at)` aggregate with no predicate at all.
- `oauth_tokens_expires_at_idx` — no query filters `oauth_tokens.expires_at`. Its predicates are `(hash, kind)`, `(id, rotated_at)` and `(family_id, revoked_at)`.
- `tokens_revoked_at_idx` — only ever `name = ? AND revoked_at IS NULL`, led by the UNIQUE index on `name`.
- `dashboard_sessions_token_id_idx` — `token_id` appears only as the join key **into** `tokens`, while the outer predicate is a `dashboard_sessions.id` primary-key lookup, so the join is driven from the other side.

**`confirmations_session_idx` was a drop candidate and SHALL be kept.** Measured
on a 50 000-session corpus, the session-content `EXISTS` selects it at 7.80 ms;
without it SQLite builds a transient automatic index and the same query costs
15.79 ms. This is the one candidate where the "unusable" hypothesis was wrong,
and it was only settled by measuring.

**Write cost of the net change, measured: unchanged.** The declared index count is
**35 before and 35 after** — 0027 is net +5 and 0028 is −5. Per-save cost
(including the FTS and `memory_replaces` triggers, the embedding insert and entity
linking for ~18 entities) measured across three runs at −11.4%, −3.1% and +1.3%: a
spread that straddles zero and is wider than any difference between the sets. The
read wins bought at no measurable write cost range from 3.7× to 6964×.

A per-save figure quoted from a single run SHALL NOT be treated as settled at this
granularity: the first run here read +6.4% and did not reproduce.

The whole set SHALL be **snapshot-asserted as an exact set**, not a subset, so an
index that exists only in migration SQL, or a declaration with no index behind
it, fails CI. Indexes Drizzle cannot express SHALL be allow-listed by name with a
reason rather than silently omitted; the allow-list is closed and adding to it is
a reviewable line.

#### Scenario: An index is added without a plan that selects it

- **WHEN** a change adds an index
- **THEN** it SHALL include the re-captured plan showing the planner selecting it for a named query
- **AND** an index no plan selects SHALL be rejected as pure write cost

#### Scenario: An index is dropped on the strength of a plan capture alone

- **WHEN** a change proposes dropping an index because it is absent from the captured plans
- **THEN** the argument SHALL additionally be a predicate argument — that no query has a predicate the index could serve — because a plan capture is evidence about the queries that exist today
- **AND** where only a plan capture is available, the drop SHALL ship in a migration separate from any addition

#### Scenario: A drop candidate turns out to be load-bearing

- **WHEN** measurement shows a candidate index is selected and its removal degrades a query
- **THEN** it SHALL be kept and the finding recorded against the candidate list
- **AND** `confirmations_session_idx` is the worked example: predicted unusable, measured at 2× on removal

#### Scenario: The declared index set diverges from the database

- **WHEN** a migration creates an index no Drizzle schema declares, or a schema declares one no migration creates
- **THEN** the exact-set snapshot assertion SHALL fail
- **AND** the fix SHALL be to reconcile the two, or to allow-list the index with the reason it is inexpressible — never to relax the assertion to a subset check
