# Tasks — tune-server-hot-paths

## 1. Save-time kNN partition pruning

- [x] 1.1 `vectors-repository.ts`: add self-embedding fetch; rework the save-time candidate lookup to reuse the partition-pruned kNN (`partition_key` + `MATCH` + `k = requested + excluded + 1`, post-filter self/excluded ids per design D1); retire `knnByCosine`'s full-corpus self-join if unreferenced afterwards.
- [x] 1.2 `services/save-time-candidates.ts`: consume the new path; existing candidate tests (`save-time-candidates.test.ts`) pass UNCHANGED assertions.
- [x] 1.3 Unit test: exclusion over-fetch keeps result cardinality when top-k neighbors are all excluded; cross-scope rows never appear as candidates.

## 2. Bounded similaritySample

- [x] 2.1 Anchor-side bound per design D2; verify the drain-time `logSimilarityDistribution` output shape is unchanged.
- [x] 2.2 Unit test with > sample active vectors asserting the anchor set is exactly the newest `sample` ids.

## 3. Fair scoped orphaning

- [x] 3.1 `relations-repository.ts`: scoped aged-pending selection (derive from `listPendingOlderThanInScope`; oldest-first, `LIMIT` batch); retire `findPendingOlderThan` if unreferenced.
- [x] 3.2 `consolidation/runner.ts::orphanExpired`: consume the scoped query; drop the per-row `findScopeTupleById` N+1 and the unreachable missing-memory branch (justified by `PURGE_PREDICATE` — cite it in the one licit comment if needed).
- [x] 3.3 Regression test for the starvation scenario (scope B's overdue row orphaned despite scope A having > batch overdue rows); journaling/undo tests stay green.

## 4. Tidies (behavior-preserving)

- [x] 4.1 Remove `findActiveByScope` + `FindActiveByScopeOpts` + its unit test (dead code; grep confirms no production caller).
- [x] 4.2 Add `scopeCondition(scope, projectId)` beside `scopeWhere` in `scope-clause.ts`; migrate the ~8 hand-rolled drizzle scope filters in `memory-repository.ts` mechanically.
- [x] 4.3 Single canonical `ScopeKey` export (keep `consolidation/candidates.ts`, re-point `decay.ts`).
- [x] 4.4 `collectStats` (bootstrap.ts): one grouped status count via a new unscoped repository method (dashboard-only caller — follow the `admin*` naming rule if it lands in that call path; otherwise a plain grouped count consumed by bootstrap).

## 5. Gates

- [x] 5.1 `pnpm run typecheck && pnpm run lint && pnpm test` green; invariant tests untouched and green.
- [x] 5.2 `openspec validate tune-server-hot-paths --strict` green.
