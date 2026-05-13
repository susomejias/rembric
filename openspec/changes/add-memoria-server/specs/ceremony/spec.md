## ADDED Requirements

### Requirement: The ceremony MUST run automatically on a schedule

The server SHALL run a background ceremony on the cron schedule defined by `CEREMONY_CRON` (default `0 3 * * *`) when `CEREMONY_ENABLED = true`. A manually triggered run via CLI or HTTP SHALL be possible at any time.

#### Scenario: Scheduled ceremony fires at the configured time
- **WHEN** the configured cron expression matches the current time and `CEREMONY_ENABLED = true`
- **THEN** the ceremony runner SHALL be invoked and a new `ceremony_runs` row SHALL be created with `started_at` set

#### Scenario: Manual run via CLI
- **WHEN** an operator runs `memoria-server ceremony run-now`
- **THEN** the ceremony SHALL execute against a running server and SHALL produce a `ceremony_runs` row regardless of the cron schedule

#### Scenario: Disabled ceremony
- **WHEN** `CEREMONY_ENABLED = false`
- **THEN** the cron SHALL NOT fire and no `ceremony_runs` rows SHALL be created automatically

### Requirement: The ceremony MUST target redundancy, drift, contradiction, and decay

The ceremony SHALL detect and handle exactly four pollution categories in v0: redundancy (semantic duplicates → merge), drift (newer fact contradicts older → supersede), contradiction (mutually exclusive active facts → resolve), and decay (memories not seen for a configurable period with low confidence → archive).

#### Scenario: Two near-duplicate active memories
- **GIVEN** two `active` memories of the same scope and type whose vector similarity exceeds the redundancy threshold
- **WHEN** the ceremony runs
- **THEN** the LLM judge SHALL be invoked with the pair as candidates, and on `merge` the runner SHALL insert a merged memory and transition both predecessors to `superseded`

#### Scenario: A memory has not been seen for a long time
- **GIVEN** a memory whose `last_seen_at` is older than the decay threshold and whose `confidence` count is below the floor
- **WHEN** the ceremony runs
- **THEN** the memory SHALL transition from `active` to `archived` without an LLM call

### Requirement: Ceremony operations MUST be atomic per operation

Each operation in a ceremony run SHALL be applied within a single SQLite transaction. If any part of the operation fails, the transaction SHALL be rolled back and the operation SHALL be recorded as failed in `ceremony_ops` with the error reason.

#### Scenario: Failure mid-merge
- **GIVEN** a merge operation has inserted a new merged memory but the predecessor status update fails
- **WHEN** the transaction commit is attempted
- **THEN** the transaction SHALL roll back, the merged memory SHALL NOT exist after rollback, the predecessors SHALL remain `active`, and a failed op SHALL be logged

### Requirement: Ceremony MUST NEVER cross scope boundaries

The ceremony SHALL operate one (scope, project_id) tuple at a time. A single ceremony op SHALL NOT touch memories that span more than one scope or more than one project.

#### Scenario: Two memories of different projects look similar
- **GIVEN** memory X has `scope = 'project'`, `project_id = 'A'` and memory Y has `scope = 'project'`, `project_id = 'B'`, and their content is near-duplicate
- **WHEN** the ceremony runs
- **THEN** they SHALL NOT be considered candidates for the same merge, regardless of similarity

### Requirement: Every ceremony decision MUST be journaled

Every operation produced by the ceremony — merge, supersede, archive, or no-op — SHALL be recorded in `ceremony_ops` with the operation type, affected memory ids, the LLM reasoning (when applicable), the resulting created memory id (when applicable), and the application status.

#### Scenario: A merge is performed
- **WHEN** the ceremony merges A and B into M
- **THEN** a `ceremony_ops` row SHALL exist with `op_type = 'merge'`, `affected_ids = ['A','B']`, `created_id = 'M'`, and the LLM's textual reasoning preserved

### Requirement: Every ceremony operation MUST be reversible

The dashboard and CLI SHALL provide an undo for any individual ceremony op and for an entire ceremony run. Undoing an op SHALL restore the affected memories to `active` and SHALL transition any merged-into memory to `archived` so it is removed from active retrieval.

#### Scenario: Undoing a merge op
- **GIVEN** a merge op resulted in memories A and B transitioning to `superseded` and a new memory M created with `status = 'active'`
- **WHEN** the operator triggers undo for that op
- **THEN** A and B SHALL transition back to `active`, M SHALL transition to `archived`, and the op SHALL be marked as reverted in `ceremony_ops`

#### Scenario: Undoing a run
- **WHEN** the operator triggers undo for an entire ceremony run
- **THEN** every op in the run SHALL be reversed in reverse order, leaving the DB equivalent to its pre-run state aside from the journal entries themselves

### Requirement: The ceremony MUST be idempotent on stable input

Running the ceremony twice with no intervening writes SHALL produce zero new operations on the second run.

#### Scenario: Back-to-back ceremony runs
- **GIVEN** a ceremony run has just completed
- **WHEN** the ceremony runs again immediately with no new memories saved
- **THEN** the new `ceremony_runs` row SHALL have an op count of zero

### Requirement: LLM judge output MUST be validated

Every response from the LLM judge SHALL be parsed and validated against a zod schema before any DB mutation is performed. Malformed responses SHALL be logged and the corresponding op SHALL be recorded as failed; the run SHALL continue with the next candidate.

#### Scenario: LLM returns malformed JSON
- **WHEN** the LLM judge returns text that does not parse as the expected schema
- **THEN** no DB mutation SHALL occur for that candidate, an error op SHALL be recorded, and the ceremony SHALL proceed to the next candidate
