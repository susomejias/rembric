# Tune server hot paths: scoped kNN, bounded sampling, fair orphaning

## Why

Three hot paths do orders-of-magnitude more work than needed, one of them with a liveness defect. (1) Save-time candidate detection (`vectors-repository.ts::knnByCosine`, invoked on EVERY `memory.save`) brute-force self-joins the entire vector corpus across all scopes — no `partition_key` predicate, no vec0 `MATCH … k=` — while the interactive search path already prunes inside the index. (2) `similaritySample` (fired on every embedding-queue drain) cross-joins all active vectors against all active vectors: the `LIMIT` bounds output rows only, so the pairwise work is O(N²) regardless of the sample size. (3) The consolidation orphaning pass (`runner.ts::orphanExpired`) re-runs a GLOBAL oldest-50 query once per swept scope, does 2 per-row lookups (N+1) to filter by scope in JS, and — because scopes outside the global oldest-50 window are skipped and the per-scope throttle is 24h — a busy scope can starve another scope's overdue pendings for days. Alongside, four small tidies in the same files' orbit: dead `findActiveByScope`, duplicated `ScopeKey` interface, the hand-rolled drizzle scope-filter expression copy-pasted across ~8 repository methods, and `collectStats` issuing three separate memory COUNTs on the dashboard render path.

## What Changes

- **MODIFIED** save-time candidate kNN: read the saved row's embedding once, then reuse the partition-pruned `knnByQueryVector` (`partition_key = ? AND embedding MATCH ? AND k = ?`) scoped to the saved memory's `(scope, projectId)`, post-filtering excluded ids. kNN is exact in sqlite-vec, so candidate results and `VEC_THRESHOLD` calibration are unchanged — only the scanned set shrinks from whole-corpus to the scope shard.
- **MODIFIED** `similaritySample`: bound the anchor side explicitly (`v_self.memory_id IN (SELECT … ORDER BY memory_id DESC LIMIT :sample)`) so the join is `sample × N`, not `N × N`.
- **MODIFIED** orphaning pass: per-scope aged-pending selection (the join-based scoped query pattern of `listPendingOlderThanInScope` already exists) — eliminates the S× re-fetch, the per-row `findScopeTupleById` N+1, and cross-scope starvation. Journaling, undo, thresholds unchanged.
- **REMOVED** dead code: `memory-repository.ts::findActiveByScope` (+ `FindActiveByScopeOpts`, `includeGlobal` branch) — no production caller.
- **MODIFIED** internal tidy (behavior-preserving): single `scopeCondition(scope, projectId)` drizzle helper replacing the ~8 hand-rolled copies; one canonical `ScopeKey` export in `consolidation/`; `collectStats` memory counts collapsed into one grouped query.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `consolidation`: the deadline-orphaning requirement gains scoped-selection semantics (per-scope candidate query, per-scope batch budget — no cross-scope starvation).

## Impact

- `apps/server/src/db/repositories/vectors-repository.ts` (knnByCosine callers → partition-pruned path; similaritySample anchor bound).
- `apps/server/src/services/save-time-candidates.ts` (consume the pruned lookup).
- `apps/server/src/consolidation/runner.ts` (`orphanExpired`), `apps/server/src/db/repositories/relations-repository.ts` (scoped aged-pending query; `findPendingOlderThan` retired if unreferenced).
- `apps/server/src/db/repositories/memory-repository.ts` (dead-code removal; `scopeCondition` helper adoption).
- `apps/server/src/consolidation/{candidates,decay}.ts` (ScopeKey dedup), `apps/server/src/server/bootstrap.ts` (`collectStats` grouped count via a repository method — SQL stays under `db/`).
- Tests: existing co-located suites must stay green unchanged in their assertions (behavior-preserving except orphaning fairness, which gains a regression test).
- Invariants: append-only untouched (all read-side or status-flip paths); scope-at-service-layer strengthened; SQL confinement respected.
