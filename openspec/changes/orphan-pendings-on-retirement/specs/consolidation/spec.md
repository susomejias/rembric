## ADDED Requirements

### Requirement: Retiring a memory MUST orphan its pending judgments in the same transaction

Every write that moves a memory from `active` to `superseded` or `archived` SHALL, in the SAME transaction, transition every `memory_relations` row with `status = 'pending'` whose `source_id` or `target_id` is that memory to `status = 'orphaned'`, with `marked_by_kind = 'consolidator'`. The pair's other endpoint SHALL NOT matter: a pair whose other endpoint is already `superseded` or `archived` SHALL be orphaned too, because a pair is adjudicable only while both of its endpoints are `active` (see the `memory` capability, "A pending judgment MUST be withheld from the agent queue once either endpoint is retired").

This SHALL hold on every retirement path, which today are:

- a `topic_key` revision in `memory.save`, for the superseded row;
- a `supersedes` verdict through `memory.judge` or `memory.compare`, for the target;
- a `memory.merge` commit, for every original;
- `memory.archive` and the dashboard's archive actions;
- the sweep's decay pass, for every memory it archives;
- an undo of a `merge` op, for the successor it archives.

Every path SHALL go through ONE shared core helper. The helper SHALL reuse the existing per-relation orphaning and `orphan_promote` journaling primitives that the sweep uses, and SHALL NOT implement a second orphan-and-journal path. A static test SHALL enumerate every repository method that moves a memory to `superseded` or `archived`, and every call site of those methods outside the repositories. It SHALL fail when a call site's enclosing function does not call the helper after the flip, and SHALL include a control proving that it reports a real retirement path whose helper call was removed.

Each orphaning SHALL be journaled as an `orphan_promote` op with `affected_ids = [source_id, target_id]`, the judgment id as `created_id`, the relation recorded as null, and a deterministic reasoning string. Its prefix, `endpoint retired at retirement`, SHALL differ from the deadline step's, the rules drain's and the retired-endpoint drain's, so an operator can tell the four apart. The relation's `judged_at` and the op's `applied_at` SHALL both carry the retirement's own timestamp.

Where the retirement journals its own op, which is `merge`, `agent_memory_archive` or `decay`, its orphanings SHALL be journaled in that op's run. Where it journals none, which is a `topic_key` revision, a `supersedes` verdict or a merge undo, they SHALL be journaled in ONE new run with scope `maintenance` and the summary `{"kind":"retirement_orphan","orphaned":N}`. That run SHALL be opened only when the retirement has at least one pending relation to orphan.

The retirement, its orphanings and their journal ops SHALL commit or roll back together. A failure in any of them SHALL fail the retirement and persist none of them. The helper SHALL write no memory row and SHALL change no relation that is not `pending`.

#### Scenario: A topic_key revision orphans the superseded memory's pending judgments

- **GIVEN** an active memory A holding `topic_key = 't'`, with a pending relation A→X and a pending relation Y→A
- **WHEN** `memory.save` is called with `topic_key = 't'`, superseding A
- **THEN** both relations SHALL be `orphaned` with `marked_by_kind = 'consolidator'` when the save returns
- **AND** one `maintenance` run with the summary `{"kind":"retirement_orphan","orphaned":2}` SHALL hold one `orphan_promote` op per relation, whose reasoning starts with `orphaned: endpoint retired at retirement:` and whose `applied_at` equals the relation's `judged_at`

#### Scenario: A supersedes verdict orphans the target's other pending judgments

- **GIVEN** active memories S, T and U, a pending relation S→T and a pending relation T→U
- **WHEN** an agent judges S→T `supersedes` through `memory.judge`
- **THEN** S→T SHALL be `judged` with relation `supersedes`, T SHALL be `superseded`, and T→U SHALL be `orphaned`
- **AND** a pending relation whose endpoints are S and another active memory SHALL remain `pending`

#### Scenario: A compare supersedes orphans the target's pending judgments

- **GIVEN** active memories S, T and U, no relation between S and T, and a pending relation U→T
- **WHEN** an agent calls `memory.compare` with `{ sourceId: S, targetId: T, relation: 'supersedes' }`
- **THEN** T SHALL be `superseded` and U→T SHALL be `orphaned`

#### Scenario: A merge orphans every original's pending judgments in the merge's run

- **GIVEN** active memories A and B, a pending relation A→X and a pending relation Y→B
- **WHEN** `memory.merge` commits A and B
- **THEN** both relations SHALL be `orphaned`, and their two `orphan_promote` ops SHALL belong to the same run as the `merge` op

#### Scenario: An archive orphans the memory's pending judgments in the archive's run

- **GIVEN** an active memory M with a pending relation M→X
- **WHEN** `memory.archive` archives M, or an operator archives it from the dashboard
- **THEN** M→X SHALL be `orphaned`, and its `orphan_promote` op SHALL belong to the same run as the `agent_memory_archive` op

#### Scenario: The decay pass orphans an archived memory's pending judgments in the sweep's run

- **GIVEN** a memory M that crosses the decay threshold, with a pending relation X→M
- **WHEN** the sweep runs for its scope
- **THEN** M SHALL be `archived`, X→M SHALL be `orphaned`, and its `orphan_promote` op SHALL belong to the same run as the `decay` op

#### Scenario: A merge undo orphans the successor's pending judgments

- **GIVEN** a committed merge whose successor N has a pending relation N→X created by its save-time detection
- **WHEN** the operator undoes the `merge` op, which archives N
- **THEN** N→X SHALL be `orphaned`, journaled in a new `maintenance` run of kind `retirement_orphan`, and the `merge` op's run SHALL gain no op

#### Scenario: A pair whose other endpoint is already retired is orphaned too

- **GIVEN** a pending relation A→B where B is already `superseded`, a row that predates this requirement
- **WHEN** A is archived
- **THEN** A→B SHALL be `orphaned` in the same transaction

#### Scenario: A retirement with nothing pending opens no run

- **GIVEN** an active memory A holding `topic_key = 't'` with no pending relation
- **WHEN** `memory.save` supersedes A through `topic_key = 't'`
- **THEN** no `consolidation_runs` row and no `consolidation_ops` row SHALL be written

#### Scenario: A failed journal insert rolls back the retirement and the orphaning

- **GIVEN** an active memory M with a pending relation M→X, on any retirement path, and an `orphan_promote` journal insert forced to fail
- **WHEN** the retirement is attempted
- **THEN** the call SHALL fail, M SHALL keep its previous `status`, M→X SHALL remain `pending`, and no `orphan_promote` op SHALL reference it

#### Scenario: Retirement orphanings are distinguishable from sweep orphanings

- **GIVEN** relations orphaned by the deadline step, by the rules drain, by the retired-endpoint drain and by a retirement
- **WHEN** their `orphan_promote` ops are listed
- **THEN** each SHALL carry a different reasoning prefix, and the retirement's SHALL be `endpoint retired at retirement`

#### Scenario: A retirement path that skips the helper fails the invariant test

- **GIVEN** a function that calls a repository method moving a memory to `superseded` or `archived` and does not call the helper after it
- **WHEN** the invariant test scans the source roots
- **THEN** it SHALL fail and name that function's file and line

### Requirement: Undoing a retirement MUST restore the pending judgments it orphaned

Undoing a `decay`, `agent_memory_archive` or `merge` op SHALL, in the same undo transaction and after reactivating its memories, also undo the orphanings that retirement made: the active `orphan_promote` ops of the same run whose reasoning carries the prefix `endpoint retired at retirement` and whose pair touches one of the memories the op retired. For each:

- when the relation was written after the op, its later verdict SHALL be kept and reported, and the op SHALL be marked reverted, exactly as "Undoing an orphaning MUST NOT overwrite a verdict written after it" requires;
- otherwise, when either endpoint is not `active` after the reactivation, the relation SHALL stay `orphaned`, its op SHALL stay active, and the undo SHALL report it with its judgment id and the retired endpoint. That happens when the memory stayed retired because a newer memory holds its `topic_key` slot, or when the other endpoint was retired since. Restoring it would re-create a pending row no agent can judge;
- otherwise, the relation SHALL return to `status = 'pending'` with its verdict fields cleared, and the op SHALL be marked reverted.

Undoing a whole run SHALL leave those linked ops to the retirement op's own undo, so their endpoints are checked after the reactivation. Undoing one linked op on its own SHALL keep restoring it to `pending`, whatever its endpoints, as for any other orphaning.

A retirement that has no undo, which is a `topic_key` revision, a `supersedes` verdict or a merge undo, SHALL NOT gain one through this requirement. Its orphanings SHALL remain individually undoable.

The operator surface SHALL show which relations an undo left orphaned and why, beside the existing partial-undo notes.

#### Scenario: Undoing an archive restores its pending judgments

- **GIVEN** a memory M archived through `memory.archive`, which orphaned the pending relation M→X
- **WHEN** the operator undoes the `agent_memory_archive` op
- **THEN** M SHALL be `active`, M→X SHALL be `pending` with `relation`, `reason`, `judged_at`, `marked_by_kind` and `marked_by_actor` cleared, and both ops SHALL be marked reverted

#### Scenario: Undoing a decay restores its pending judgments

- **GIVEN** a memory M archived by the decay pass, which orphaned the pending relation X→M
- **WHEN** the operator undoes the `decay` op
- **THEN** M SHALL be `active` and X→M SHALL be `pending`

#### Scenario: Undoing a merge restores the originals' pending judgments

- **GIVEN** a committed merge of A and B, which orphaned the pending relations A→X and Y→B
- **WHEN** the operator undoes the `merge` op
- **THEN** A and B SHALL be `active`, the successor SHALL be `archived`, and A→X and Y→B SHALL be `pending`

#### Scenario: Undoing a run restores the linked judgments once

- **GIVEN** a sweep run whose `decay` op archived M and orphaned X→M, and whose deadline step orphaned another relation R
- **WHEN** the operator undoes the whole run
- **THEN** M SHALL be `active`, X→M and R SHALL be `pending`, and every op of the run SHALL be marked reverted exactly once

#### Scenario: Undoing one retirement of a shared run restores only its own judgments

- **GIVEN** one run holding two `decay` ops, the first archiving M1, which orphaned M1→X, and the second archiving M2, which orphaned X→M2
- **WHEN** the operator undoes the first `decay` op
- **THEN** M1 SHALL be `active` and M1→X `pending`, while M2 SHALL stay `archived`, X→M2 SHALL stay `orphaned`, its op SHALL stay active, and the undo SHALL report no kept-orphaned judgment

#### Scenario: An undo keeps a verdict written after the orphaning

- **GIVEN** a memory M archived through `memory.archive`, which orphaned the relation M→X, and a later `memory.compare` that judged M→X `conflicts_with` in place
- **WHEN** the operator undoes the `agent_memory_archive` op
- **THEN** M SHALL be `active`, M→X SHALL remain `judged` with relation `conflicts_with`, the undo SHALL report its judgment id as a kept verdict, and its op SHALL be marked reverted

#### Scenario: An undo leaves a judgment orphaned while its other endpoint is retired

- **GIVEN** a memory M archived through `memory.archive`, which orphaned the relation M→X, and X superseded afterwards
- **WHEN** the operator undoes the `agent_memory_archive` op
- **THEN** M SHALL be `active`, M→X SHALL remain `orphaned`, its op SHALL remain active, and the undo SHALL report the judgment id with X as the retired endpoint

#### Scenario: A run undo leaves a judgment orphaned when its memory keeps a taken topic slot

- **GIVEN** a memory R holding `topic_key = 'k'`, archived by the decay pass, which orphaned the relation R→X, and a later memory N saved with `topic_key = 'k'`
- **WHEN** the operator undoes the whole sweep run
- **THEN** R SHALL remain `archived` and be reported as skipped, R→X SHALL remain `orphaned` and be reported, and its op SHALL remain active

#### Scenario: A topic_key revision's orphanings are undone one by one

- **GIVEN** a `topic_key` revision that superseded A and orphaned A→X into a `retirement_orphan` run
- **WHEN** the operator undoes that `orphan_promote` op
- **THEN** A→X SHALL return to `pending`, A SHALL remain `superseded`, and no memory SHALL change status

### Requirement: A late verdict on a judgment orphaned by a retirement MUST be accepted

A verdict sent through `memory.judge` or `memory.judge_batch` for a relation whose `status` is `orphaned` SHALL be accepted when the relation was orphaned by a retirement, and SHALL then be applied exactly as for a `pending` row. A relation was orphaned by a retirement when a non-reverted `orphan_promote` op has the relation's `judgmentId` as `created_id` and a reasoning that starts with `orphaned: endpoint retired at retirement: `.

Accepting SHALL move the relation from `orphaned` to `judged` with the verdict's `relation`, `reason`, `evidence`, `confidence`, kind and actor, in one conditional update that requires `status = 'orphaned'`. The new `judged_at` SHALL be later than the orphaning op's `applied_at`, so that the undo of that op keeps the verdict and reports it in `keptVerdicts` (see "Undoing an orphaning MUST NOT overwrite a verdict written after it").

The following SHALL still be refused with `conflict`, as before:

- a relation orphaned by the deadline step or by a drain (rules or retired-endpoint), and a relation whose retirement orphaning was undone;
- a `supersedes` verdict while either endpoint is not `active`, which leaves the relation `orphaned`.

#### Scenario: A late verdict on a retirement-orphaned judgment is accepted

- **GIVEN** a judgment S→T and a judgment T→U, both pending, and one `memory.judge_batch` that judges S→T `supersedes` and then T→U `related`
- **WHEN** the batch runs
- **THEN** S→T SHALL supersede T, which orphans T→U at that retirement, and T→U SHALL then be `judged` with relation `related`, with both verdicts reported as successes

#### Scenario: A late `not_conflict` dismissal is honoured at the next revision

- **GIVEN** an active memory B holding `topic_key = 'k'` with a pending pair B→X, a later save with `topic_key = 'k'` that retired B and orphaned B→X, and a late `not_conflict` verdict on B→X
- **WHEN** the next save with `topic_key = 'k'` computes its candidates
- **THEN** X SHALL NOT be offered as a candidate, through the `replaces` ancestry

#### Scenario: A deadline-orphaned or drain-orphaned judgment is still refused

- **GIVEN** a judgment orphaned by the deadline step, and another orphaned by the stale-endpoint drain
- **WHEN** an agent sends a verdict for each
- **THEN** both SHALL fail with `conflict: already 'orphaned'` and stay `orphaned`

#### Scenario: A `supersedes` verdict on a retired endpoint is still refused

- **GIVEN** a retirement-orphaned judgment T→U where T is `superseded`
- **WHEN** an agent sends `supersedes` for it
- **THEN** it SHALL fail with `conflict`, T→U SHALL stay `orphaned` and U SHALL stay `active`

#### Scenario: Undoing the retirement keeps the late verdict

- **GIVEN** a retirement-orphaned judgment that later received a verdict
- **WHEN** the operator undoes its `orphan_promote` op
- **THEN** the verdict SHALL be kept, the op SHALL be marked reverted, and the result SHALL list it in `keptVerdicts`
