## ADDED Requirements

### Requirement: An active memory MAY be pinned, with pin state derived from an append-only journal

An in-scope `active` memory SHALL be pinnable and unpinnable through `MemoryService.setPinned(id, scope, pinned, actor)`, exposed to the agent by the `memory.pin` MCP tool (see the `mcp-api` capability, "The MCP server MUST expose `memory.pin`") and to the operator by the dashboard. Pin state SHALL NOT be stored as a mutable column. Every pin and every unpin SHALL append exactly one row to `memory_pin_events` (see the `persistence` capability), and the current state SHALL be derived at read time: a memory is **pinned** when its `status` is `active` AND its latest `memory_pin_events` row, by insertion order, has `action = 'pin'`. Pinning SHALL NOT update any `memory` column, SHALL NOT insert a `confirmations` row and SHALL NOT touch `last_seen_at`.

Pinning SHALL be scope-bounded exactly as `MemoryService.archive` is: an id that is missing or outside the connection's project SHALL raise `memory_not_found`, and pinning or unpinning a memory that is not `active` SHALL raise `conflict`. A request that would not change the derived state (pinning a pinned memory, unpinning an unpinned one) SHALL append nothing and SHALL report that nothing changed. Pins are per project: the pinned set of a project SHALL contain only memories of that project, and no read or write SHALL reach another project's pins.

The pinned set is bounded by two named compile-time constants, neither operator-configurable nor a per-request tunable:

- `PIN_MAX_PER_PROJECT` (10) — the maximum number of pinned memories in one project. Pinning when the project already holds that many SHALL be refused with `DomainError('pin_limit_reached')` whose details carry `limit` and `pinned: [{ id, title }]` listing every current pin, and SHALL append nothing. The bound SHALL be checked inside the pinning transaction and SHALL apply to every caller, the dashboard included.
- `PINNED_CONTEXT_CHAR_BUDGET` (4000) — the character budget for the content of `memory.context`'s pinned section (see the `mcp-api` capability, "`memory.context` MUST lead with a bounded pinned section outside the ranked channels"). It bounds a read projection only; stored content is untouched.

Retirement SHALL release the pin. When a pinned memory is superseded (by a `topic_key` revision, a `supersedes` verdict or a merge), archived (by `memory.archive` or the dashboard) or decayed by the sweep, or when a merge successor is archived by a merge undo, the retiring transaction SHALL append an `unpin` row for it whose `cause` names the retirement and whose `run_id` is the retirement's journal run when it has one. Every retirement path SHALL release pins through the same shared side effect that orphans its pending judgments, so the two cannot diverge.

A `topic_key` upsert SHALL carry the pin forward: when `memory.save` supersedes the active row of a topic slot and that row is pinned, the same transaction SHALL append an `unpin` row for the predecessor and a `pin` row for the successor, both with `cause = 'topic_key revision'`, without consulting `PIN_MAX_PER_PROJECT` (the carry is net-zero). A merge SHALL NOT carry a pin to its successor.

Undoing a retirement through `undoOp` SHALL restore the memory's status and SHALL NOT append a `pin` row; the released pin remains visible in the memory's pin history.

Pinning SHALL NOT suspend the review axis. A pinned memory SHALL derive `reviewState` exactly as an unpinned one does, and SHALL appear in `memory.context.needsReview[]` when its shelf life elapses.

#### Scenario: Pinning appends an event and derives the pinned state

- **GIVEN** an `active` memory `M` in project `P` with no pin events
- **WHEN** `MemoryService.setPinned('M', P, true, actor)` is called
- **THEN** exactly one `memory_pin_events` row SHALL exist for `M` with `action = 'pin'`
- **AND** `M` SHALL derive as pinned, and its `content`, `title`, `status` and `last_seen_at` SHALL be unchanged

#### Scenario: Unpinning appends an event and keeps the history

- **GIVEN** a pinned memory `M`
- **WHEN** `MemoryService.setPinned('M', P, false, actor)` is called
- **THEN** `M` SHALL derive as not pinned
- **AND** both the `pin` and the `unpin` rows SHALL remain in `memory_pin_events`, in that order

#### Scenario: A request that changes nothing writes nothing

- **GIVEN** a pinned memory `M`
- **WHEN** `MemoryService.setPinned('M', P, true, actor)` is called again
- **THEN** no `memory_pin_events` row SHALL be appended and the result SHALL report that nothing changed

#### Scenario: Pinning past the count bound is refused and names the current pins

- **GIVEN** a project holding `PIN_MAX_PER_PROJECT` pinned memories
- **WHEN** another `active` memory of that project is pinned
- **THEN** the call SHALL raise `pin_limit_reached` whose details list the id and title of every current pin and the limit
- **AND** no `memory_pin_events` row SHALL be appended
- **AND** pinning the same memory after one current pin is unpinned SHALL succeed

#### Scenario: Pins of another project do not count against the bound

- **GIVEN** project `Q` holding `PIN_MAX_PER_PROJECT` pinned memories and project `P` holding none
- **WHEN** a memory of `P` is pinned
- **THEN** the pin SHALL succeed

#### Scenario: Pinning a memory of another project is not found

- **GIVEN** a memory `X` that exists only in project `Q`
- **WHEN** `MemoryService.setPinned('X', P, true, actor)` is called with `P` a different project
- **THEN** the call SHALL raise `memory_not_found` and SHALL append nothing

#### Scenario: Pinning a non-active memory conflicts

- **GIVEN** a memory `M` whose `status` is `superseded` or `archived`
- **WHEN** `MemoryService.setPinned('M', scope-of-M, true, actor)` is called
- **THEN** the call SHALL raise `conflict` and SHALL append nothing

#### Scenario: Archiving a pinned memory releases the pin with the same run

- **GIVEN** a pinned memory `M`
- **WHEN** `MemoryService.archive('M', P)` is called
- **THEN** an `unpin` row SHALL be appended for `M` with `cause = 'archive'` and `run_id` equal to the run of the `agent_memory_archive` op
- **AND** `M` SHALL no longer derive as pinned

#### Scenario: Decay releases the pin

- **GIVEN** a pinned memory `M` eligible for decay
- **WHEN** the sweep archives `M`
- **THEN** an `unpin` row SHALL be appended for `M` with `cause = 'decay'` and the sweep's run id

#### Scenario: A supersedes verdict and a merge release the pin

- **WHEN** a pinned memory is superseded by a `supersedes` verdict, or merged into a successor
- **THEN** an `unpin` row SHALL be appended for it with `cause = 'supersedes verdict'` or `cause = 'merge'` respectively
- **AND** a merge successor SHALL NOT derive as pinned

#### Scenario: A topic_key upsert carries the pin to the successor

- **GIVEN** a pinned memory `M` holding `topic_key = 'decision/deploy-runbook'`
- **WHEN** `memory.save` is called with the same `topic_key`, creating successor `N`
- **THEN** `M` SHALL be `superseded` with an `unpin` row of `cause = 'topic_key revision'`
- **AND** `N` SHALL derive as pinned with a `pin` row of `cause = 'topic_key revision'`
- **AND** the project's pinned count SHALL be unchanged, even when it equals `PIN_MAX_PER_PROJECT`

#### Scenario: Undoing an archive restores the memory but not the pin

- **GIVEN** a pinned memory `M` that was archived, releasing its pin
- **WHEN** `undoOp` reverts that archive
- **THEN** `M` SHALL be `active` and SHALL NOT derive as pinned

#### Scenario: A pinned memory still needs review

- **GIVEN** a pinned memory whose shelf life has elapsed with no affirmation
- **WHEN** its review state is derived
- **THEN** it SHALL derive `needs_review`, exactly as the same memory unpinned would

## MODIFIED Requirements

### Requirement: Memories MAY be physically purged when archived and disconnected

A row SHALL be physically deletable from the `memory` table ONLY through `MemoryService.purgeDisconnectedArchived({ adminBypass: true })` and ONLY when the row satisfies all of the following at the moment of deletion:

1. `status = 'archived'`.
2. No row exists in the derived `memory_replaces` table with this row's id as `predecessor_id`. (No supersession chain reaches this row.) `memory_replaces` is a reverse-edge index over `memory.replaces`, kept in sync by triggers — this condition is behaviorally identical to "no other row in `memory` has this row's id in its `replaces` JSON array," just checked against the indexed table instead of a full-table `json_each` scan.
3. No row in `consolidation_ops` **other than an `agent_memory_archive` op** references this row's id via its `affected_ids` JSON array. An `agent_memory_archive` op IS the journal of the archive that retired this very memory; it exists to record and (optionally) reverse that archive, so it SHALL NOT pin its own subject against a later operator purge. A reference from any OTHER op type (e.g. `decay`, `merge`, `supersede`) still blocks the purge.
4. No row in `consolidation_ops` references this row's id via its `created_id` column.
5. No row in `memory_relations` references this row's id via `source_id` or `target_id`.
6. No row in `confirmations` references this row's id via `memory_id`.
7. No row in `memory_pin_events` references this row's id via `memory_id`. A pin history is audit-relevant in the same way a confirmation is, and keeping such rows out of the purge is what lets the pin journal have no DELETE path at all.

The method SHALL delete the matching rows from `memory_vec`, `memory_fts`, and `memory` inside a single SQLite transaction, in that order (drop derived data first, base data last, so derived-table syncs do not observe a half-deleted base row). The `memory_replaces_ad` trigger removes the deleted row's own entries from `memory_replaces` (both as predecessor and as successor) as part of the same `DELETE FROM memory` statement — no separate cleanup step is needed. The method SHALL write a `consolidation_ops` row with `op_type = 'archived_memory_purge'`, `affected_ids` carrying the deleted memory ids, and a static `reasoning` string, in the same transaction. Purging a memory whose only journal reference was its `agent_memory_archive` op renders that op's undo terminal (the row cannot be reconstructed), handled by the existing purged-referent path in `undoOp`.

Without `adminBypass: true`, the method SHALL throw `DomainError('forbidden', ...)` and SHALL NOT touch the database.

#### Scenario: A fully-disconnected archived memory is purged

- **GIVEN** memory `M` with `status='archived'`, not referenced by any other `memory.replaces`, any `consolidation_ops.affected_ids` (other than its own `agent_memory_archive` op) or `created_id`, any `memory_relations.source_id` or `target_id`, any `confirmations.memory_id`, or any `memory_pin_events.memory_id`
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

#### Scenario: An archived memory with a pin history is preserved

- **GIVEN** memory `M` with `status='archived'`, at least one `memory_pin_events` row whose `memory_id = M.id`, and no other blocking reference
- **WHEN** `MemoryService.purgeDisconnectedArchived({ adminBypass: true })` is called
- **THEN** `M` SHALL remain in `memory` and every `memory_pin_events` row for `M` SHALL remain
- **AND** `M.id` SHALL NOT appear in the response's `deletedIds`

#### Scenario: An active or superseded memory is never purged

- **GIVEN** memory `M` with `status IN ('active', 'superseded')`, even if all other "disconnected" conditions hold
- **WHEN** `MemoryService.purgeDisconnectedArchived({ adminBypass: true })` is called
- **THEN** `M` SHALL remain in `memory` — only archived rows are eligible

#### Scenario: A non-admin caller is rejected before any read

- **WHEN** `MemoryService.purgeDisconnectedArchived({})` or `MemoryService.purgeDisconnectedArchived({ adminBypass: false })` is called
- **THEN** the method SHALL throw `DomainError('forbidden', ...)`
- **AND** SHALL NOT issue any SQL statement

