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

The consolidation SHALL perform exactly two passes per run in v0.5: (1) decay (deterministic, no LLM), and (2) orphan promotion of pending relations older than `JUDGMENT_ORPHAN_AFTER_MS`. The LLM-driven detection of redundancy / drift / contradiction over the full corpus is REMOVED — that work moves to save-time as `memory.save` candidate detection.

#### Scenario: A memory has not been seen for a long time

- **GIVEN** a memory whose `last_seen_at` is older than the decay threshold and whose `confidence` count is below the floor
- **WHEN** the consolidation runs
- **THEN** the memory SHALL transition from `active` to `archived` without an LLM call (decay path is unchanged)

#### Scenario: A pending relation is older than the orphan threshold

- **GIVEN** a `memory_relations` row with `status = 'pending'` and `created_at < (now - JUDGMENT_ORPHAN_AFTER_MS)` (default 24h)
- **WHEN** the consolidation runs
- **THEN** the existing LLM judge SHALL be invoked on the (source, target) pair; the verdict SHALL translate to a relation value and the row SHALL transition to `status = 'judged'` with `marked_by_kind = 'consolidator'`

#### Scenario: The LLM judge cannot decide an orphan

- **WHEN** the LLM judge errors, returns malformed output, or returns a verdict with confidence below the configured floor
- **THEN** the relation row SHALL transition to `status = 'orphaned'`; the orphaned status is final unless a future `memory.judge` or `memory.compare` call writes a fresh row

#### Scenario: Two near-duplicate memories save apart from each other

- **GIVEN** EMBEDDING_ENABLED is true and the second save's candidate detection found the first as a candidate
- **WHEN** that save returned `candidates: [{...}]` and the agent never called `memory.judge`
- **THEN** after `JUDGMENT_ORPHAN_AFTER_MS` the consolidator's orphan-promotion pass SHALL invoke the LLM judge on the pair (this is the only path that runs LLM detection in the new pipeline)

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

The dashboard and CLI SHALL provide an undo for any individual consolidation op and for an entire consolidation run, EXCEPT when one or more rows referenced by the op's `affected_ids` or `created_id` have been physically removed by `MemoryService.purgeDisconnectedArchived` or `AgentSessionsService.purgeEmpty`. In that case, undo SHALL fail with a structured error so the operator understands why.

Undoing an op SHALL restore the affected memories to `active` and SHALL transition any merged-into memory to `archived` so it is removed from active retrieval, when all referenced rows still exist.

#### Scenario: Undoing a merge op when all rows still exist

- **GIVEN** a merge op resulted in memories A and B transitioning to `superseded` and a new memory M created with `status = 'active'`
- **AND** none of A, B, M have been purged
- **WHEN** the operator triggers undo for that op
- **THEN** A and B SHALL transition back to `active`, M SHALL transition to `archived`, and the op SHALL be marked as reverted in `consolidation_ops`

#### Scenario: Undoing a run when all rows still exist

- **WHEN** the operator triggers undo for an entire consolidation run and every affected_id of every op is still present in `memory` and `sessions`
- **THEN** every op in the run SHALL be reversed in reverse order, leaving the DB equivalent to its pre-run state aside from the journal entries themselves

#### Scenario: Undo is blocked when a referenced row has been purged

- **GIVEN** a merge op references memory ids `[A, B]` via `affected_ids` and `M` via `created_id`
- **AND** `M` has since been removed by `MemoryService.purgeDisconnectedArchived`
- **WHEN** the operator triggers undo for that op
- **THEN** the undo handler SHALL return `{ ok: false, code: 'purged_row_missing', missing: ['M'] }`
- **AND** the dashboard SHALL render that error inline on the consolidation runs view, naming the missing ids
- **AND** the op SHALL remain in its current state (NOT marked reverted, NOT mutated)
- **AND** rows A and B SHALL remain in their current state (NOT transitioned back to `active`)

#### Scenario: Undo is blocked when a purged session is referenced

- **GIVEN** a journal op references a session id that has since been removed by `AgentSessionsService.purgeEmpty`
- **WHEN** the operator triggers undo for that op
- **THEN** the undo handler SHALL return `{ ok: false, code: 'purged_row_missing', missing: [...sessionIds] }`
- **AND** the op SHALL NOT be reverted

### Requirement: The consolidation MUST be idempotent on stable input

Running the consolidation twice with no intervening writes SHALL produce zero new operations beyond noops. Specifically: the decay pass SHALL be a no-op if no row crossed the threshold since the previous run; the orphan-promotion pass SHALL be a no-op if no pending relation crossed `JUDGMENT_ORPHAN_AFTER_MS` since the previous run.

#### Scenario: Back-to-back consolidation runs with no intervening saves

- **WHEN** the consolidation runs twice in immediate succession
- **THEN** the second run's `consolidation_runs.summary` SHALL show zero new decay archives and zero new orphan promotions

### Requirement: LLM judge output MUST be validated

Every response from the LLM judge SHALL be parsed and validated against a zod schema before any DB mutation is performed. Malformed responses SHALL be logged and the corresponding op SHALL be recorded as failed; the run SHALL continue with the next candidate.

#### Scenario: LLM returns malformed JSON

- **WHEN** the LLM judge returns text that does not parse as the expected schema
- **THEN** no DB mutation SHALL occur for that candidate, an error op SHALL be recorded, and the consolidation SHALL proceed to the next candidate

### Requirement: Purge ops are journaled but not themselves undoable

The consolidation journal SHALL include two new `op_type` values: `session_purge` (written by `AgentSessionsService.purgeEmpty`) and `archived_memory_purge` (written by `MemoryService.purgeDisconnectedArchived`). These ops record `affected_ids` (the deleted row ids) and `reasoning` (a static operator-purge string). The `created_id` column SHALL be NULL for both new op types.

Undo SHALL NOT be available for `session_purge` or `archived_memory_purge` ops. The rows they record are gone and cannot be reconstructed. Attempts to undo SHALL return `{ ok: false, code: 'not_undoable', reason: 'purge ops are terminal' }`.

#### Scenario: A purge op is journaled with the deleted ids

- **WHEN** `AgentSessionsService.purgeEmpty` deletes session ids `[s1, s2, s3]`
- **THEN** exactly one row SHALL be inserted into `consolidation_ops` with `op_type = 'session_purge'`, `affected_ids = ['s1','s2','s3']`, `created_id = NULL`, and `reasoning` matching the operator-purge static string

#### Scenario: An archived-memory purge op is journaled with the deleted ids

- **WHEN** `MemoryService.purgeDisconnectedArchived` deletes memory ids `[m1, m2]`
- **THEN** exactly one row SHALL be inserted into `consolidation_ops` with `op_type = 'archived_memory_purge'`, `affected_ids = ['m1','m2']`, `created_id = NULL`, and `reasoning` matching the operator-purge static string

#### Scenario: Undo on a purge op is rejected

- **GIVEN** a `consolidation_ops` row with `op_type IN ('session_purge', 'archived_memory_purge')`
- **WHEN** the operator triggers undo for that op
- **THEN** the undo handler SHALL return `{ ok: false, code: 'not_undoable', reason: 'purge ops are terminal' }`
- **AND** the dashboard SHALL render that response as a non-error informational message (purges are intentionally one-way)
