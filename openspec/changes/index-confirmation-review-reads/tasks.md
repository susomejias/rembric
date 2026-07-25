# Tasks

## 1. Establish the baseline before changing anything

- [ ] 1.1 Write a reusable benchmark that builds a migrated temp DB, seeds N active memories plus ~1 confirmation each, and times `findNeedsReview`, `countNeedsReview`, `adminCountNeedsReview` and `findDecayCandidateIds` at N = 1k / 5k / 20k / 50k. Keep it out of `pnpm test` (it is a measurement, not an assertion).
- [ ] 1.2 Record the pre-index numbers. The proposal's figures are from one box; reproduce them locally so the after/before comparison is apples to apples.
- [ ] 1.3 Capture `EXPLAIN QUERY PLAN` for each of the four reads, pre-index, so the plan change is evidence rather than inference.

## 2. Add the index

- [ ] 2.1 New migration `0025_confirmation_review_index.sql`: `CREATE INDEX confirmations_memory_verdict_ts_idx ON confirmations (memory_id, verdict, event_ts);`. Additive — no table rebuild, no pragma work needed from the author.
- [ ] 2.2 Declare it in `db/schema/confirmations.ts` alongside the three existing indexes, so `drizzle-kit generate` cannot emit DDL diverging from the live schema.
- [ ] 2.3 Update `test/schema-drift.test.ts` if it asserts index names.
- [ ] 2.4 Confirm `migrations.test.ts` passes, including the runner's pre-commit `PRAGMA foreign_key_check` gate.

## 3. Verify the index is actually used

- [ ] 3.1 Re-run 1.3: every one of the four reads must now show the composite index in its plan. A `CREATE INDEX` that the planner ignores is pure write cost.
- [ ] 3.2 Re-run 1.1 and record the delta. Expect roughly 25–45% at 20k; if the measured gain is inside noise, stop and reconsider rather than shipping an unused index.
- [ ] 3.3 Confirm the subqueries are covered (no table access for the confirmation lookup).

## 4. Resolve the redundant-index question (design.md Q1)

- [ ] 4.1 Measure `countConfirmations` and the `insertConfirmation` path with and without `confirmations_memory_id_idx` present alongside the composite.
- [ ] 4.2 Measure insert throughput on `confirmations` with three versus four indexes — this is the actual cost of keeping both.
- [ ] 4.3 Decide and record. Default to keeping the single-column index if the difference is inside noise; dropping an index needs a rebuild-free `DROP INDEX` but is harder to reverse than never adding one.
- [ ] 4.4 Do NOT touch `confirmations_event_ts_idx` here (Q2) — it needs its own measurement and is out of scope.

## 5. Specs

- [ ] 5.1 `data-access`: add a requirement that the review-axis reads are served by a composite index over `(memory_id, verdict, event_ts)` and NOT by a `LEFT JOIN` + `GROUP BY` rewrite, with the measured figures and the crossover (the join loses at 50k). State it as measured-relative ordering, not absolute latency.
- [ ] 5.2 `persistence`: record the index in the DDL, matching how that file already pins index and trigger names for other tables.
- [ ] 5.3 Cross-reference from `reconcile-specs-with-shipped-behaviour` that this closes the deferred `needsReviewExprs` finding, so the two changes do not both claim it.

## 6. Verify

- [ ] 6.1 `pnpm run typecheck` · `pnpm run lint` · `pnpm test`.
- [ ] 6.2 Real Docker smoke against pre-existing seeded data: the migration must apply cleanly to a populated `confirmations` table, and the dashboard review counters plus `memory.context`'s review queue must return the same rows as before. A pure index addition changing any result set means the query was relying on scan order.
- [ ] 6.3 Confirm the migration is idempotent across restarts (runner-tracked) and that a fresh install and an upgraded install end with identical `sqlite_master` index sets.
