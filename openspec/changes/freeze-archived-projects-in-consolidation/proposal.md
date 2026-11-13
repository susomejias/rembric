## Why

An archived project is closed to agents, yet the consolidation sweep still treats it as live. A forced sweep decays its memories, because their `last_seen_at` can no longer advance. Its pending judgments never leave the queue, because no agent can judge them. They inflate the operator's pending count on every installation that archives a project with open judgments, and nothing ever closes them without manual cleanup. Archiving should freeze a project and close its open questions, and unarchiving should give both back.

## What Changes

- The consolidation sweep skips archived projects entirely:
  - in a forced `runAll` and in a session-start `sweepFor`;
  - no decay, deadline orphaning, stale-pending drain or `consolidation_runs` row is produced for them.
- Archiving a project orphans every pending judgment of that project in the same transaction as the `archived_at` write. Each orphaning is journaled as an `orphan_promote` op in a `maintenance` run with a distinct reason prefix, so it remains individually inspectable.
- Unarchiving a project restores to `pending`, in the same transaction, every judgment that one of its archive orphanings closed and that is still orphaned. A judgment that received a verdict since keeps it.
- On every process start, an idempotent and bounded reconciliation closes the pending judgments of projects that were already archived before this change. It is journaled exactly like an archive orphaning, so unarchive restores those rows too. It needs no operator action and is a no-op once converged.
- **BREAKING** (operator surface): undoing an archive orphaning from the dashboard, either as a single op or as its whole run, is refused while the project is archived. Unarchive is the restore path. Without this guard, an undo would re-open judgments that nothing can close.
- The archive confirmation dialog states that pending judgments are closed and come back on unarchive.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `consolidation`:
  - the sweep excludes archived projects;
  - archive orphanings are journaled with their own reason;
  - a boot reconciliation closes the pending judgments of already-archived projects;
  - undoing an archive orphaning is refused while its project is archived.
- `projects`:
  - archiving closes the project's pending judgments in the same transaction;
  - unarchiving restores those that are still orphaned.

The archive dialog copy is not specified by the `dashboard` spec, so it changes without a delta.

## Impact

- **Invariants touched:**
  - **Append-only memory:** no memory row is written; only `memory_relations.status` flips, each journaled in `consolidation_ops`.
  - **Every consolidation op reversible:** archive orphanings are undone by unarchive, and the single-op undo stays available once the project is active again.
  - **Scope at the service layer:** a relation never spans projects (`assertSameScope`), so the project of a judgment is its endpoints' `project_id`.
  - **Judgment freshness:** restored judgments re-enter the agent queue under the existing rules.
- **Code:**
  - `packages/core/src/services/projects.ts`: `archive`/`unarchive` become transactional and gain the relations, memory and consolidation repositories.
  - `packages/core/src/consolidation/operations.ts`: a project-archive orphaning helper and its restore, beside `orphanPendingOnRetirement`/`restoreRetirementOrphanings`, plus the undo guard in `undoOp`/`undoRun`.
  - `packages/core/src/consolidation/runner.ts`: `runAll`/`sweepFor` skip archived projects.
  - `packages/db/src/repositories/projects-repository.ts`: an active-ids read.
  - `packages/db/src/repositories/relations-repository.ts`: pending and orphaned reads by project.
  - `packages/db/src/repositories/consolidation-repository.ts`: live archive-orphaning ops by project.
  - `apps/web/src/lib/services.ts`: wiring.
  - `apps/web/src/lib/process.ts`: the boot reconciliation.
  - `apps/web/src/components/dashboard/projects-table.tsx`: dialog copy.
- **Tests:**
  - `packages/core/src/consolidation/*.test.ts` and `packages/core/src/services/projects.test.ts`;
  - `apps/web/src/test/invariants.test.ts` (purge allow-list untouched; no new `DELETE`).
- **No migration, no new dependency, no MCP tool change.**
- **Out of scope:** the consolidation-list filters (hide no-op and `maintenance` runs, issue #474), and any change to the drain's budget. Each goes in its own change.
