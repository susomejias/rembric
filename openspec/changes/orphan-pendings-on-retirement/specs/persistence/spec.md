## ADDED Requirements

### Requirement: The `orphan_promote` op type MUST also record orphanings made at retirement

Besides the sweep's orphanings, the `orphan_promote` op type SHALL record each pending relation that a retirement orphaned (see the `consolidation` capability, "Retiring a memory MUST orphan its pending judgments in the same transaction"). Each such row SHALL record the relation as null, carry the judgment id as `created_id` and `[sourceId, targetId]` as `affected_ids`, and carry a reasoning string whose prefix is `endpoint retired at retirement`. Its `run_id` SHALL name either the run of the retirement's own journal op or a `maintenance` run of kind `retirement_orphan`. No schema change, new column or new op type SHALL be needed to record it.

#### Scenario: A retirement orphaning writes a journal entry

- **WHEN** a retirement orphans a pending relation
- **THEN** a `consolidation_ops` row SHALL exist with `op_type = 'orphan_promote'`, `affected_ids = [sourceId, targetId]`, `created_id` set to the relation's judgment id, and a reasoning string starting with `orphaned: endpoint retired at retirement:`

#### Scenario: A retirement orphaning fails

- **WHEN** the journal insert for a retirement orphaning fails
- **THEN** the relation SHALL remain `status = 'pending'`, no `consolidation_ops` row SHALL reference it, and the retirement SHALL not be applied
