## 1. Sweep skips archived projects

- [ ] 1.1 Add `ProjectsRepository.listActiveIds()` (`archived_at IS NULL`). First write a RED test in `packages/core/src/consolidation/runner.test.ts`: a forced `runAll` over an active and an archived project, each with a decay-eligible memory and an over-deadline pending judgment, asserts that the archived project's memory, judgment and `consolidation_runs` rows are unchanged and the active project's are swept.
- [ ] 1.2 Switch `runAll` to `listActiveIds()`. Make `sweepFor` drop an archived session project. Add a RED test for `sweepFor` with an archived project id. Add a test that the default project's run and its empty-session purge still fire, with a non-zero purge count.
- [ ] 1.3 Add a test that an unarchived project is swept by the next forced sweep.

## 2. Archive orphans pending judgments (D2)

- [ ] 2.1 Add `PROJECT_ARCHIVE_ORPHANING_PREFIX` and an `orphanPendingOnProjectArchive` helper in `packages/core/src/consolidation/operations.ts`, beside `orphanPendingOnRetirement`. It reads the project's pending judgments through the source memory's `project_id`, opens the `maintenance` run with the `project_archive_orphan` summary, and calls `relations.orphan` + `recordOrphanPromote`. Extend the existing prefix test so all five reasons (deadline, rules drain, retired drain, retirement, project archive) are pinned as distinct.
- [ ] 2.2 Widen `ProjectsService` with the relations, memory and consolidation repositories, `RelationsService` and a `TransactionRunner`, and wire it in `apps/web/src/lib/services.ts`. Run `archive` in one transaction. Write the RED tests from the `projects` spec scenarios first, in `packages/core/src/services/projects.test.ts`: pending closed and judged untouched; other projects untouched; no run when there is nothing pending; default and already-archived refusals touch no judgment.
- [ ] 2.3 Add a test that a failure injected after the `archived_at` write rolls back both the archive and every orphaning.
- [ ] 2.4 Update the archive dialog copy, single and bulk, in `apps/web/src/components/dashboard/projects-table.tsx`: pending judgments are closed and come back on unarchive.

## 3. Unarchive restores (D3)

- [ ] 3.1 Add a consolidation-repository read for the live archive-orphaning ops of a project: `maintenance` runs with `kind = project_archive_orphan` and the `projectId`, then ops by `run_id` with the prefix and `reverted_at IS NULL`. Add a `restoreProjectArchiveOrphanings` helper that applies `undoOrphaning` and reports `keptVerdicts`/`keptOrphaned`. A relation with a non-`active` endpoint stays orphaned, as `restoreRetirementOrphanings` already does.
- [ ] 3.2 Run `unarchive` in one transaction with the restore. RED tests first: archive then unarchive restores `J1`/`J2` and marks the ops reverted; a verdict written while archived is kept; a retired endpoint keeps its judgment orphaned and the op non-reverted; a second archive cycle only orphans what is pending; unarchiving with no orphanings succeeds and restores nothing.

## 4. Undo guard (D5)

- [ ] 4.1 In `undoOp`/`undoRun`, refuse archive orphanings with `DomainError('conflict')` while the judgment's project is archived, naming unarchive in the message. RED tests: a single-op undo and a run undo are refused with every row unchanged (compare a hash of relations and ops before and after). After unarchive, an op left orphaned because an endpoint is not `active` is undoable.

## 5. Boot reconciliation (D4)

- [ ] 5.1 Add `reconcileArchivedProjectJudgments` in core. It runs one transaction per batch of `ARCHIVE_RECONCILE_BATCH` judgments, one `maintenance` run per project and batch with `origin: "reconcile"`, and yields with `setImmediate` between batches. RED tests:
  - a backlog in an archived project is fully orphaned and journaled;
  - a converged store writes no run and no op;
  - a backlog of more than one batch converges in one call, with one transaction per batch;
  - an active project's pendings are untouched;
  - unarchive restores the reconciled rows.
- [ ] 5.2 Call it from `startProcess()` in `apps/web/src/lib/process.ts`, after the data-loss guard. Wrap it in try/catch with `console.error('[process] …')`, and log the one summary line only when it did work. Add a test that a thrown reconciliation does not prevent the process from starting.

## 6. Deadline after restore (D6, owner decision)

- [ ] 6.1 Make the deadline step exclude judgments whose archive orphaning was reverted within `JUDGMENT_ORPHAN_DEADLINE_MS`. Read the excluded set once per sweep call. RED tests from the two `consolidation` spec scenarios: a 40-day-old judgment restored today stays pending; it is orphaned 15 days after its restore.

## 7. Measurements and mutation checks

- [ ] 7.1 On a synthetic 50 000-memory corpus, measure the wall clock of one `archive` transaction at 1 000 and 10 000 pending judgments. Record the results in `measurements/archive-cost.txt`.
- [ ] 7.2 Choose `ARCHIVE_RECONCILE_BATCH`: the largest batch whose transaction stays within 50 ms at 50 000 memories. Record the scan in `measurements/reconcile-batch.txt`.
- [ ] 7.3 Measure the per-sweep-call cost of the D6 excluded-set read at 1 000, 10 000 and 100 000 ops.
- [ ] 7.4 Run `node scripts/mutate.mjs` on each new condition separately and confirm that the tests naming it go red: the active-ids filter, the `sweepFor` guard, the run-kind/projectId match, the prefix match, the undo guard, the endpoint-active check and the D6 exclusion. Record the results in `measurements/mutation.txt`.

## 8. Docs and checks

- [ ] 8.1 Update `docs/relations.md` and the consolidation docs:
  - archived projects are not swept;
  - archiving closes pending judgments and unarchiving restores them;
  - the process-start reconciliation.
- [ ] 8.2 Run `pnpm run typecheck`, `pnpm run lint` and `pnpm test`, all green, plus `openspec validate freeze-archived-projects-in-consolidation --strict`.
