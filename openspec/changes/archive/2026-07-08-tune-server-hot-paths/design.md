# Design — tune-server-hot-paths

## Context

sqlite-vec's vec0 virtual table supports partition-pruned exact kNN via `partition_key = ? AND embedding MATCH ? AND k = ?` — already used by `knnByQueryVector` (`vectors-repository.ts:78-97`). `knnByCosine` (save-time) predates it and self-joins the whole table. `orphanExpired` predates `listPendingOlderThanInScope` (`relations-repository.ts:287-322`) and still uses the unscoped `findPendingOlderThan` + JS-side scope filtering.

## Goals / Non-Goals

**Goals:** same observable results, radically less work; orphaning becomes fair across scopes.

**Non-Goals:**

- Changing `VEC_THRESHOLD` calibration or candidate ranking (results are identical by construction — exact kNN over the same scope-filtered set).
- Indexing the `replaces` JSON chain (`findSuccessorId` full-scan) — needs a schema/migration design of its own; explicitly deferred.
- Any dashboard-visible behavior change.

## Decisions

### D1: Save-time kNN = fetch self-embedding + `knnByQueryVector`

Two-step: `SELECT embedding FROM memory_vec WHERE memory_id = ?`, then the existing partition-pruned query with `k = requested + |excludeIds| + 1` and post-filter of self + excluded ids (vec0's `k` caps returned rows, so over-fetch by the exclusion count to keep result cardinality). Alternative — adding a partition predicate to the self-join — rejected: keeps a second bespoke kNN query alive when one exists; the two-step reuses the tested path.

### D2: Anchor-bounded similaritySample

Wrap the anchor side in `WHERE v_self.memory_id IN (SELECT memory_id FROM memory_vec ORDER BY memory_id DESC LIMIT :sample)` (joined against active memories as today). We do not rely on the query optimizer pushing LIMIT through a virtual-table GROUP BY. Distribution semantics change marginally (min-distance per anchor computed against all N, anchors bounded exactly as the LIMIT already intended) — the logged histogram keeps its meaning.

### D3: Scoped orphaning

`orphanExpired(scope)` calls a scoped repository method (reuse/derive from `listPendingOlderThanInScope`, returning `judgmentId/sourceId/targetId` with the scope filter in SQL, ordered oldest-first, `LIMIT ORPHAN_BATCH`). The `if (!a || !b)` missing-memory branch is dropped: `PURGE_PREDICATE` excludes memories referenced by `memory_relations`, so a pending relation's endpoints cannot have been purged (documented by the invariant, enforced by existing tests). Per-scope batch budget = existing `ORPHAN_BATCH = 50`, now consumed only by the swept scope's rows.

### D4: `scopeCondition` helper

`db/repositories/scope-clause.ts` (home of the raw-SQL `scopeWhere`) gains the drizzle-builder sibling `scopeCondition(scope, projectId): SQL` used inside `and(...)`. The eight call sites migrate mechanically; the raw and builder idioms live side by side in one file so they evolve in lock-step.

## Risks / Trade-offs

- [Risk] Over-fetch arithmetic in D1 under-fills results when many excluded ids land in the top-k. → Mitigation: `k = requested + excluded + 1` guarantees cardinality; unit test with all-excluded neighbors.
- [Risk] D2 changes the sampled-anchor set ordering subtly. → Accepted: the sample was already `ORDER BY memory_id DESC LIMIT n`; semantics preserved, work bounded.
- [Trade-off] D3 makes total orphaning work per sweep O(scopes × batch) instead of O(batch). → Accepted because that is the SPEC'd intent (per-scope sweep) and each scoped query is index-friendly; the old shape was doing S× the query work anyway, discarding most rows.

## Migration Plan

No schema change; deploy is a normal server release. Rollback: previous image.

## Open Questions

(none)
