## MODIFIED Requirements

### Requirement: The schema MUST track consolidation operations

The `consolidation_ops` table is retained for the decay and orphan-promotion operations performed by the simplified consolidator. The pre-existing op types `merge`, `supersede`, `decay`, `noop`, `failed` SHALL continue to be valid. The `orphan_promote` op type SHALL record per-row orphanings of pending relations by the deterministic sweep: deadline orphaning, rules drains and retired-endpoint drains (see the `consolidation` capability, "Every consolidation decision MUST be journaled"). Each such row records the relation as null and carries the judgment id as `created_id`. Historical `orphan_promote` rows that recorded an LLM promotion verdict, and historical `failed` rows, SHALL remain valid journal rows. No schema change is needed to record any of these.

#### Scenario: An orphan promotion writes a journal entry

- **WHEN** the sweep orphans a pending relation, whether by deadline orphaning, a rules drain or a retired-endpoint drain
- **THEN** a `consolidation_ops` row SHALL exist with `op_type = 'orphan_promote'`, `affected_ids = [sourceId, targetId]`, `created_id` set to the relation's judgment id, and a deterministic reasoning string whose prefix names the step that orphaned it

#### Scenario: An orphan promotion fails

- **WHEN** the drain's orphan-and-journal write fails for a pending relation
- **THEN** the relation SHALL remain `status = 'pending'` and no `consolidation_ops` row SHALL reference it
- **AND** historical rows with `op_type = 'failed'` SHALL remain readable and valid
