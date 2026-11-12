## Why

When a memory leaves `active`, its pending save-time judgments stay `pending`, although no agent can judge them any more: the agent queue withholds them and a `supersedes` verdict on them is refused. The change `drain-stale-save-time-pendings` closes these rows in the consolidation sweep, but only after the fact (at most one sweep per day per project, in bounded batches), so the unadjudicable state still exists between a retirement and the next sweep, and it inflates the operator-facing pending counts in the meantime. On a backup copy of a real installation, 28% of the pending rows had a retired endpoint (issue #466). This change closes those rows at the moment the memory is retired, inside the same transaction, on every retirement path, and keeps the drain as the safety net.

## What Changes

- **Orphan at retirement.** Every write path that flips a memory from `active` to `superseded` or `archived` SHALL orphan, in the SAME transaction, every pending `memory_relations` row that has the retired memory as its source or its target, whatever the other endpoint's status. The paths are:
  - a `topic_key` revision (`MemoryService.saveWithTopicKey`);
  - a judged `supersedes`, through `memory.judge` or `memory.compare` (`RelationsService.applySupersedesSideEffect`);
  - a `memory.merge` commit (`MemoryService.commitMerge`);
  - the `memory.archive` tool and the dashboard archive actions, which share `MemoryService.archive`;
  - the decay pass of the sweep (`applyDecay`);
  - a merge undo, which archives the merged successor (`undoOp`).
- **One helper, reused primitives.** One core helper, `orphanPendingOnRetirement`, is called inside each path's existing transaction. It calls the existing `RelationsService.orphan` and `recordOrphanPromote` with one timestamp per retirement, the single-timestamp orphaning the drain introduced, and it writes no second orphan-and-journal path.
- **Journal.** Each orphaning is journaled as an `orphan_promote` op, undoable like any other. Its reasoning carries its own prefix, `endpoint retired at retirement`, distinct from the deadline, rules-drain and retired-endpoint-drain prefixes. A retirement that already journals its own op (`merge`, `agent_memory_archive`, `decay`) journals the orphanings in that op's run. A retirement that journals no op today (a `topic_key` revision, a judged `supersedes`, a merge undo) opens one `maintenance` run of kind `retirement_orphan`, only when it has something to orphan.
- **Atomic.** The retirement, its orphanings and their journal ops commit or roll back together. A failure in any of them fails the retirement, exactly as a failed `agent_memory_archive` journal insert already fails `memory.archive`.
- **Undo symmetry.** Undoing a journaled retirement (`decay`, `agent_memory_archive`, `merge`) also restores, in the same undo transaction, the pending judgments that retirement orphaned, through the existing `orphan_promote` undo branch and its guard: a verdict written after the orphaning is kept and reported. A judgment whose endpoint is still retired after the undo (its topic slot is now taken, or the other endpoint was retired since) is left orphaned, its op stays active, and the undo reports it. A `topic_key` revision, a judged `supersedes` and a merge undo have no undo today, and this change does not invent one; their orphanings stay individually undoable.
- **Enforcement.** An invariant test enumerates every repository method that flips a memory to `superseded` or `archived`, and every call site of those methods in the server's source roots, and fails when a call site's function does not call the helper after the flip. A control proves the scan reports a real retirement path with its helper call removed.
- **Visible surfaces.** The `memory.merge` preview warning `pending_judgments` and the tool description now say that pending judgments on an original are closed when the merge commits, instead of "they stay pending". The dashboard's partial-undo message gains one note for judgments a retirement undo left orphaned. `UndoResult` and `UndoRunResult` gain `alsoReverted` and `keptOrphaned`.
- **Safety net kept.** The drain from `drain-stale-save-time-pendings` keeps running unchanged. It still closes rows that predate this change, and rows an operator restored by undoing an orphaning.

Behaviour change, not marked **BREAKING**: a retired memory's pending judgments become `orphaned` immediately instead of waiting for the sweep. No MCP input or output schema changes, and no schema change or migration.

Invariants touched:

- **Append-only memory:** intact. No memory row is written by the helper. Only `memory_relations.status` flips from `pending` to `orphaned`, journaled and reversible.
- **Journaled, reversible consolidation:** every orphaning is journaled in the same transaction as the retirement, and undoing the retirement restores it.
- **Scope at the service layer:** unchanged. A pending pair is same-scope by construction (`createPending` refuses a cross-scope pair), and the helper reads only the rows that touch the retired memory.
- **Fresh-context judgment:** the queue loses only pairs it already withholds. A memory that is reactivated by an undo gets its pairs back.
- **`topic_key` convergence:** unchanged; the revision additionally closes the superseded row's pending pairs.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `consolidation`: adds "Retiring a memory MUST orphan its pending judgments in the same transaction" and "Undoing a retirement MUST restore the pending judgments it orphaned". Both are ADDED, so the requirements the parent changes modify ("Every consolidation decision MUST be journaled", "Every consolidation operation MUST be reversible", "The consolidation MUST be idempotent on stable input") are left untouched.
- `memory`: "A pending judgment MUST be withheld from the agent queue once either endpoint is retired" says the rows SHALL NOT be retired earlier and that the sweep SHALL remain the only mechanism that closes them. It is MODIFIED to say that retirement closes them, and that a withheld pending row now exists only when it predates this change or an operator restored it by undo. No parent change modifies it.
- `persistence`: adds "The `orphan_promote` op type MUST also record orphanings made at retirement", beside the requirement the drain change modifies.

## Impact

- **Code:**
  - `packages/core/src/consolidation/operations.ts`: `orphanPendingOnRetirement` and `RETIREMENT_ORPHAN_REASON`; `applyDecay` calls the helper; `undoOp` orphans the merge successor's pending judgments when it archives it, and restores a retirement's linked orphanings after reactivating; the `orphan_promote` undo branch is extracted so the restoration reuses it with its guard; `undoRun` leaves linked orphanings to their retirement's undo; `UndoResult` and `UndoRunResult` gain `alsoReverted` and `keptOrphaned`.
  - `packages/core/src/services/memory.ts`: `saveWithTopicKey`, `archive` and `commitMerge` call the helper; `journalMaintenanceOp` also returns its run id; the `pending_judgments` merge warning text.
  - `packages/core/src/services/relations.ts`: `applySupersedesSideEffect` takes the verdict's timestamp and calls the helper; the repository dependency gains `consolidation`.
  - `packages/core/src/consolidation/index.ts`: exports the new types.
  - `packages/db/src/repositories/relations-repository.ts`: `listPendingTouchingAny(memoryIds)`, an id-keyed read of pending rows by source or target.
  - `packages/mcp/src/server.ts`: the `memory.merge` description sentence about pending judgments.
  - `apps/web/src/app/dashboard/consolidation/undo-messages.ts`: the kept-orphaned note.
- **Tests:** `packages/core/src/consolidation/retirement.test.ts` (one test per path, rollback per path, undo symmetry, kept verdict, other endpoint retired), `packages/db/src/repositories/relations-repository.test.ts`, `apps/web/src/test/invariants.test.ts` (the retirement-path scan and its control), `apps/web/src/test/dashboard/consolidation.test.tsx` (the note), and existing tests whose setups retired an endpoint through a service and expected the pair to stay pending.
- **Measurements:** `openspec/changes/orphan-pendings-on-retirement/measurements/`: per-path cost before and after at 1 000, 20 000 and 50 000 memories, the mutation log, the drain-after-retirement confirmation, and a read-only count of verdicts recorded on retired-endpoint pairs.
- **Docs:** `README.md`, `docs/relations.md`, `docs/troubleshooting.md`.
- **No change to:** the database schema, migrations, MCP input or output schemas, plugins, the installer, dependencies, or the drain's selection, rules and bounds.
