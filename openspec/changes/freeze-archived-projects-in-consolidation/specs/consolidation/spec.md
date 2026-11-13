## ADDED Requirements

### Requirement: The consolidation sweep MUST skip archived projects

A sweep, whether a session-start `sweepFor` or a forced `runAll`, SHALL run only for projects with `archived_at IS NULL`. For an archived project the sweep SHALL perform no decay, no deadline orphaning and no stale-pending drain, and SHALL write no `consolidation_runs` row. The default project cannot be archived, so it is always swept and the empty-session purge anchored on its run is unaffected. An archived project SHALL be swept again from the first sweep after it is unarchived.

#### Scenario: A forced sweep leaves an archived project untouched

- **GIVEN** an active project `A` and an archived project `Z`, each with a memory past its decay threshold and a pending judgment older than `JUDGMENT_ORPHAN_DEADLINE_MS`
- **WHEN** the operator triggers a forced sweep
- **THEN** `A`'s memory SHALL be archived and `A`'s judgment SHALL be orphaned
- **AND** `Z`'s memory and `Z`'s judgment SHALL be unchanged
- **AND** no `consolidation_runs` row SHALL be written with scope `project:<Z>`

#### Scenario: Unarchiving brings a project back into the sweep

- **GIVEN** project `Z` was archived and has since been unarchived
- **WHEN** the next forced sweep runs
- **THEN** a `consolidation_runs` row SHALL be written for `project:<Z>`

### Requirement: Archive orphanings MUST be journaled with their own reason

Every judgment orphaned because its project was archived, at archive time or by the boot reconciliation, SHALL be journaled as an `orphan_promote` op with `created_id` set to the judgment id, both endpoints in `affected_ids`, and reasoning starting with `orphaned: project archived`. That prefix SHALL differ from the deadline's, the drain's and the retirement's, and a test SHALL pin all of them. The ops SHALL belong to a `consolidation_runs` row with scope `maintenance` whose summary is a JSON object with `kind = "project_archive_orphan"`, the `projectId`, `origin` (`"archive"` or `"reconcile"`) and the `orphaned` count. No run SHALL be written when nothing was orphaned.

#### Scenario: Archiving journals each orphaning

- **GIVEN** project `P` with three pending judgments
- **WHEN** the operator archives `P`
- **THEN** one `maintenance` run SHALL exist with `kind = "project_archive_orphan"`, `projectId = P`, `origin = "archive"` and `orphaned = 3`
- **AND** it SHALL hold three `orphan_promote` ops whose reasoning starts with `orphaned: project archived`

#### Scenario: Archiving a project with no pending judgments journals nothing

- **WHEN** the operator archives a project with no pending judgments
- **THEN** no `maintenance` run SHALL be written

### Requirement: Pending judgments of already-archived projects MUST be closed at process start

On every process start, the server SHALL orphan every `pending` judgment whose endpoints belong to an archived project, journaled as an archive orphaning with `origin = "reconcile"`. The reconciliation SHALL need no operator action. It SHALL be idempotent: with no such judgment it SHALL write nothing. It SHALL process the backlog in bounded batches, one transaction per batch, and SHALL yield the event loop between batches, so that a single start converges without blocking request handling for more than one batch. A failure SHALL be logged and SHALL NOT prevent the process from serving; the next start SHALL retry. It SHALL write no memory row.

#### Scenario: An upgrade closes an archived project's backlog

- **GIVEN** an archived project `Z` with pending judgments, written before this requirement existed
- **WHEN** the server process starts
- **THEN** every pending judgment of `Z` SHALL be `orphaned`
- **AND** each SHALL be journaled in a `maintenance` run with `kind = "project_archive_orphan"`, `projectId = Z` and `origin = "reconcile"`

#### Scenario: A converged installation does nothing at start

- **GIVEN** no archived project has a pending judgment
- **WHEN** the server process starts
- **THEN** no `consolidation_runs` row and no `consolidation_ops` row SHALL be written

#### Scenario: A backlog larger than one batch converges in one start

- **GIVEN** an archived project with more pending judgments than one reconciliation batch
- **WHEN** the server process starts
- **THEN** after the reconciliation finishes, the project SHALL have no pending judgment
- **AND** each batch SHALL have been committed in its own transaction

### Requirement: An archive orphaning MUST NOT be undone while its project is archived

Undoing an `orphan_promote` op whose reasoning starts with `orphaned: project archived`, singly or as part of an "Undo entire run", SHALL be refused with a `conflict` error while the judgment's project is archived, and SHALL change no row. The refusal SHALL name unarchiving the project as the restore path. Once the project is active, the op SHALL be undoable like any other orphaning.

#### Scenario: Undo is refused while archived

- **GIVEN** project `P` is archived and its archive run holds orphan ops
- **WHEN** the operator undoes one of those ops, or the whole run
- **THEN** the undo SHALL be refused with `conflict`
- **AND** every relation and op SHALL be unchanged

#### Scenario: Undo works after unarchive for an op unarchive could not restore

- **GIVEN** project `P` was unarchived and one of its archive orphanings stayed orphaned because an endpoint was no longer `active`
- **WHEN** the operator undoes that op
- **THEN** the undo SHALL proceed under the existing `orphan_promote` undo rules

### Requirement: A restored judgment's deadline MUST count from its restore

The deadline orphaning step SHALL NOT select a `pending` judgment whose archive orphaning was reverted less than `JUDGMENT_ORPHAN_DEADLINE_MS` ago, even when its `created_at` is older than the deadline. Once that window has passed, the deadline step SHALL apply to it as to any pending judgment.

#### Scenario: A project archived for a month is unarchived

- **GIVEN** a judgment created 40 days ago, orphaned when its project was archived 30 days ago, and restored by unarchiving today
- **WHEN** a sweep of its project runs today
- **THEN** the judgment SHALL remain `pending`

#### Scenario: The restored window expires

- **GIVEN** the same judgment, still pending 15 days after its restore
- **WHEN** a sweep of its project runs
- **THEN** the judgment SHALL be orphaned by the deadline step
