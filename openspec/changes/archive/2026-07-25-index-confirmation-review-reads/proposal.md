## Why

Every review-axis read derives its answer from `confirmations` with a correlated subquery per candidate row, filtering on `(memory_id, verdict)` and taking `MAX(event_ts)`. The table carries three single-column indexes (`memory_id`, `event_ts`, `session_id`) and no composite, so each subquery seeks on `memory_id` and then scans that memory's confirmation rows to apply the `verdict` filter and find the maximum.

Measured on a migrated temp DB with realistic bodies and ~1.05 confirmations per memory:

| active rows | `findNeedsReview(3)` | `countNeedsReview` | `findDecayCandidateIds` |
| ----------- | -------------------- | ------------------ | ----------------------- |
| 1 000       | 1.3 ms               | 0.9 ms             | 1.0 ms                  |
| 5 000       | 8.2 ms               | 4.5 ms             | 3.5 ms                  |
| 20 000      | 33.4 ms              | 18.2 ms            | 22.4 ms                 |
| 50 000      | 89.3 ms              | 36.6 ms            | 62.9 ms                 |

Adding `confirmations(memory_id, verdict, event_ts)` cut all three at 20 000 rows: `findNeedsReview` 23.4 → 18.4 ms, `countNeedsReview` 18.2 → 10.8 ms, `findDecayCandidateIds` 22.4 → 12.3 ms — **25–45%, one migration, zero query rewrite.** The index covers the subqueries end to end: seek on `memory_id`, range-restrict on `verdict`, and read `event_ts` from the index without touching the table.

**This change exists because the obvious alternative was measured and rejected.** The reviewed batch left a `LEFT JOIN` rewrite of these subqueries deferred pending measurement. Measurement overturned it: the join wins by ≤20% at 20 000 rows and **loses** at 50 000 (56.3 ms against 36.6 ms), because it must materialise two `GROUP BY` subqueries over all of `confirmations`. Hoisting the WHERE/ORDER BY expressions into a computed subquery is also slower (28.5 against 24.6 ms at 20 000, verified identical result sets). Neither removes the `O(active rows)` scan the predicate fundamentally requires. The index is the only lever that pays, so the deferral should be closed by adding the index and recording that the rewrite is not the fix — otherwise the next reader re-proposes the join.

These are session-start and dashboard paths, not per-turn ones, so this is not urgent. It is worth doing because it is cheap, because `memory.context` pays the predicate twice per call (once for the page, once for the total), and because the numbers exist now and will not be re-derived later.

## What Changes

- **Add a composite index** `confirmations(memory_id, verdict, event_ts)` in a new migration. Additive `CREATE INDEX` — no table rebuild, no column change, so none of the SQLite rebuild dance applies.
- **Declare it in the Drizzle table** alongside the three existing indexes, so `drizzle-kit generate` does not emit DDL that diverges from the live schema.
- **Decide whether `confirmations_memory_id_idx` is now redundant.** The composite has `memory_id` as its leftmost column, so it serves every lookup the single-column index served. Dropping it saves write amplification on an append-only table that only grows; keeping it is the conservative choice. Measure both before deciding — a `memory_id`-only seek may still prefer the narrower index.
- **Record the measurement in the `data-access` spec** as the reason the correlated-subquery form stays: a requirement stating that these reads are indexed rather than joined, with the figures, so the rewrite is not re-proposed as an optimisation.

The audit that produced these figures also found that this index pays beyond the needs-review reads: it makes `reviewTimestampsByIds` covering and removes its `USE TEMP B-TREE FOR GROUP BY`, 1.86 → 0.86ms at 400 ids — on the per-turn search path, not just the session-start one. The rest of that audit is `tune-hot-query-paths`; this change stays scoped to `confirmations`.

## Impact

Affected specs: `data-access` (the indexed-not-joined requirement), `persistence` (the DDL, which already pins index names down to individual triggers for other tables).

Affected code: one new migration under `apps/server/src/db/migrations/`, `apps/server/src/db/schema/confirmations.ts`, and `apps/server/src/test/schema-drift.test.ts` if it asserts index names.

No behaviour change, no API change, no data migration. Existing installs pick it up on the next boot through the normal migration runner; the index builds over a table with one row per confirmation event, so even a large corpus builds in well under a second.
