# Tasks

## 1. Establish the baseline before changing anything

- [x] 1.1 Write a reusable benchmark that builds a migrated temp DB, seeds N active memories plus ~1 confirmation each, and times `findNeedsReview`, `countNeedsReview`, `adminCountNeedsReview` and `findDecayCandidateIds` at N = 1k / 5k / 20k / 50k. Keep it out of `pnpm test` (it is a measurement, not an assertion).
      `db/repositories/review-reads.bench.test.ts`. Kept out of `pnpm test` by a `describe.runIf(REMBRIC_BENCH === '1')` gate rather than by living outside the vitest glob: a non-test file under `src/` that executes SQL and calls an `admin*` read would trip both the data-access-confinement and admin-confinement invariants. Gated, it costs `pnpm test` nothing and still gets typecheck and lint. `REMBRIC_BENCH_{SIZES,REPEATS,CONFIRMS}` parameterise it.
- [x] 1.2 Record the pre-index numbers. The proposal's figures are from one box; reproduce them locally so the after/before comparison is apples to apples.
      Reproduced, and they do NOT match: see the deviation recorded against 3.2.
- [x] 1.3 Capture `EXPLAIN QUERY PLAN` for each of the four reads, pre-index, so the plan change is evidence rather than inference.
      Captured from the SQL the repository actually executes (the harness intercepts `prepare`) rather than a reconstruction. Pre-index every subquery reads `SEARCH confirmations USING INDEX confirmations_memory_id_idx (memory_id=?)`.

## 2. Add the index

- [x] 2.1 New migration `0025_confirmation_review_index.sql`: `CREATE INDEX confirmations_memory_verdict_ts_idx ON confirmations (memory_id, verdict, event_ts);`. Additive — no table rebuild, no pragma work needed from the author.
- [x] 2.2 Declare it in `db/schema/confirmations.ts` alongside the three existing indexes, so `drizzle-kit generate` cannot emit DDL diverging from the live schema.
- [x] 2.3 Update `test/schema-drift.test.ts` if it asserts index names.
      It does, as an exact set (added by `tune-hot-query-paths`). `db/migrations.test.ts` also pins the migration filename list, so that needed the new file too.
- [x] 2.4 Confirm `migrations.test.ts` passes, including the runner's pre-commit `PRAGMA foreign_key_check` gate.

## 3. Verify the index is actually used

- [x] 3.1 Re-run 1.3: every one of the four reads must now show the composite index in its plan. A `CREATE INDEX` that the planner ignores is pure write cost.
      All four do, in every scope and at every size. Pinned as a permanent guard in `memory-repository.perf.test.ts` ("confirmations composite index on the review axis"): each read's plan is explained and every line touching `confirmations` must name the composite index. The five new cases fail with the migration removed.
- [x] 3.2 Re-run 1.1 and record the delta. Expect roughly 25–45% at 20k; if the measured gain is inside noise, stop and reconsider rather than shipping an unused index.
      **Deviation — the 25–45% figure only holds at a denser corpus than this task assumes.** At the ~1.05 confirmations/memory the task specifies, the measured gain at 20k is 3.8 / 8.2 / 6.7 / 20.1% (find / count / adminCount / decay) — the first three at or inside run-to-run noise. The gain is a function of confirmation density, not of row count: at 4 confirmations/memory it is 38.0 / 38.5 / 40.5 / 30.4%, and at 12 it is 65.6 / 63.6 / 60.2 / 31.5%. Shipped anyway because the stop condition ("an index the planner ignores") is disproven by 3.1/3.3 — the index is selected and covering everywhere, is never slower on any read at any size, and costs nothing measurable on writes (4.2) — while the benefit grows monotonically with re-affirmation, which is what `memory.confirm` does over a corpus's life. Figures recorded in the spec as density-dependent rather than as one number.
- [x] 3.3 Confirm the subqueries are covered (no table access for the confirmation lookup).
      `SEARCH confirmations USING COVERING INDEX confirmations_memory_verdict_ts_idx (memory_id=? AND verdict=?)`, and `(… AND event_ts>?)` for the refutation-recency subquery. Asserted, not just observed.

## 4. Resolve the redundant-index question (design.md Q1)

- [x] 4.1 Measure `countConfirmations` and the `insertConfirmation` path with and without `confirmations_memory_id_idx` present alongside the composite.
      `countConfirmations` is ~15 µs/call in every arm; the between-arm spread over 200 calls is ~1 ms, i.e. ~5 µs/call, at timer granularity. With the composite present the planner picks it and the read becomes covering, so the single-column index serves nothing the composite does not.
- [x] 4.2 Measure insert throughput on `confirmations` with three versus four indexes — this is the actual cost of keeping both.
      5 000 inserts into a 20 000-memory corpus, four runs. before (3 idx): 77.9 / 88.1 / 90.5 / 80.2 ms · composite added (4 idx): 80.3 / 91.8 / 83.2 / 81.7 ms · composite replacing memory_id (3 idx): 76.7 / 94.2 / 84.3 / 83.1 ms. Run-to-run spread (~15%) exceeds any between-arm difference: the fourth index costs nothing measurable, ~17 µs/insert in every arm.
- [x] 4.3 Decide and record. Default to keeping the single-column index if the difference is inside noise; dropping an index needs a rebuild-free `DROP INDEX` but is harder to reverse than never adding one.
      **Kept, per the stated default — the difference is inside noise on both the read and the write side.** Recommendation left for a human rather than acted on: `confirmations_memory_id_idx` is now provably redundant by coverage (the composite's leftmost column serves every lookup it served, and the planner prefers the composite wherever both apply), so dropping it is defensible — but it buys nothing measurable, and a `DROP INDEX` is harder to reverse on a large install than never having created one. If it is dropped, that belongs in its own change with its own before/after.
- [x] 4.4 Do NOT touch `confirmations_event_ts_idx` here (Q2) — it needs its own measurement and is out of scope.
      Untouched. The harness now takes `REMBRIC_BENCH_{SIZES,REPEATS,CONFIRMS}`, so whoever picks up Q2 has the measurement rig.

## 5. Specs

- [x] 5.1 `data-access`: add a requirement that the review-axis reads are served by a composite index over `(memory_id, verdict, event_ts)` and NOT by a `LEFT JOIN` + `GROUP BY` rewrite, with the measured figures and the crossover (the join loses at 50k). State it as measured-relative ordering, not absolute latency.
      Re-measured rather than citing the proposal, since the requirement is normative. **The join is worse than the proposal reported: it loses at 20k too** (12.8 vs 8.7 ms), not only at 50k (35.8 vs 23.5 ms), with verified-identical result sets, and its disadvantage widens with confirmation density (86.8 vs 32.5 ms at 12/memory). There is therefore no crossover to record — stated as such, with the plan showing why (two `MATERIALIZE` passes over all of `confirmations` plus two `AUTOMATIC COVERING INDEX` builds). Comparison harness kept in the bench file.
- [x] 5.2 `persistence`: record the index in the DDL, matching how that file already pins index and trigger names for other tables.
- [x] 5.3 Cross-reference from `reconcile-specs-with-shipped-behaviour` that this closes the deferred `needsReviewExprs` finding, so the two changes do not both claim it.
      Already in place at that change's `proposal.md` (the deferred finding is assigned here and explicitly not re-adopted there); verified rather than re-added.

## 6. Verify

- [x] 6.1 `pnpm run typecheck` · `pnpm run lint` · `pnpm test`.
      All three clean: 100 files / 1493 tests passed. The bench file reports 9 tests skipped, confirming the gate costs the suite nothing.
- [x] 6.2 Real Docker smoke against pre-existing seeded data: the migration must apply cleanly to a populated `confirmations` table, and the dashboard review counters plus `memory.context`'s review queue must return the same rows as before. A pure index addition changing any result set means the query was relying on scan order.
      Dev stack brought up with `0025` held back, so the seeded corpus reached schema 0024 first; `confirmations` was then populated through the real write path (`memory.confirm` over MCP — 12 events, 9 affirm / 3 refute, several memories carrying two). Restoring the migration file made the server's own boot-time runner apply it to that populated table: index created, `PRAGMA foreign_key_check` empty, all 12 rows intact. Index-absent vs index-present on identical code and data returned identical result sets — `adminCountNeedsReview` 6 → 6 and `adminFindNeedsReview` the same six ids in the same order, `memory.context.needsReview` the same three ids with the same `needsReviewTotal` of 6. `EXPLAIN QUERY PLAN` on the live database reports `confirmations USING COVERING INDEX confirmations_memory_verdict_ts_idx`.
- [x] 6.3 Confirm the migration is idempotent across restarts (runner-tracked) and that a fresh install and an upgraded install end with identical `sqlite_master` index sets.
      Three consecutive boots against the populated database: `_migrations` keeps exactly one row for `0025`, the index stays present, and the 12 confirmation rows are untouched. Rolling the row back and re-running the runner re-applied it cleanly, so the upgrade path is repeatable and not just first-run luck. Fresh-vs-upgraded convergence is covered by the pre-existing `migrations.test.ts` case "reaches an identical sqlite_master, indexes included, from every migration cut-point", which passes with the new migration in the set.
