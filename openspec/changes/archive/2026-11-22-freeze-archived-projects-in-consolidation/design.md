## Context

`ProjectsService.archive` is one `UPDATE … SET archived_at` with no transaction and no other effect (`packages/core/src/services/projects.ts:74-88`, `packages/db/src/repositories/projects-repository.ts:74-84`). Authentication refuses every connection to an archived project, so from then on no agent can read, save or judge in it.

Two consequences follow, and they apply to every installation, not to one database.

1. **The sweep still runs on archived projects.**
   - `runAll` sweeps `projects.listAllIds()`, which has no `archived_at` filter (`runner.ts:114-120`).
   - Decay keys on `last_seen_at`, which an archived project can never advance, so every forced sweep moves its memories toward archival.
   - Each archived scope also spends part of the drain's shared 30 ms budget and writes a `consolidation_runs` row.
2. **Its pending judgments never leave the queue on their own.**
   - No agent can judge them.
   - The session-start sweep never reaches the project, because no session can start there.
   - Only a forced sweep's deadline step closes them, 50 per run, after 14 days.
   - Until then they count in the operator's pending total.

The retirement change (`openspec/changes/orphan-pendings-on-retirement/`) already orphans the pending judgments of a retired memory in the same transaction, journals them in a `maintenance` run and restores them on undo. This change applies the same shape at project granularity.

A relation never spans projects: `assertSameScope` refuses a cross-scope verdict (`relations.ts:401-416`), and `endpointsInScope` requires both endpoints in one project (`relations-repository.ts:89-97`). So "the project of a judgment" is its endpoints' `project_id`.

## Goals / Non-Goals

**Goals:**

- Archiving freezes a project:
  - no sweep step ever touches it;
  - its open judgments are closed at archive time, atomically and reversibly.
- Unarchiving gives the open judgments back.
- Installations that already have archived projects converge to the same state on their next process start, with no operator action.
- All evidence comes from tests and synthetic-corpus measurements, never from a particular installation's database.

**Non-Goals:**

- Hiding no-op or `maintenance` runs from the consolidation list (issue #474). That is a separate change.
- Changing the drain's `DRAIN_BUDGET_MS`/`DRAIN_ROW_CAP`.
- Resolving the recorded divergence in the `projects` spec about whether an archived project stays readable.
- Archiving or deleting memories of an archived project. Its memory rows are untouched.

## Decisions

### D1 — The sweep selects only active projects

`runAll` sweeps `projects.listActiveIds()` (`archived_at IS NULL`) instead of `listAllIds()`. `sweepFor` drops the session's project when it is archived. The guard is defensive, because authentication already refuses such a session. The default project cannot be archived (`projects.ts:75-80`), so it is always swept and the empty-session purge, anchored on the default project's run, is unaffected.

Alternatives:

- **Keep sweeping archived projects, but skip decay.** Rejected. Deadline and drain would still run against judgments that D2 has already closed, the run rows would still be written, and a partial sweep is a second definition of "archived" that has to be specified step by step.
- **Skip only after the project has been archived for some time.** Rejected. Once D2 holds, nothing in an archived project can produce sweep work: no saves, no new candidates and no open judgments. A grace period would only leave room for decay damage.

### D2 — Archive orphans the project's pending judgments in the same transaction

`archive(id)` runs in one `tx.transaction`:

1. Set `archived_at`, with the existing refusal for the default project and for an already-archived project.
2. Select the project's pending judgments: `status = 'pending'` joined on the source memory's `project_id`. This rides `memory_scope_project_*` and `memory_relations_source_status_idx`.
3. Open one `maintenance` run with the summary `{"kind":"project_archive_orphan","projectId":"<id>","origin":"archive","orphaned":N}`.
4. For each judgment, call `relations.orphan(judgmentId, reasoning)` with `marked_by_kind = 'consolidator'`, then `recordOrphanPromote`.

The reasoning is `project archived`, so the op stores `orphaned: project archived` under `PROJECT_ARCHIVE_ORPHANING_PREFIX = 'orphaned: project archived'`. That prefix is distinct from the deadline's `unjudged after …`, from the drain's `stale under current rules` and `endpoint retired: `, and from the retirement's `endpoint retired at retirement: `. A test pins all five.

When the project has no pending judgments, no run is written.

`ProjectsService` gains `Pick<Repositories, 'projects' | 'relations' | 'memory' | 'consolidation'>`, the `RelationsService` it needs for `orphan`, and a `TransactionRunner` (`apps/web/src/lib/services.ts:72`). Bulk archive keeps looping `archive(id)`, one transaction per project.

Alternatives:

- **Reuse `RETIREMENT_ORPHANING_PREFIX` to inherit late-verdict acceptance.** Rejected. Its text says an endpoint was retired, which is false here. Late-verdict acceptance is also not needed: no agent can reach the project while it is archived, and D3 returns every still-orphaned row to `pending` at unarchive, where a normal verdict applies.
- **Leave the judgments pending and only filter archived projects out of the operator counts.** Rejected. The rows would stay `pending` forever with no step able to close them, so the store would carry permanently unresolvable state, and every read of the queue would need the filter.
- **Delete the pending rows.** Rejected. It violates the append-only invariant.

### D3 — Unarchive restores the archive orphanings that are still orphaned

`unarchive(id)` runs in one transaction:

1. Clear `archived_at`.
2. Find the live (non-reverted) archive orphanings of the project:
   - read the `maintenance` runs whose summary is `kind = project_archive_orphan` for this `projectId` (the runs table is small, and this is a rare operator action);
   - then read their ops through the `run_id` index;
   - keep only `orphan_promote` ops with `PROJECT_ARCHIVE_ORPHANING_PREFIX` and `reverted_at IS NULL`.
3. Pass each op through the existing `undoOrphaning` path (`operations.ts:302-331`):
   - a relation with a verdict written after the op (`writtenSinceOp`) keeps its verdict and is reported in `keptVerdicts`;
   - a relation with an endpoint that is no longer `active` stays orphaned and is reported in `keptOrphaned`, the same rule `restoreRetirementOrphanings` applies (`operations.ts:334-358`);
   - every other relation goes back to `pending` and its op is marked reverted.

Runs written by D4's boot reconciliation carry the same `kind`, so they are restored by the same read.

`unarchive` keeps its current success on an already-active project. With no live archive orphanings, it restores nothing.

Alternatives:

- **Leave the rows orphaned on unarchive.** Rejected by the owner: archive followed by unarchive should leave the project's open questions as they were.
- **Find the ops by scanning `consolidation_ops` for the prefix and joining on `created_id`.** Rejected. `consolidation_ops` has no `created_id` index (`packages/db/src/schema/consolidation.ts:53`), and a run-anchored read rides `run_id`.

### D4 — Boot reconciliation for projects archived before this change

`startProcess()` (`apps/web/src/lib/process.ts:32-73`) runs once per process. After the data-loss guard, it calls `reconcileArchivedProjectJudgments()`:

- For each archived project that still has pending judgments, it orphans them in batches of `ARCHIVE_RECONCILE_BATCH` judgments, one transaction per batch.
- Each batch is journaled exactly as in D2: one `maintenance` run per project and batch, with `origin: "reconcile"`.
- It yields with `setImmediate` between batches, so the event loop serves requests during a large backlog, and it converges in a single boot.
- It is idempotent: a converged installation finds no pending judgment in an archived project and writes nothing.
- It logs one line only when it did work: `[process] archived-project judgments: closed N in P projects (M ms)`.
- A failure is logged and does not stop the process. The next boot retries.

`ARCHIVE_RECONCILE_BATCH = 400` is a named constant chosen from a measurement (`measurements/archive-cost.txt`). At a 50 000-memory synthetic corpus, one batch transaction took:

| Batch | p50     | p95     |
| ----- | ------- | ------- |
| 200   | 13.9 ms | 14.5 ms |
| 400   | 25.7 ms | 31.5 ms |
| 800   | 54.5 ms | 60.1 ms |

400 is the largest measured batch within the 50 ms blocking target the drain was measured against.

Alternatives:

- **A SQL migration.** Rejected. A migration does not journal into `consolidation_ops`, so the orphanings could neither be inspected nor restored on unarchive, which breaks "every consolidation op reversible".
- **Reconcile inside the sweep.** Rejected. D1 removes archived projects from the sweep, and the session-start sweep never reached them anyway.
- **Ask operators to bulk-orphan by hand.** Rejected. It does not work for installations whose operators never look, which is the point of the change.

### D5 — Undoing an orphaning is refused while its project is archived

`undoOp` and `undoRun` refuse with `DomainError('conflict', …)` when the op is any `orphan_promote` and the judgment's project is archived, whatever wrote it (archive, deadline, drain or retirement). The message names unarchive as the restore path.

Without this guard, a dashboard undo would put a judgment back to `pending` in a project that no agent and no sweep can reach. D4 would then close it again at the next boot, so the operator's undo and the reconciliation would fight. Once the project is active again, the single-op and run undo work as for any other orphaning.

Alternative:

- **Allow it and let D4 re-close it.** Rejected. The result depends on when the process restarts, which is not observable from the dashboard.

### D6 — The deadline clock restarts when a judgment is restored (owner decision)

The deadline step selects `pending` rows with `created_at` older than 14 days (`relations-repository.ts:286-307`). A judgment restored after a long archive is older than that, so the next sweep of the project, at its first session start, would orphan it again before any agent saw it.

Decision (owner): the deadline step does not select a judgment whose archive orphaning was reverted less than `JUDGMENT_ORPHAN_DEADLINE_MS` ago. In effect, its deadline counts from the restore. The excluded set is read once per sweep call from the reverted archive-orphaning ops with `reverted_at` inside the window. The drain already makes the same kind of read (`listRevertedOrphanPromoteCreatedIds`), and its cost is measured in the same task.

Alternative:

- **Keep the creation-time deadline.** Restore then only lasts until the next sweep for any project archived longer than 14 days.

## Risks / Trade-offs

- **[Risk] Archiving a project with a large backlog blocks the event loop for one transaction.** → Measured at a 50 000-memory synthetic corpus (`measurements/archive-cost.txt`):
  - 64–69 ms at 1 000 pending judgments;
  - 644–762 ms at 10 000, about 0.07 ms per judgment.

  The transaction must be atomic with the `archived_at` write, so it is not batched. Archive is a rare operator action, and a single project holding 10 000 pending judgments is far beyond any measured backlog. Accepted.

- **[Risk] The deadline step reads the recently restored judgments once per sweep call.** → Measured at 0.2 ms with 1 000 journal ops, 0.7 ms with 10 000 and 7.7 ms with 100 000. It runs once per call, not once per scope.
- **[Risk] The boot reconciliation runs on installations whose operators never asked for it.** → It only changes `pending` judgments in projects the operator archived. Every change is journaled in a `maintenance` run labelled `origin: reconcile`, and unarchive restores it. No memory row changes.
- **[Risk] The operator's pending count drops at upgrade without an action of theirs.** → Accepted. Those judgments could never be closed by an agent, and the runs explain where they went.
- **[Trade-off] A restored judgment is excluded from the stale drain forever.** → Accepted, because it follows from the drain's existing "undo is final" rule, the same trade-off the retirement change accepted. The deadline step and a new archive still close it.
- **[Trade-off] Undo of archive orphanings is refused while archived (BREAKING for the operator surface).** → Accepted. Unarchive is the single, symmetric restore path.
- **[Risk] A test that only asserts a count could pass without exercising the guard.** → Every new condition (active-ids filter, archive-kind run match, undo guard, deadline exclusion, endpoint-active check) gets a mutation run with `scripts/mutate.mjs`, recorded in `measurements/mutation.txt`.

## Migration Plan

- There is no schema migration. Deploying the server is the migration: the first process start runs D4.
- **Rollback:** an older server ignores the new run `kind`, and the orphaned rows stay valid `orphaned` rows. Before downgrading, an operator can unarchive the affected projects to restore their judgments.

## Open Questions

_None._ The one open question, D6 (the deadline after restore), was decided by the owner: a restored judgment gets a fresh window.
