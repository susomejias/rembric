## Why

Three measured read-path costs hit the DB on hot paths: the maintenance dashboard runs an O(N²) purge-eligibility query (12.5 s at 50k rows), `memory.context` (the session-start tool) full-scans + temp-sorts `memory` on every call (14.8 ms at 50k), and the SQLite connection is under-tuned (no query-planner statistics, default page cache, no mmap). The connection-tuning contract has also silently drifted: the spec mandates only WAL, but the code already sets `synchronous`, `foreign_keys`, and `busy_timeout` — unspecified today. This change makes the tuning contract explicit and closes the two worst scans, all inside `apps/server/src/db/` with no client-facing behavior change.

## What Changes

- **Connection tuning (#263).** Specify the full PRAGMA contract on the writable connection: WAL + `synchronous=NORMAL` + `foreign_keys=ON` + `busy_timeout=5000` (heals existing drift) **plus** `cache_size=-65536` (64 MB), `mmap_size=268435456` (256 MB), `temp_store=MEMORY`, and `PRAGMA optimize` run after migrations and on `close()`. The **read-only** connection (CLI `status`) currently skips all pragmas — apply the read-only-safe subset (`busy_timeout`, `cache_size`, `mmap_size`, `temp_store`) but never the write pragmas or `optimize`/`ANALYZE`.
- **Expression index for `recentForContext` (#265).** Add `memory_scope_seen_idx` on `(scope, project_id, COALESCE(last_seen_at, created_at) DESC)` so the `memory.context` ordering uses an index instead of a full scan + temp b-tree.
- **Purge predicate rewrite (#264).** Rewrite `PURGE_PREDICATE`'s correlated `NOT EXISTS (… json_each …)` subqueries as `NOT IN` so each reference set materializes once. **Behavior-preserving** — identical purge-eligible set — so this carries no spec delta; it lands as an implementation + regression-test task. The `consolidation_ops.created_id` NULL-guard (`WHERE created_id IS NOT NULL`) is load-bearing for `NOT IN` correctness.

No breaking changes. No invariant changes (append-only, scope-at-service, `topic_key`, judgment freshness all untouched). Migrations are additive (`CREATE INDEX` only).

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `persistence`: MODIFY the connection-initialization requirement to specify the full PRAGMA tuning contract (writable + read-only connections, `PRAGMA optimize` timing). ADD a requirement for the `memory_scope_seen_idx` expression index backing `recentForContext`.

## Impact

- `apps/server/src/db/client.ts` — PRAGMA block on both the writable and read-only paths; `PRAGMA optimize` after migrations and on `close()`.
- `apps/server/src/db/migrations/` — one additive migration adding `memory_scope_seen_idx`.
- `apps/server/src/db/repositories/memory-repository.ts` — `PURGE_PREDICATE` rewrite (`:820-834`); `recentForContext` (`:114-129`) ordering must emit SQL matching the indexed expression.
- Tests: a regression test asserting the `NOT IN` and `NOT EXISTS` purge predicates select an identical id set; `EXPLAIN QUERY PLAN` assertions that `recentForContext` uses `memory_scope_seen_idx` (`SEARCH … USING INDEX`, not `SCAN … TEMP B-TREE`).
- Issues: #263, #264, #265.
- No dependency, API, or client changes.
