## MODIFIED Requirements

### Requirement: Every consolidation operation MUST be reversible

The dashboard and CLI SHALL provide an undo for any individual consolidation op and for an entire consolidation run, EXCEPT when one or more rows referenced by the op's `affected_ids` or `created_id` have been physically removed by `MemoryService.purgeDisconnectedArchived` or `AgentSessionsService.purgeEmpty`. In that case, undo SHALL fail with a structured error so the operator understands why.

Undoing an op SHALL restore the affected memories to `active` and SHALL transition any merged-into memory to `archived` so it is removed from active retrieval, when all referenced rows still exist.

Undo SHALL NOT create a second `active` memory in a `(scope, project_id, topic_key)` slot. Before reactivating an affected row (or, for an `orphan_promote` undo, the relation's target row) that carries a non-null `topic_key`, the undo SHALL check whether that slot already holds a *different* active row (a newer memory saved with the same `topic_key` after the op was applied). When the slot is occupied, that row SHALL NOT be reactivated — it SHALL remain in its current `superseded`/`archived` state — while the remaining rows of the op are reactivated normally. Rows with a null `topic_key` are always reactivatable. The undo SHALL report which rows it skipped (id, `topic_key`, and the occupying active id), and the operator surface SHALL show that the undo was partial and why. The op SHALL still be marked reverted (it was undone to the extent convergence permits). This guarantee is additionally enforced at the storage layer by a UNIQUE partial index on the active-topic slot (see the `persistence` capability).

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

#### Scenario: Undo does not resurrect a row into an occupied topic_key slot

- **GIVEN** memory R with `topic_key = K` was archived by a decay op
- **AND** a later `memory.save({topic_key: K})` in the same `(scope, project_id)` inserted a new active memory N in that slot (R was not active when N was saved, so no supersede linked them)
- **AND** neither R nor N has been purged
- **WHEN** the operator triggers undo for the decay op
- **THEN** N SHALL remain the sole `active` row in the `(scope, project_id, K)` slot
- **AND** R SHALL remain `archived` (NOT reactivated)
- **AND** the undo result SHALL name R among its skipped rows, identifying K and the occupying id N
- **AND** the op SHALL be marked reverted

#### Scenario: orphan_promote undo respects an occupied topic_key slot

- **GIVEN** an `orphan_promote` op recorded a `supersedes` verdict whose target T carries `topic_key = K`
- **AND** after that op, a `memory.save({topic_key: K})` inserted a new active memory N in T's slot
- **WHEN** the operator undoes the `orphan_promote` op
- **THEN** T SHALL NOT be reactivated (N remains the sole active row for K)
- **AND** the relation SHALL still be reset to `pending` and the source's `replaces[]` adjustment SHALL still be applied
- **AND** T SHALL be named among the undo's skipped rows
