## Why

`memory.replaces` is a JSON array on each `memory` row, so every "who supersedes X" / "what does X replace" query at the DB level is a full-table `json_each` scan. Two hot paths pay for this on every request:

- `findSuccessorId` (`db/repositories/memory-repository.ts`), called by `findHead` (`services/memory.ts`) in a loop of up to 64 hops — measured ~11ms per call, so a long supersede chain costs up to ~0.7s inside `memory.get` / `memory.confirm`. The dashboard memory-detail page's "Superseded by" link pays the same cost.
- The first clause of `PURGE_PREDICATE` (`memory-repository.ts`) — the disconnection check `MemoryService.purgeDisconnectedArchived` runs before physically deleting an archived row.

Materializing the reverse edge as its own indexed table turns both from a full scan into a primary-key probe (measured ~0.01ms, ~1000× faster for the successor lookup).

## What Changes

- New derived table `memory_replaces(predecessor_id, successor_id)`, `WITHOUT ROWID`, composite primary key — a plain reverse-edge index over `memory.replaces`.
- Backfilled once from `json_each(replaces)` over every existing row in the migration.
- Maintained automatically by three triggers on `memory` (`AFTER INSERT`, `AFTER UPDATE OF replaces`, `AFTER DELETE`) — the same trigger-driven derived-index pattern already used for `memory_fts`/`memory_vec`. Application code never writes to `memory_replaces` directly.
- `findSuccessorId` rewritten to join against `memory_replaces` instead of scanning `json_each` over the whole table.
- `PURGE_PREDICATE`'s disconnection clause rewritten to `NOT IN (SELECT predecessor_id FROM memory_replaces)`.
- `memory.replaces` itself is untouched — still the source of truth, still a JSON array, still append-only-safe (the table is derived, never authoritative, and is never read by application code as anything other than a performance index).

No behavior change: every scenario that passes today (successor resolution, purge eligibility, purge cleanup ordering) produces the identical result, only faster. `collectPredecessors` (services/memory.ts) is untouched — it already walks in-memory `replaces` arrays with µs primary-key lookups per hop, which the issue that prompted this change explicitly identifies as not the bottleneck.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `persistence`: ADD a requirement for the derived `memory_replaces` table (schema, backfill, trigger contract).
- `memory`: MODIFY the "Memories MAY be physically purged when archived and disconnected" requirement — the disconnection check (condition 2) and the purge transaction both now operate against `memory_replaces` instead of a live `json_each` scan.

## Impact

- New migration `apps/server/src/db/migrations/0021_memory_replaces_table.sql`. Depends on migration `0020` (from the in-flight `search-index-integrity` change / PR #271) already being present — this PR should merge after that one.
- `apps/server/src/db/repositories/memory-repository.ts` — `findSuccessorId`, `PURGE_PREDICATE`, `purgeByIds` (cleanup ordering).
- No Drizzle schema file for the new table — it is queried exclusively via raw SQL (same precedent as the virtual `memory_vec` table, which also has no `schema/*.ts` entry).
- New/extended tests: a migration-level backfill/trigger test (mirroring `db/migrations-0020.test.ts`'s style) and a repository perf-characterization test (mirroring `memory-repository.perf.test.ts` from `optimize-db-read-path`).
- Issue: #268.
