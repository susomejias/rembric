## MODIFIED Requirements

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

## ADDED Requirements

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
