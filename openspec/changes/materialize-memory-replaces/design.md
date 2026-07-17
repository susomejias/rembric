## Context

`memory.replaces` (a JSON array, source of truth for the supersede chain) is read two ways today: in-memory, by `collectPredecessors` walking a row's own `replaces` array plus one `unsafeGetById` PK lookup per hop (µs-scale, not the bottleneck); and at the DB level, by `findSuccessorId` and `PURGE_PREDICATE`, both of which run `json_each(m.replaces)` over the _entire_ `memory` table to answer "which row's `replaces` contains this id" — the reverse direction, which a JSON array on the forward side cannot index. This change adds a derived reverse-edge table so that direction becomes an indexed lookup, without touching the forward-direction data or its append-only guarantees.

## Goals / Non-Goals

**Goals:**

- Turn `findSuccessorId` and `PURGE_PREDICATE`'s disconnection clause from full-table scans into primary-key probes.
- Keep `memory_replaces` purely derived: never authoritative, never written by application code, always reconstructible from `memory.replaces` by re-running the backfill.
- Preserve the append-only invariant on `memory` untouched — this change adds a new table and triggers, it does not alter `memory`'s schema or lifecycle.

**Non-Goals:**

- Not touching `collectPredecessors` — already µs-scale PK lookups, explicitly called out as fine in the issue that prompted this change.
- Not exposing `memory_replaces` through Drizzle's query builder or a repository method beyond the two existing call sites — it has no `schema/*.ts` file, matching the precedent of the virtual `memory_vec` table, which is also raw-SQL-only.
- Not adding new product-facing features (chain rendering in `memory.timeline`, purge-safety UI) — the issue notes this table enables them cheaply later, but this change is infrastructure only.

## Decisions

### D1. `WITHOUT ROWID`, composite primary key `(predecessor_id, successor_id)`

A plain reverse-edge table: one row per `(predecessor, successor)` pair. `WITHOUT ROWID` avoids the extra rowid B-tree — the composite PK is the only access path needed (`findSuccessorId` filters on `predecessor_id`, which is the PK's leading column, so it's an efficient prefix scan with no secondary index required). No `successor_id`-only index is added: the only reverse-of-reverse query today is `purgeByIds`' cleanup, which deletes by exact `(predecessor_id OR successor_id) = old.id`, a small, infrequent, batch operation where a full scan of a `WITHOUT ROWID` table (already sorted by PK) is cheap even without a second index.

### D2. Three triggers mirror the existing `memory_fts`/`memory_vec` derived-index pattern

- `memory_replaces_ai` (`AFTER INSERT ON memory`): inserts one row per element of `new.replaces` via `json_each`. Mirrors the one-time backfill's own `SELECT ... FROM json_each` shape.
- `memory_replaces_au` (`AFTER UPDATE OF replaces ON memory`): the only code path that updates `replaces` post-insert is `RelationsService`'s `supersedes` side effect (`setReplaces`, appends the target id to the source's `replaces`), so this trigger deletes the row's stale edges (`WHERE successor_id = old.id`) and re-inserts from `new.replaces`, the same delete-then-reinsert shape `memory_au` already uses for `memory_fts`.
- `memory_replaces_ad` (`AFTER DELETE ON memory`): defensive cleanup on both `predecessor_id = old.id` and `successor_id = old.id`. `PURGE_PREDICATE` already guarantees a purged row is never referenced as a `predecessor_id` (that's exactly the condition being checked), so that branch is normally a no-op; but the purged row itself may carry `successor_id = old.id` edges (it superseded something before being archived and later purged), and those must not survive the physical delete. Mirrors `memory_ad`'s defensive-but-correct posture for `memory_fts`.

### D3. `findSuccessorId` rewritten as a join, not a subquery

```sql
SELECT m.id
FROM memory_replaces mr
JOIN memory m ON m.id = mr.successor_id
WHERE mr.predecessor_id = ?
ORDER BY m.created_at DESC
LIMIT 1
```

The `ORDER BY created_at DESC LIMIT 1` is preserved verbatim from the current implementation — it exists to pick the newest successor if more than one row ever claims to replace the same predecessor (shouldn't happen in practice, but the current code doesn't assume it can't, so neither does this rewrite).

### D4. `PURGE_PREDICATE`'s first clause becomes a plain `NOT IN`

`SELECT je.value FROM memory m2, json_each(m2.replaces) je` → `SELECT predecessor_id FROM memory_replaces`. Same NULL-sensitivity discussion as the `optimize-db-read-path` change's `NOT IN` rewrite doesn't apply here since `memory_replaces.predecessor_id` is `NOT NULL` by construction (only ever populated from non-null JSON array elements) — no `WHERE ... IS NOT NULL` guard needed, unlike the `consolidation_ops.created_id` case in the same predicate.

### D5. Migration ordering dependency on `search-index-integrity` (#271)

The next available migration number as of this branch (cut from `main` before `search-index-integrity`/PR #271 merges) is `0020`, but that number is already claimed by PR #271's `0020_fix_fts_delete_triggers.sql`. This change uses `0021` and documents the dependency explicitly rather than risk a collision: **PR #271 must merge before this PR**, or this migration must be renumbered at merge time if ordering changes.

## Verification

- Migration test (new): apply `0021` against a seeded DB with a multi-hop supersede chain, assert the backfill populates the exact edge set `json_each(replaces)` would produce, assert `memory_replaces_ai`/`au`/`ad` keep the table in sync across an insert, a `setReplaces`-style update, and a purge-style delete.
- Repository test (extended `memory-repository.test.ts` or a new perf-characterization test): `findSuccessorId` returns the same result as before the change on a fixture with branching/ambiguous chains; a coarse timing assertion (same style as `optimize-db-read-path`'s `memory-repository.perf.test.ts`) demonstrating the join no longer scales with table size the way the `json_each` scan did.
- Full existing `MemoryService.purgeDisconnectedArchived` test suite stays green unmodified — the purge behavior is unchanged, only its implementation.
- `pnpm typecheck`, `pnpm lint`, full `pnpm test`.

## Migration Plan

Additive migration: new table, new triggers, one backfill `INSERT`. No column change on `memory`, no rebuild dance. Rollback is `DROP TABLE memory_replaces` plus dropping the three triggers — `memory.replaces` (the source of truth) is completely unaffected by a rollback, so this is safe to revert at any time without data loss.
