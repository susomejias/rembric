## 1. Migration

- [x] 1.1 `apps/server/src/db/migrations/0021_memory_replaces_table.sql`: `CREATE TABLE memory_replaces (predecessor_id TEXT NOT NULL, successor_id TEXT NOT NULL, PRIMARY KEY (predecessor_id, successor_id)) WITHOUT ROWID`.
- [x] 1.2 Backfill: `INSERT INTO memory_replaces SELECT je.value, m.id FROM memory m, json_each(m.replaces) je`.
- [x] 1.3 `memory_replaces_ai` (`AFTER INSERT ON memory`), `memory_replaces_au` (`AFTER UPDATE OF replaces ON memory`), `memory_replaces_ad` (`AFTER DELETE ON memory`).
- [x] 1.4 Migration test: backfill correctness + all three triggers, against a fixture with a multi-hop chain.

## 2. Repository

- [x] 2.1 `findSuccessorId`: rewrite to join `memory_replaces` → `memory`.
- [x] 2.2 `PURGE_PREDICATE`: rewrite the first clause to `NOT IN (SELECT predecessor_id FROM memory_replaces)`.
- [x] 2.3 Tests: `findSuccessorId` unchanged behavior on existing fixtures; purge predicate unchanged behavior on existing `purgeDisconnectedArchived` suite (no new failures).
- [x] 2.4 Perf-characterization test demonstrating the lookup no longer scans the full table.

## 3. Spec + validation

- [x] 3.1 `persistence` spec delta: ADD requirement for the `memory_replaces` derived table.
- [x] 3.2 `memory` spec delta: MODIFY "Memories MAY be physically purged when archived and disconnected".
- [x] 3.3 `openspec validate materialize-memory-replaces --strict`.
- [x] 3.4 `pnpm typecheck`, `pnpm lint`, full `pnpm test`.
- [x] 3.5 Commit, `openspec archive --yes`, `openspec validate --specs`, push, open PR closing #268 (note the migration-number dependency on PR #271 in the description).
