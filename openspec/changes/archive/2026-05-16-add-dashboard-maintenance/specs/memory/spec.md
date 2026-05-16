## MODIFIED Requirements

### Requirement: Memories MUST be append-only

The system SHALL never delete a memory row and SHALL never mutate the `content` of an existing memory, EXCEPT through the operator-only physical-purge escape hatch defined in "Memories MAY be physically purged when archived and disconnected". Lifecycle changes are otherwise expressed exclusively by transitioning the `status` column among `active`, `superseded`, and `archived`, and by setting the `replaces` JSON array on newly inserted memories.

#### Scenario: Code path attempts to physically delete a memory

- **WHEN** any service or migration emits a `DELETE FROM memory` statement from any file OTHER than `src/services/memory.ts`
- **THEN** a CI invariant test SHALL fail and the build SHALL be rejected

#### Scenario: Code path attempts to mutate `content`

- **WHEN** any service emits an `UPDATE memory SET content = ?` statement
- **THEN** a CI invariant test SHALL fail and the build SHALL be rejected

## ADDED Requirements

### Requirement: Memories MAY be physically purged when archived and disconnected

A row SHALL be physically deletable from the `memory` table ONLY through `MemoryService.purgeDisconnectedArchived({ adminBypass: true })` and ONLY when the row satisfies all of the following at the moment of deletion:

1. `status = 'archived'`.
2. No other row in `memory` has this row's id in its `replaces` JSON array. (No supersession chain reaches this row.)
3. No row in `consolidation_ops` references this row's id via its `affected_ids` JSON array.
4. No row in `consolidation_ops` references this row's id via its `created_id` column.
5. No row in `memory_relations` references this row's id via `source_id` or `target_id`.
6. No row in `confirmations` references this row's id via `memory_id`.

The method SHALL delete the matching rows from `memory_vec`, `memory_fts`, and `memory` inside a single SQLite transaction, in that order (drop derived data first, base data last, so derived-table syncs do not observe a half-deleted base row). The method SHALL write a `consolidation_ops` row with `op_type = 'archived_memory_purge'`, `affected_ids` carrying the deleted memory ids, and a static `reasoning` string, in the same transaction.

Without `adminBypass: true`, the method SHALL throw `DomainError('forbidden', ...)` and SHALL NOT touch the database.

#### Scenario: A fully-disconnected archived memory is purged

- **GIVEN** memory `M` with `status='archived'`, not referenced by any other `memory.replaces`, any `consolidation_ops.affected_ids` or `created_id`, any `memory_relations.source_id` or `target_id`, or any `confirmations.memory_id`
- **WHEN** `MemoryService.purgeDisconnectedArchived({ adminBypass: true })` is called
- **THEN** the row SHALL be removed from `memory`
- **AND** any matching row in `memory_vec` SHALL be removed
- **AND** any matching row in `memory_fts` SHALL be removed
- **AND** a row SHALL exist in `consolidation_ops` with `op_type='archived_memory_purge'` and `affected_ids` containing `M.id`
- **AND** the response SHALL include `M.id` in `deletedIds`

#### Scenario: An archived memory referenced by a later replaces is preserved

- **GIVEN** memory `M` with `status='archived'` and memory `N` with `replaces` containing `M.id`
- **WHEN** `MemoryService.purgeDisconnectedArchived({ adminBypass: true })` is called
- **THEN** `M` SHALL remain in `memory` — the supersession chain reaches it
- **AND** `M.id` SHALL NOT appear in the response's `deletedIds`

#### Scenario: An archived memory referenced by a consolidation op is preserved

- **GIVEN** memory `M` with `status='archived'` and a `consolidation_ops` row whose `affected_ids` contains `M.id`
- **WHEN** `MemoryService.purgeDisconnectedArchived({ adminBypass: true })` is called
- **THEN** `M` SHALL remain in `memory` — the consolidation journal still references it
- **AND** the consolidation op SHALL remain reversible

#### Scenario: An archived memory referenced by a memory_relations row is preserved

- **GIVEN** memory `M` with `status='archived'` and a `memory_relations` row whose `source_id` or `target_id` equals `M.id`
- **WHEN** `MemoryService.purgeDisconnectedArchived({ adminBypass: true })` is called
- **THEN** `M` SHALL remain in `memory`

#### Scenario: An archived memory with a surviving confirmation is preserved

- **GIVEN** memory `M` with `status='archived'` and at least one `confirmations` row whose `memory_id = M.id`
- **WHEN** `MemoryService.purgeDisconnectedArchived({ adminBypass: true })` is called
- **THEN** `M` SHALL remain in `memory` — confirmation history is audit-relevant

#### Scenario: An active or superseded memory is never purged

- **GIVEN** memory `M` with `status IN ('active', 'superseded')`, even if all other "disconnected" conditions hold
- **WHEN** `MemoryService.purgeDisconnectedArchived({ adminBypass: true })` is called
- **THEN** `M` SHALL remain in `memory` — only archived rows are eligible

#### Scenario: A non-admin caller is rejected before any read

- **WHEN** `MemoryService.purgeDisconnectedArchived({})` or `MemoryService.purgeDisconnectedArchived({ adminBypass: false })` is called
- **THEN** the method SHALL throw `DomainError('forbidden', ...)`
- **AND** SHALL NOT issue any SQL statement

### Requirement: The archived-memory purge journal is permanent

`consolidation_ops` rows written by `purgeDisconnectedArchived` SHALL NOT themselves be subject to deletion. The journal preserves the audit trail of WHICH memory ids existed and WHEN they were removed, even after the memory rows and their embeddings are gone.

#### Scenario: An archived-memory purge journal row survives later purges

- **GIVEN** `purgeDisconnectedArchived` has run and produced a `consolidation_ops` row referencing 43 deleted memory ids
- **WHEN** a subsequent `purgeDisconnectedArchived` runs on a different set of memory ids
- **THEN** the original `consolidation_ops` row SHALL still exist and its `affected_ids` SHALL still list the original 43 ids
