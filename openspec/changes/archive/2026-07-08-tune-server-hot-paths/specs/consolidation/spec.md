## MODIFIED Requirements

### Requirement: Aged pending relations MUST be deterministically orphaned after a deadline

A `memory_relations` row with `status = 'pending'` and `created_at < (now - JUDGMENT_ORPHAN_DEADLINE_MS)` (default 14 days) SHALL be transitioned to `status = 'orphaned'` by the sweep, with `marked_by_kind = 'consolidator'`. Each orphaning SHALL be journaled in `consolidation_ops` and SHALL be undoable while the referenced rows exist. No LLM SHALL be involved. Between `JUDGMENT_ORPHAN_AFTER_MS` (default 24h) and the deadline, the pending row SHALL be surfaced to agents via `memory.context` (see `mcp-api` capability) so it can be closed with `memory.judge` under fresh context.

The orphaning pass SHALL select its candidates with a query scoped to the swept scope (the scope filter applied in SQL, oldest-first, bounded by the per-run batch size). Rows belonging to other scopes SHALL NOT consume the swept scope's batch budget, so a backlog in one scope cannot starve another scope's overdue pendings.

#### Scenario: A pending relation crosses the deadline

- **GIVEN** a pending relation older than `JUDGMENT_ORPHAN_DEADLINE_MS`
- **WHEN** the sweep runs for its scope
- **THEN** the row SHALL transition to `status = 'orphaned'` and a journaled op SHALL record it; the orphaned status is final unless a future `memory.judge` or `memory.compare` call writes a fresh row

#### Scenario: A pending relation is between the re-expose threshold and the deadline

- **GIVEN** a pending relation older than `JUDGMENT_ORPHAN_AFTER_MS` but younger than `JUDGMENT_ORPHAN_DEADLINE_MS`
- **WHEN** the sweep runs
- **THEN** the row SHALL remain `pending` (only `memory.context` exposure applies)

#### Scenario: A large backlog in one scope does not starve another

- **GIVEN** project A has more overdue pending relations than the per-run batch size and project B has one overdue pending relation
- **WHEN** the sweep runs for project B
- **THEN** project B's overdue row SHALL be orphaned in that run, regardless of project A's backlog
