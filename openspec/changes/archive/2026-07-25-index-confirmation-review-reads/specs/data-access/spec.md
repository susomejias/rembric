## ADDED Requirements

### Requirement: Review-axis reads MUST be served by an index over `confirmations`, not by a join rewrite

`findNeedsReview`, `countNeedsReview`, `adminCountNeedsReview` and `findDecayCandidateIds` each derive their answer from correlated subqueries over `confirmations`, one per candidate row, of the shape `SELECT MAX(event_ts) … WHERE memory_id = ? AND verdict = ?`. That form SHALL be retained and served by a composite index over `(memory_id, verdict, event_ts)`. It SHALL NOT be rewritten as a `LEFT JOIN` against grouped derived tables.

The reason is measured, not stylistic. A `LEFT JOIN` + `GROUP BY` rewrite must materialise one grouped pass over the whole of `confirmations` per verdict before the outer predicate discards anything, and then build an automatic index over each derived table; the correlated form does work proportional only to the candidate rows it visits. Measured on a migrated temp database with verified-identical result sets, `countNeedsReview` as correlated-subqueries-plus-index against the join rewrite:

| active rows | confirmations/memory | correlated + index | `LEFT JOIN` + `GROUP BY` |
| ----------- | -------------------- | ------------------ | ------------------------ |
| 20 000      | 1.05                 | 8.7 ms             | 12.8 ms                  |
| 50 000      | 1.05                 | 23.5 ms            | 35.8 ms                  |
| 50 000      | 4                    | 28.0 ms            | 51.3 ms                  |
| 50 000      | 12                   | 32.5 ms            | 86.8 ms                  |

These figures establish an **ordering between the two forms on one host**, not absolute latency on any host. The ordering is what the requirement rests on, and it does not cross over: the join's disadvantage widens with both row count and confirmation density, because its cost scales with the size of `confirmations` while the indexed correlated form scales with surviving candidates.

Neither form removes the `O(active rows)` outer scan. That scan is inherent — the predicate is a function of each active row's own type and timestamps, so every active row must be considered — and SHALL NOT be treated as evidence that the query shape is wrong.

#### Scenario: The correlated form is not replaced by a join

- **WHEN** a change proposes rewriting the review-axis subqueries as a `LEFT JOIN` against grouped derived tables
- **THEN** it SHALL be rejected unless it presents a measurement showing the join faster at both 20 000 and 50 000 active rows and at more than one confirmation density

#### Scenario: The reads are indexed rather than scanned

- **GIVEN** the composite index over `confirmations (memory_id, verdict, event_ts)`
- **WHEN** `EXPLAIN QUERY PLAN` is run on each of the four review-axis reads
- **THEN** every plan line that accesses `confirmations` SHALL report `USING COVERING INDEX confirmations_memory_verdict_ts_idx`

#### Scenario: The benefit is stated as density-dependent

- **WHEN** the value of the composite index is described
- **THEN** it SHALL be stated as a function of confirmation density and not as a single percentage, because the same index measures a 4–20% gain at ~1 confirmation per memory and a 30–66% gain at 4–12 confirmations per memory
