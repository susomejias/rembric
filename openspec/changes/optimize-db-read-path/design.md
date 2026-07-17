## Context

All three items live under `apps/server/src/db/` and were measured against a throwaway DB built from the real migrations, seeded to 50k memories / 45k vectors (EXPLAIN QUERY PLAN + wall-clock):

- `PURGE_PREDICATE` (`memory-repository.ts:820-834`) runs correlated `NOT EXISTS (… FROM memory m2, json_each(m2.replaces) …)` — a full-table + `json_each` scan per archived row — on every maintenance dashboard render (`dashboard/maintenance.ts:193`). Measured **12,528 ms**.
- `recentForContext` (`memory-repository.ts:114-129`) orders by `COALESCE(last_seen_at, created_at) DESC` with no matching index → `SCAN memory; USE TEMP B-TREE FOR ORDER BY`. Measured **14.8 ms**, on the `memory.context` session-start hot path.
- `client.ts:55-64` sets WAL/`synchronous`/`foreign_keys`/`busy_timeout` but leaves `cache_size`/`mmap_size`/`temp_store` at defaults and never runs `ANALYZE`/`PRAGMA optimize`, so the planner has no statistics. The read-only connection guard skips the pragma block entirely.

Constraint: the `persistence` spec is authoritative, and the append-only invariants (no `DELETE` of live rows, no `content` UPDATE, journaled purge) must be untouched. This change adds an index and tunes the connection; it does not alter what data is stored or which rows any query returns.

## Goals / Non-Goals

**Goals:**

- Make the connection-tuning contract explicit in the spec (healing the WAL-only drift) and add the missing performance pragmas.
- Turn `recentForContext` and the purge-eligibility query from full scans into index/materialized-set lookups.
- Prove the purge rewrite is behavior-preserving with a regression test, and prove the index is actually selected with an `EXPLAIN QUERY PLAN` assertion.

**Non-Goals:**

- No change to purge _eligibility semantics_ — the same ids remain purgeable.
- No new mutation verbs, columns, or lifecycle states; review/decay derivation is untouched.
- Not addressing the supersede-graph materialization (issue #268), the FTS trigger fix (#254), the auth credential cache (#266), or the embedding poll (#267). #268 would later collapse the first clause of the purge predicate, but this change stands alone.

## Decisions

### D1. `NOT IN` rewrite of `PURGE_PREDICATE`, with a load-bearing NULL guard

Replace each correlated `NOT EXISTS` with a `NOT IN` against a subquery that materializes once:

```sql
m.status = 'archived'
AND m.id NOT IN (SELECT je.value  FROM memory m2, json_each(m2.replaces) je)
AND m.id NOT IN (SELECT created_id FROM consolidation_ops WHERE created_id IS NOT NULL)
AND m.id NOT IN (SELECT je2.value FROM consolidation_ops co, json_each(co.affected_ids) je2)
AND m.id NOT IN (SELECT source_id  FROM memory_relations)
AND m.id NOT IN (SELECT target_id  FROM memory_relations)
AND m.id NOT IN (SELECT memory_id   FROM confirmations)
```

**Why `NOT IN` over `NOT EXISTS`:** SQLite runs the correlated `NOT EXISTS` variant as a per-row re-scan; `NOT IN` lets it build each reference set once. Measured **10.3 ms vs 12,528 ms (~1200×)**, identical result set.

**NULL-safety (critical):** `x NOT IN (SELECT col …)` evaluates to NULL — which excludes the row — if _any_ value in the subquery is NULL. If that happened here the predicate would silently stop marking _anything_ purgeable. Verified column nullability against the schema:

| Subquery source                                   | Nullable?                                               | Guard                              |
| ------------------------------------------------- | ------------------------------------------------------- | ---------------------------------- |
| `json_each(memory.replaces).value`                | `replaces` is `NOT NULL DEFAULT '[]'` → values non-null | none                               |
| `consolidation_ops.created_id`                    | **nullable**                                            | **`WHERE created_id IS NOT NULL`** |
| `json_each(consolidation_ops.affected_ids).value` | `affected_ids` is `NOT NULL` → values non-null          | none                               |
| `memory_relations.source_id` / `target_id`        | `NOT NULL`                                              | none                               |
| `confirmations.memory_id`                         | `NOT NULL`                                              | none                               |

The `created_id IS NOT NULL` guard is the single load-bearing correctness detail and MUST be covered by the regression test.

**Alternative considered:** `NOT EXISTS` with supporting indexes on `json_each` — rejected, because `json_each` over a JSON column can't be indexed directly, and the reverse-edge table that would fix it (#268) is a separate, OpenSpec-gated architectural change.

### D2. Expression index `memory_scope_seen_idx`, exact-match with the query text

The planner only uses an expression index when the query's ordering expression normalizes to the indexed expression. `recentForContext` emits raw SQL `COALESCE("last_seen_at", "created_at") DESC` (line 126); the index DDL must use the identical `COALESCE(last_seen_at, created_at)` shape. Verification is an explicit task: `EXPLAIN QUERY PLAN` must show `SEARCH memory USING INDEX memory_scope_seen_idx`, not `SCAN` + `USE TEMP B-TREE`. If Drizzle's quoting causes a mismatch, pin the `orderBy` SQL string to match the DDL rather than loosen the index.

**Alternative considered:** two separate plain indexes on `last_seen_at` and `created_at` — rejected; the planner can't combine them for a `COALESCE` sort, so the temp b-tree would remain.

### D3. Split the pragma set by connection writability

Writable connection: full set + `PRAGMA optimize` after migrations and on `close()`. Read-only connection: the read-only-safe subset only (`busy_timeout`, `cache_size`, `mmap_size`, `temp_store`) — never `journal_mode`/`synchronous`/`foreign_keys` (write pragmas) or `optimize`/`ANALYZE` (they write `sqlite_stat1`). This fixes the current `busy_timeout=0` on the read-only CLI `status` path (immediate `SQLITE_BUSY` risk under a concurrent writer) without attempting writes on a read-only handle.

## Risks / Trade-offs

- **[Index not selected because Drizzle SQL text differs from the DDL]** → EQP assertion task gates it; if it mismatches, pin the `orderBy` string. Low residual risk.
- **[`NOT IN` NULL footgun reintroduced by a future edit]** → regression test asserts the rewritten predicate and the original `NOT EXISTS` predicate select an identical id set over a fixture that includes a `consolidation_ops` row with `created_id IS NULL`.
- **[`mmap_size`/`cache_size` raise per-process memory]** → 256 MB mmap is virtual address space (paged on demand), 64 MB cache is a ceiling, not a reservation; negligible for the single-process server. Values are pinned in the spec so they're reviewable.
- **[`PRAGMA optimize` on `close()` adds shutdown latency]** → optimize only analyzes tables whose stats are stale; typically sub-ms to low-ms. Acceptable at graceful shutdown.

## Migration Plan

1. Add one additive migration: `CREATE INDEX memory_scope_seen_idx …` (index-only DDL, no table rebuild, safe under the migration runner's FK-off wrapper).
2. Update `client.ts`: expand the writable pragma block, add the read-only pragma block, add `PRAGMA optimize` after `migrate(...)` and in `close()`.
3. Rewrite `PURGE_PREDICATE`.
4. Rollback: drop the index (additive, reversible); revert `client.ts` and the predicate. No data migration, so rollback is code-only.

## Open Questions

- Should `PRAGMA optimize` also run on a periodic timer (e.g. alongside the consolidation sweep) rather than only at startup/shutdown for long-lived processes? Deferred — startup + shutdown is sufficient for current uptimes; revisit if a deployment runs for weeks without restart.
