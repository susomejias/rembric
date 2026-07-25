## ADDED Requirements

### Requirement: The `confirmations` table MUST carry a composite index for the review axis

The schema SHALL provide an index serving the correlated subqueries that derive review state and the decay confidence floor from `confirmations`:

```
CREATE INDEX confirmations_memory_verdict_ts_idx
  ON confirmations (memory_id, verdict, event_ts)
```

Column order is load-bearing and SHALL be preserved: equality on `memory_id`, then equality on `verdict`, then `event_ts` last so `MAX(event_ts)` and `event_ts > ?` are answered from the index's own ordering rather than by examining matched rows. Having all three columns present also makes the index covering for these subqueries, so they perform no table access at all. Any other column order loses one of those three properties.

The index SHALL be declared in both the migration SQL and the Drizzle table definition — it is an ordinary column-list index, so unlike `memory_scope_seen_idx` it is expressible in Drizzle and SHALL NOT be added to the schema-drift allow-list. Adding it is index-only DDL: additive, no table rebuild, and no pragma work by the migration author.

`confirmations_memory_id_idx` SHALL be retained. The composite's leftmost column makes it capable of serving every lookup the single-column index serves, and the planner prefers the composite wherever both apply, so the single-column index is redundant by coverage — but its removal measures no gain on either the read or the write path and SHALL therefore be its own change with its own before/after, not a side effect of this one.

#### Scenario: The review-axis subqueries never touch the table

- **GIVEN** the `confirmations_memory_verdict_ts_idx` index exists
- **WHEN** `EXPLAIN QUERY PLAN` is run on `findNeedsReview`, `countNeedsReview`, `adminCountNeedsReview` or `findDecayCandidateIds`
- **THEN** every plan line accessing `confirmations` SHALL report `SEARCH confirmations USING COVERING INDEX confirmations_memory_verdict_ts_idx`
- **AND** no plan line SHALL report a non-covering search or a scan of `confirmations`

#### Scenario: A pure index addition changes no result set

- **GIVEN** a populated `confirmations` table on an existing install
- **WHEN** the migration is applied and the review-axis reads run again
- **THEN** they SHALL return the same rows in the same order as before the index existed

#### Scenario: Fresh and upgraded installs converge

- **WHEN** the migration set is applied to an empty database, and separately to a database cut off at any earlier migration
- **THEN** both SHALL end with identical `sqlite_master` index sets, including `confirmations_memory_verdict_ts_idx`

#### Scenario: The index survives a future table rebuild

- **WHEN** a later migration rebuilds `confirmations`
- **THEN** it SHALL recreate `confirmations_memory_verdict_ts_idx`, and the exact-set index assertion in `apps/server/src/test/schema-drift.test.ts` SHALL fail if it does not
