## 1. Remove dead op producers

- [x] 1.1 Delete `applyMerge`, `applySupersede`, `recordNoop`, `recordFailed` and the `MergeOpInput` / `SupersedeOpInput` types from `apps/server/src/consolidation/operations.ts`. Leave `applyDecay`, `recordOrphanPromote`, `undoOp`, `undoRun` (and their `merge`/`supersede`/`orphan_promote` branches) untouched. _(Also removed the now-dead `dedupeTags` helper + `Memory` import; refreshed the file docstring.)_
- [x] 1.2 Remove the corresponding `export {…}` / `export type {…}` lines from `apps/server/src/consolidation/index.ts`.
- [x] 1.3 Remove the now-dead producer tests from `apps/server/src/consolidation/operations.test.ts`; the `undoOp` history tests were rewritten to seed a historical `merge` op directly (the producer is gone) — faithful to the spec's "historical op is undoable" scenario.

## 2. Removed-exports guard

- [x] 2.1 A guard already existed at `apps/server/src/consolidation/removed-exports.test.ts` (the `9.13` source-scan). Added `applyMerge`/`applySupersede`/`recordNoop`/`recordFailed` to its `FORBIDDEN_SYMBOLS` instead of creating a duplicate.

## 3. Migration: drop `llm_*`, tighten `scope`, rename FK column

- [x] 3.1 Added `apps/server/src/db/migrations/0015_tidy_consolidation_journal.sql` — rebuild of `consolidation_runs` (drop `llm_*`, `scope` NOT NULL with `COALESCE(scope,'unknown')` backfill, recreate index) + `ALTER TABLE consolidation_ops RENAME COLUMN consolidation_id TO run_id` + index recreate. No pragmas (runner handles FK safety).
- [x] 3.2 Schema: removed `llmProvider`/`llmModel`; `scope` `.notNull()`; field `consolidationId`→`runId` (column `run_id`); index → `consolidation_ops_run_id_idx`.
- [x] 3.3 Removed the `llmProvider: null, llmModel: null` literals in `services/{agent-sessions,prompts,memory}.ts`.
- [x] 3.4 Removed the dead `run.llmModel` branch in `apps/server/src/dashboard/consolidation.ts`.

## 4. Code rename `consolidationId` → `runId`

- [x] 4.1 Renamed every `consolidationId` reference to `runId` (operations.ts op inputs, runner.ts, consolidation-repository.ts where-clauses, the three services' `insertOp` calls, dashboard). Fixed raw-SQL test inserts (`memory.test.ts`) to use `run_id` + provide `scope`. `grep -rn consolidationId apps/server/src` is clean.

## 5. Spike + conditional `archive` enum trim

- [x] 5.1 Spike: `'archive'` op*type has NO producer anywhere (code/seed/fixtures/SQL); it appeared only in the enum + two `undoOp` branches. The spec's historical-op list (merge/supersede/orphan_promote) also excludes it. No queryable DB held `archive` rows. Conclusion: zero rows → safe to trim. *(Caveat: a real prod DB could not be queried from here; recorded in design Open Questions.)\_
- [x] 5.2 Removed `'archive'` from the `ConsolidationOpType` union + the `op_type` enum, and collapsed the two `op.opType === 'archive'` branches in `operations.ts` into the `decay` path.

## 6. Comments

- [x] 6.1 Fixed the schema docstring typo ("consolidation consolidation" → "consolidation sweep") and the `reasoning` column comment ("Free-form LLM reasoning" → "Deterministic reasoning string attached by the sweep").

## 7. Spec + verify

- [x] 7.1 `openspec validate tidy-consolidation-journal --strict` passes.
- [x] 7.2 `pnpm run typecheck` and `pnpm run lint` pass.
- [x] 7.3 Full server suite passes (829 passed, 1 pre-existing skip), including the rewritten historical-undo tests and the expanded removed-exports guard.
- [x] 7.4 Added a dedicated migration test (`migrations.test.ts`) that populates the pre-0015 schema (llm cols + NULL-scope legacy run + historical merge op + decay op), applies 0015, and asserts: columns dropped, scope backfilled to 'unknown', column renamed to `run_id`, index recreated, FK integrity clean, and every run/op row preserved.

## Note for review (judgment call)

`test/runtime-invariants.test.ts` previously had two `13.9` tests asserting that `applyMerge`/`applySupersede` _reject_ cross-scope inputs. Those guards lived inside the now-deleted producers, so the tests were removed. The "consolidation never crosses scope" invariant is still covered by (a) the deterministic sweep operating one (scope, project) tuple at a time, and (b) the surviving generic op-walk test in the same file. Flagging in case you want a belt-and-suspenders runner-level scope test added.
