## ADDED Requirements

### Requirement: An active memory MAY be archived at explicit user request

An in-scope `active` memory SHALL be archivable through `MemoryService.archive(id, scope)` as a reversible `status` flip to `archived`, exposed to the agent by the `memory.archive` MCP tool. This is the **no-successor** retirement path and is distinct from supersede: it SHALL NOT set a `replaces` link, SHALL NOT insert a `supersedes` `memory_relations` row, and SHALL NOT delete the row, drop its `memory_vec`/`memory_fts` shadow rows, or mutate `content`/`title`. It is therefore consistent with the append-only invariant, which already sanctions the `active → archived` transition.

Archiving SHALL be strictly scope-bounded: the service SHALL resolve the row via the same scope check as `memory.confirm`, and an id that is missing or belongs to a different `(scope, project_id)` SHALL raise `memory_not_found`. There is no cross-scope or cross-project archive path. Only `active` memories are eligible; archiving a `superseded` or `archived` memory SHALL raise `conflict`.

Every archive SHALL be journaled — in the SAME transaction as the `status` flip — as a `consolidation_ops` row with `op_type = 'agent_memory_archive'` and `affected_ids` carrying the archived memory id, so the retirement is attributable and reversible through the same journal the sweep uses. The archive SHALL be reversible: an `agent_memory_archive` op SHALL be undoable via `undoOp` exactly as a `decay` op is (the affected memory is flipped back to `active`, subject to the same `topic_key`-slot-occupied guard), so an operator can revert an agent's archive from the consolidation view. Because this journal row's sole purpose is to record the archive of its own subject, it SHALL NOT count as a purge-blocking reference for that memory (see the modified purge requirement below).

#### Scenario: Archiving an active memory retires it from active recall

- **GIVEN** an `active` memory `M` in scope `S`
- **WHEN** `MemoryService.archive('M', S)` is called
- **THEN** `M.status` SHALL become `archived`
- **AND** `M` SHALL no longer appear in a default (`status = 'active'`) `memory.search` or `memory.context` in scope `S`
- **AND** `M.content`, `M.title`, and `M.replaces` SHALL be unchanged, and no `memory_relations` row SHALL be inserted for the archive

#### Scenario: Archive is journaled and reversible

- **WHEN** `MemoryService.archive('M', S)` completes for an active memory `M`
- **THEN** a `consolidation_ops` row SHALL exist with `op_type = 'agent_memory_archive'` and `affected_ids` containing `M.id`
- **AND** calling `undoOp` on that op SHALL flip `M` back to `status = 'active'` and mark the op `reverted_at`

#### Scenario: Archiving a cross-scope id is not found

- **GIVEN** a memory `X` that exists only in project `A`
- **WHEN** `MemoryService.archive('X', S)` is called with `S` being global scope or project `B`
- **THEN** the call SHALL raise `memory_not_found`
- **AND** `X.status` SHALL be unchanged

#### Scenario: Archiving a non-active memory conflicts

- **GIVEN** a memory `M` whose `status` is `superseded` or `archived`
- **WHEN** `MemoryService.archive('M', scope-of-M)` is called
- **THEN** the call SHALL raise `conflict`
- **AND** `M.status` SHALL be unchanged

## MODIFIED Requirements

### Requirement: Memories MAY be physically purged when archived and disconnected

A row SHALL be physically deletable from the `memory` table ONLY through `MemoryService.purgeDisconnectedArchived({ adminBypass: true })` and ONLY when the row satisfies all of the following at the moment of deletion:

1. `status = 'archived'`.
2. No row exists in the derived `memory_replaces` table with this row's id as `predecessor_id`. (No supersession chain reaches this row.) `memory_replaces` is a reverse-edge index over `memory.replaces`, kept in sync by triggers — this condition is behaviorally identical to "no other row in `memory` has this row's id in its `replaces` JSON array," just checked against the indexed table instead of a full-table `json_each` scan.
3. No row in `consolidation_ops` **other than an `agent_memory_archive` op** references this row's id via its `affected_ids` JSON array. An `agent_memory_archive` op IS the journal of the archive that retired this very memory; it exists to record and (optionally) reverse that archive, so it SHALL NOT pin its own subject against a later operator purge. A reference from any OTHER op type (e.g. `decay`, `merge`, `supersede`) still blocks the purge.
4. No row in `consolidation_ops` references this row's id via its `created_id` column.
5. No row in `memory_relations` references this row's id via `source_id` or `target_id`.
6. No row in `confirmations` references this row's id via `memory_id`.

The method SHALL delete the matching rows from `memory_vec`, `memory_fts`, and `memory` inside a single SQLite transaction, in that order (drop derived data first, base data last, so derived-table syncs do not observe a half-deleted base row). The `memory_replaces_ad` trigger removes the deleted row's own entries from `memory_replaces` (both as predecessor and as successor) as part of the same `DELETE FROM memory` statement — no separate cleanup step is needed. The method SHALL write a `consolidation_ops` row with `op_type = 'archived_memory_purge'`, `affected_ids` carrying the deleted memory ids, and a static `reasoning` string, in the same transaction. Purging a memory whose only journal reference was its `agent_memory_archive` op renders that op's undo terminal (the row cannot be reconstructed), handled by the existing purged-referent path in `undoOp`.

Without `adminBypass: true`, the method SHALL throw `DomainError('forbidden', ...)` and SHALL NOT touch the database.

#### Scenario: A fully-disconnected archived memory is purged

- **GIVEN** memory `M` with `status='archived'`, not referenced by any other `memory.replaces`, any `consolidation_ops.affected_ids` (other than its own `agent_memory_archive` op) or `created_id`, any `memory_relations.source_id` or `target_id`, or any `confirmations.memory_id`
- **WHEN** `MemoryService.purgeDisconnectedArchived({ adminBypass: true })` is called
- **THEN** the row SHALL be removed from `memory`
- **AND** any matching row in `memory_vec` SHALL be removed
- **AND** any matching row in `memory_fts` SHALL be removed
- **AND** a row SHALL exist in `consolidation_ops` with `op_type='archived_memory_purge'` and `affected_ids` containing `M.id`
- **AND** the response SHALL include `M.id` in `deletedIds`

#### Scenario: An archived memory referenced only by its own agent_memory_archive op is still purgeable

- **GIVEN** memory `M` with `status='archived'` whose only `consolidation_ops.affected_ids` reference is the `agent_memory_archive` op that archived it, and no other blocking reference
- **WHEN** `MemoryService.purgeDisconnectedArchived({ adminBypass: true })` is called
- **THEN** `M` SHALL be removed from `memory` and `M.id` SHALL appear in `deletedIds`

#### Scenario: An archived memory referenced by a later replaces is preserved

- **GIVEN** memory `M` with `status='archived'` and memory `N` with `replaces` containing `M.id`
- **WHEN** `MemoryService.purgeDisconnectedArchived({ adminBypass: true })` is called
- **THEN** `M` SHALL remain in `memory` — the supersession chain reaches it
- **AND** `M.id` SHALL NOT appear in the response's `deletedIds`

#### Scenario: An archived memory referenced by a non-archive consolidation op is preserved

- **GIVEN** memory `M` with `status='archived'` and a `consolidation_ops` row whose `op_type` is NOT `agent_memory_archive` (e.g. `decay`) and whose `affected_ids` contains `M.id`
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
