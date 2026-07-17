## 1. Connection tuning (#263)

- [x] 1.1 In `apps/server/src/db/client.ts`, extend the writable-connection pragma block with `cache_size = -65536`, `mmap_size = 268435456`, and `temp_store = MEMORY` (keep WAL, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`).
- [x] 1.2 Add a read-only pragma block (applied when `opts.readonly`) setting only `busy_timeout=5000`, `cache_size=-65536`, `mmap_size=268435456`, `temp_store=MEMORY`; never the write pragmas or `optimize`/`ANALYZE`.
- [x] 1.3 Run `PRAGMA optimize` on the writable connection immediately after `migrate(...)` completes, and again inside `close()` (before `sqlite.close()`).
- [x] 1.4 Add a test asserting the writable connection reports the expected pragma values (`PRAGMA cache_size`, `mmap_size`, `temp_store`, `busy_timeout`) and that a read-only handle has `busy_timeout=5000` (not 0) and does not error.

## 2. recentForContext expression index (#265)

- [x] 2.1 Add an additive migration under `apps/server/src/db/migrations/` creating `CREATE INDEX memory_scope_seen_idx ON memory (scope, project_id, COALESCE(last_seen_at, created_at) DESC)`. Regenerate/adjust Drizzle metadata so the schema-drift CI test passes.
- [x] 2.2 Confirm the `recentForContext` `orderBy` SQL (`memory-repository.ts:126`) emits `COALESCE(last_seen_at, created_at)` text matching the index DDL; if Drizzle quoting diverges, pin the `orderBy` string to match.
- [x] 2.3 Add an `EXPLAIN QUERY PLAN` test asserting `recentForContext` reports `SEARCH memory USING INDEX memory_scope_seen_idx` and NOT `SCAN memory` + `USE TEMP B-TREE FOR ORDER BY`.
- [x] 2.4 Add a test asserting `recentForContext` returns identical rows/order over a fixture mixing `active`/`superseded`/`archived` rows with some `last_seen_at` NULL.

## 3. PURGE_PREDICATE rewrite (#264, behavior-preserving — no spec delta)

- [x] 3.1 Rewrite `PURGE_PREDICATE` (`memory-repository.ts:820-834`) from correlated `NOT EXISTS` to the `NOT IN` form in design.md D1. Keep `WHERE created_id IS NOT NULL` on the `consolidation_ops.created_id` subquery — it is load-bearing for `NOT IN` NULL-safety.
- [x] 3.2 Add a regression test that builds a fixture including an archived memory referenced by (a) another row's `replaces`, (b) `consolidation_ops.created_id`, (c) `consolidation_ops.affected_ids`, (d) a `memory_relations` source/target, (e) a `confirmations.memory_id`, PLUS at least one `consolidation_ops` row with `created_id IS NULL`, and asserts the new `NOT IN` predicate and the original `NOT EXISTS` predicate select an identical id set (both `count` and `ids`).
- [x] 3.3 Add an `EXPLAIN QUERY PLAN` assertion (or a documented timing check) that the rewritten purge query no longer runs a per-archived-row correlated scan.

## 4. Validation

- [x] 4.1 `pnpm run typecheck` and `pnpm run lint` clean.
- [x] 4.2 `pnpm test` green (new pragma, index-plan, recentForContext-equivalence, and purge-equivalence tests included).
- [x] 4.3 Verify the schema-drift CI test passes with the new index present.
- [x] 4.4 Update issues #263, #264, #265 with the outcome, and run `openspec validate optimize-db-read-path --strict` before requesting review.
