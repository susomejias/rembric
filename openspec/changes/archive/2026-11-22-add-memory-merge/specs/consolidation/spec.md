## MODIFIED Requirements

### Requirement: Every consolidation decision MUST be journaled

Every operation produced by the sweep — decay archive or deadline orphaning — SHALL be recorded in `consolidation_ops` with the operation type, affected ids, a deterministic reasoning string, the resulting created id (when applicable), and the application status. Historical op types (`merge`, `supersede`, `orphan_promote`) remain valid journal rows: they SHALL keep rendering in the dashboard and SHALL keep their undo semantics, but the sweep SHALL NOT produce new rows of those types.

An agent-driven merge confirmed through `memory.merge` (see the `mcp-api` capability, "The MCP server MUST expose `memory.merge` with a preview-then-confirm contract") SHALL be journaled as exactly one `merge` op, in its own `consolidation_runs` row with `scope = 'maintenance'` (the same journal path `memory.archive` uses; a `project:<projectId>` run would satisfy the sweep's per-scope throttle and silently skip that project's next sweep), with `affected_ids` = the merged originals in the caller's order, `created_id` = the successor, and a reasoning string naming the acting token. The op SHALL be written in the same transaction as the successor insert and the originals' status flip, so a merge that rolls back leaves no journal row. The sweep itself still SHALL NOT produce `merge` ops.

#### Scenario: A decay archive is journaled

- **WHEN** the sweep archives memories A and B via decay
- **THEN** a `consolidation_ops` row SHALL exist with `op_type = 'decay'`, `affected_ids = ['A','B']`, and a deterministic reasoning string

#### Scenario: An agent merge is journaled as one merge op

- **WHEN** an agent confirms `memory.merge` over active memories A, B and C, creating successor M
- **THEN** exactly one new `consolidation_ops` row SHALL exist with `op_type = 'merge'`, `affected_ids = ['A','B','C']` and `created_id = 'M'`, in a new `consolidation_runs` row with `scope = 'maintenance'`
- **AND** the next session-start sweep for that project SHALL NOT be throttled by that run

#### Scenario: A historical LLM-era op is still visible and undoable

- **GIVEN** a pre-upgrade `consolidation_ops` row with `op_type = 'merge'` whose referenced rows all exist
- **WHEN** the operator views the run and triggers undo for that op
- **THEN** the op SHALL render normally and the undo SHALL succeed exactly as before the upgrade

### Requirement: Every consolidation operation MUST be reversible

The dashboard and CLI SHALL provide an undo for any individual consolidation op and for an entire consolidation run, EXCEPT when one or more rows referenced by the op's `affected_ids` or `created_id` have been physically removed by `MemoryService.purgeDisconnectedArchived` or `AgentSessionsService.purgeEmpty`. In that case, undo SHALL fail with a structured error so the operator understands why.

Undoing an op SHALL restore the affected memories to `active` and SHALL transition any merged-into memory to `archived` so it is removed from active retrieval, when all referenced rows still exist. For a `merge` op the merged-into memory SHALL be archived BEFORE the originals are reactivated: the successor commonly holds the `topic_key` slot it inherited from one of its originals, and reactivating first would find that slot occupied by the successor itself and skip the original.

Undo SHALL NOT create a second `active` memory in a `(scope, project_id, topic_key)` slot. Before reactivating an affected row (or, for an `orphan_promote` undo, the relation's target row) that carries a non-null `topic_key`, the undo SHALL check whether that slot already holds a _different_ active row (a newer memory saved with the same `topic_key` after the op was applied). When the slot is occupied, that row SHALL NOT be reactivated — it SHALL remain in its current `superseded`/`archived` state — while the remaining rows of the op are reactivated normally. Rows with a null `topic_key` are always reactivatable. The undo SHALL report which rows it skipped (id, `topic_key`, and the occupying active id), and the operator surface SHALL show that the undo was partial and why. The op SHALL still be marked reverted (it was undone to the extent convergence permits). This guarantee is additionally enforced at the storage layer by a UNIQUE partial index on the active-topic slot (see the `persistence` capability).

#### Scenario: Undoing a merge op when all rows still exist

- **GIVEN** a merge op resulted in memories A and B transitioning to `superseded` and a new memory M created with `status = 'active'`
- **AND** none of A, B, M have been purged
- **WHEN** the operator triggers undo for that op
- **THEN** A and B SHALL transition back to `active`, M SHALL transition to `archived`, and the op SHALL be marked as reverted in `consolidation_ops`

#### Scenario: Undoing a merge whose successor inherited an original's topic_key

- **GIVEN** a merge op over A (`topic_key = K`) and B whose successor M took `topic_key = K`
- **WHEN** the operator triggers undo for that op
- **THEN** M SHALL be `archived`, A and B SHALL both be `active`, A SHALL be the sole active row for K, and the undo result SHALL report no skipped rows

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
