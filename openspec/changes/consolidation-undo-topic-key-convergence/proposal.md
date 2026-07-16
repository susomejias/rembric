## Why

`topic_key` convergence is a load-bearing invariant: at most one `active` memory may exist per `(scope, project_id, topic_key)` slot, and `saveWithTopicKey` upholds it by atomically superseding the previously-active row (`memory` spec, "Memories MAY upsert by `(scope, project_id, topic_key)`"). Consolidation `undoOp` can silently break it.

`undoOp` (`apps/server/src/consolidation/operations.ts:118`) reactivates a memory's affected rows unconditionally (`reactivate(op.affectedIds)` for `decay`/`merge`/`supersede`; `reactivateOne(rel.targetId)` for `orphan_promote`). Consider:

1. Memory R with `topic_key = K` is archived by the decay sweep (or superseded by a legacy `supersede`/`merge` op, or its supersedes-relation orphan-promoted).
2. A later `memory.save({topic_key: K})` finds no active row in that slot (`findActiveByTopicKey` filters `status='active'`), inserts a fresh active head N, and links `replaces = [..]`.
3. The operator undoes the original op from `/dashboard/consolidation`. `undoOp` flips R back to `active`.

Now **R and N are both `active` in the same `(scope, project_id, K)` slot.** Nothing detects it: the partial index `memory_topic_key_active_idx` is NON-unique (`persistence` spec / migration 0016). The next `saveWithTopicKey` for K calls `findActiveByTopicKey(...).limit(1)` and supersedes an arbitrary one of the two, silently breaking the "supersede THE previously-active row" guarantee; candidate detection and confirmations that walk the slot see an ambiguous head.

## What Changes

- **`undoOp` becomes convergence-aware.** Before reactivating any affected row (and the `orphan_promote` target), it loads the rows and, for each that carries a non-null `topic_key`, checks whether the `(scope, project_id, topic_key)` slot is already occupied by a _different_ active row. A row whose slot is occupied is **not** reactivated (it stays `archived`/`superseded`); the rest of the op is undone normally. `undoOp` returns a structured result naming the rows it skipped, and the dashboard surfaces a notice so the operator knows the undo was partial and why (the topic is now owned by a newer memory).
- **The DB enforces convergence.** The partial index `memory_topic_key_active_idx` is replaced by a UNIQUE partial index with the same predicate, so a second active row in a slot is rejected by SQLite regardless of code path (backstop for `undoOp` and any future writer). A migration heals any pre-existing duplicate-active slots deterministically before adding the constraint.

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `consolidation`: the "Every consolidation operation MUST be reversible" requirement is amended so undo MUST NOT create a second active row in an occupied `topic_key` slot; it skips such a row and reports it, rather than reactivating it.
- `persistence`: the `topic_key` partial index requirement changes from a plain index to a UNIQUE partial index, and adds a migration requirement to heal pre-existing duplicates before the constraint is applied.

## Impact

- **Touched paths (implementation)**: `apps/server/src/consolidation/operations.ts` (`undoOp` occupancy check + return shape), its callers that consume the result (`undoRun` in the same file; `apps/server/src/dashboard/consolidation.ts` per-op/run undo handlers; `apps/server/src/consolidation/index.ts` re-exports; `apps/server/src/server/bootstrap.ts`), a new index migration under `apps/server/src/db/migrations/`, and the Drizzle schema comment noting the index is now UNIQUE. A read helper on `MemoryRepository` may be added if `unsafeGetByIds` (already returns `scope`/`projectId`/`topicKey`) is not sufficient — it is, so likely none.
- **Migration**: index-only DDL (`DROP INDEX` + `CREATE UNIQUE INDEX`), no table rebuild, so no `foreign_keys` dance is required. A pre-pass heals existing duplicate-active slots (keep the most-recently-created active row per slot; transition the older ones to `superseded` — a legal append-only status flip; content is never touched, nothing is deleted).
- **Behavioral change (intended)**: an undo that would resurrect a superseded/decayed row into an already-owned topic slot now leaves that row untouched and tells the operator, instead of silently producing two active heads. All other undo behavior (purged-row blocking, merge archive-of-created, reverse-order run undo) is unchanged.
- **Invariants**: restores and now DB-enforces `topic_key` convergence; append-only is preserved (only status flips, no deletes/content edits); every op stays journaled and its revert recorded.
- **Validation**: unit tests for the decay-then-resave-then-undo race (R stays archived, N stays the sole active head, undo result names R as skipped) and the orphan_promote analogue; a migration test that heals a seeded duplicate-active slot and then rejects a manual second active insert; regression across `operations.test.ts` and `runtime-invariants.test.ts`. Plus the mandatory local e2e against `pnpm run dev:docker:up` (dashboard undo shows the partial-undo notice).

## Notes / Out of Scope

- Adjacent undo-correctness nit found in the same function (`prompt_purge` — and `noop`/`failed` — fall through `undoOp` to `markReverted` and are reported as reverted despite being terminal/irreversible) is **out of scope** here; it is a one-line addition to the terminal `NotUndoableError` list and can ride along only if the reviewer wants it. Flagged so it is not forgotten.
