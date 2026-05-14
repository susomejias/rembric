# consolidation Specification

## Purpose

Defines the background consolidation pipeline that detects and resolves memory pollution (redundancy, drift, contradiction, and decay) while preserving append-only semantics, scope isolation, journaling, and reversibility.

## Requirements

### Requirement: The consolidation MUST run automatically on a schedule

The server SHALL run a background consolidation on the cron schedule defined by `CONSOLIDATION_CRON` (default `0 3 * * *`) when `CONSOLIDATION_ENABLED = true`. A manually triggered run via CLI or HTTP SHALL be possible at any time.

#### Scenario: Scheduled consolidation fires at the configured time

- **WHEN** the configured cron expression matches the current time and `CONSOLIDATION_ENABLED = true`
- **THEN** the consolidation runner SHALL be invoked and a new `consolidation_runs` row SHALL be created with `started_at` set

#### Scenario: Manual run via CLI

- **WHEN** an operator runs `rembric consolidation run-now`
- **THEN** the consolidation SHALL execute against a running server and SHALL produce a `consolidation_runs` row regardless of the cron schedule

#### Scenario: Disabled consolidation

- **WHEN** `CONSOLIDATION_ENABLED = false`
- **THEN** the cron SHALL NOT fire and no `consolidation_runs` rows SHALL be created automatically

### Requirement: The consolidation MUST target redundancy, drift, contradiction, and decay

The consolidation SHALL detect and handle exactly four pollution categories in v0: redundancy (semantic duplicates → merge), drift (newer fact contradicts older → supersede), contradiction (mutually exclusive active facts → resolve), and decay (memories not seen for a configurable period with low confidence → archive).

#### Scenario: Two near-duplicate active memories

- **GIVEN** two `active` memories of the same scope and type whose vector similarity exceeds the redundancy threshold
- **WHEN** the consolidation runs
- **THEN** the LLM judge SHALL be invoked with the pair as candidates, and on `merge` the runner SHALL insert a merged memory and transition both predecessors to `superseded`

#### Scenario: A memory has not been seen for a long time

- **GIVEN** a memory whose `last_seen_at` is older than the decay threshold and whose `confidence` count is below the floor
- **WHEN** the consolidation runs
- **THEN** the memory SHALL transition from `active` to `archived` without an LLM call

### Requirement: Consolidation operations MUST be atomic per operation

Each operation in a consolidation run SHALL be applied within a single SQLite transaction. If any part of the operation fails, the transaction SHALL be rolled back and the operation SHALL be recorded as failed in `consolidation_ops` with the error reason.

#### Scenario: Failure mid-merge

- **GIVEN** a merge operation has inserted a new merged memory but the predecessor status update fails
- **WHEN** the transaction commit is attempted
- **THEN** the transaction SHALL roll back, the merged memory SHALL NOT exist after rollback, the predecessors SHALL remain `active`, and a failed op SHALL be logged

### Requirement: Consolidation MUST NEVER cross scope boundaries

The consolidation SHALL operate one (scope, project_id) tuple at a time. A single consolidation op SHALL NOT touch memories that span more than one scope or more than one project.

#### Scenario: Two memories of different projects look similar

- **GIVEN** memory X has `scope = 'project'`, `project_id = 'A'` and memory Y has `scope = 'project'`, `project_id = 'B'`, and their content is near-duplicate
- **WHEN** the consolidation runs
- **THEN** they SHALL NOT be considered candidates for the same merge, regardless of similarity

### Requirement: Every consolidation decision MUST be journaled

Every operation produced by the consolidation — merge, supersede, archive, or no-op — SHALL be recorded in `consolidation_ops` with the operation type, affected memory ids, the LLM reasoning (when applicable), the resulting created memory id (when applicable), and the application status.

#### Scenario: A merge is performed

- **WHEN** the consolidation merges A and B into M
- **THEN** a `consolidation_ops` row SHALL exist with `op_type = 'merge'`, `affected_ids = ['A','B']`, `created_id = 'M'`, and the LLM's textual reasoning preserved

### Requirement: Every consolidation operation MUST be reversible

The dashboard and CLI SHALL provide an undo for any individual consolidation op and for an entire consolidation run. Undoing an op SHALL restore the affected memories to `active` and SHALL transition any merged-into memory to `archived` so it is removed from active retrieval.

#### Scenario: Undoing a merge op

- **GIVEN** a merge op resulted in memories A and B transitioning to `superseded` and a new memory M created with `status = 'active'`
- **WHEN** the operator triggers undo for that op
- **THEN** A and B SHALL transition back to `active`, M SHALL transition to `archived`, and the op SHALL be marked as reverted in `consolidation_ops`

#### Scenario: Undoing a run

- **WHEN** the operator triggers undo for an entire consolidation run
- **THEN** every op in the run SHALL be reversed in reverse order, leaving the DB equivalent to its pre-run state aside from the journal entries themselves

### Requirement: The consolidation MUST be idempotent on stable input

Running the consolidation twice with no intervening writes SHALL produce zero new operations on the second run.

#### Scenario: Back-to-back consolidation runs

- **GIVEN** a consolidation run has just completed
- **WHEN** the consolidation runs again immediately with no new memories saved
- **THEN** the new `consolidation_runs` row SHALL have an op count of zero

### Requirement: LLM judge output MUST be validated

Every response from the LLM judge SHALL be parsed and validated against a zod schema before any DB mutation is performed. Malformed responses SHALL be logged and the corresponding op SHALL be recorded as failed; the run SHALL continue with the next candidate.

#### Scenario: LLM returns malformed JSON

- **WHEN** the LLM judge returns text that does not parse as the expected schema
- **THEN** no DB mutation SHALL occur for that candidate, an error op SHALL be recorded, and the consolidation SHALL proceed to the next candidate
