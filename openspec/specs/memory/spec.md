# memory Specification

## Purpose

Defines the core memory model: append-only semantics, scope isolation (global vs project), supersedes chains, confirmations, retrieval with history, and in-process always-on embeddings.

## Requirements

### Requirement: Memories MUST be append-only

The system SHALL never delete a memory row and SHALL never mutate the `content` of an existing memory, EXCEPT through the operator-only physical-purge escape hatch defined in "Memories MAY be physically purged when archived and disconnected". Lifecycle changes are otherwise expressed exclusively by transitioning the `status` column among `active`, `superseded`, and `archived`, and by setting the `replaces` JSON array on newly inserted memories.

#### Scenario: Code path attempts to physically delete a memory

- **WHEN** any service or migration emits a `DELETE FROM memory` statement from any file OTHER than `apps/server/src/services/memory.ts`
- **THEN** a CI invariant test SHALL fail and the build SHALL be rejected

#### Scenario: Code path attempts to mutate `content`

- **WHEN** any service emits an `UPDATE memory SET content = ?` statement
- **THEN** a CI invariant test SHALL fail and the build SHALL be rejected

### Requirement: Memories MUST be scoped to either global or a project

Every memory row SHALL carry a `scope` of either `global` or `project`. When `scope = 'project'`, `project_id` SHALL reference an existing row in `projects` and SHALL NOT be null. When `scope = 'global'`, `project_id` SHALL be null.

#### Scenario: Saving a project memory with a missing project id

- **WHEN** `memory.save` is called with `scope = 'project'` and no `project_id`
- **THEN** the call SHALL reject with a validation error and SHALL NOT insert any row

#### Scenario: Saving a global memory with a project id

- **WHEN** `memory.save` is called with `scope = 'global'` and a non-null `project_id`
- **THEN** the call SHALL reject with a validation error and SHALL NOT insert any row

### Requirement: Memory search MUST respect scope isolation

`memory.search` SHALL return only memories matching the requested scope. When scoped to a project, results MAY also include `global` memories at the caller's request; under no circumstances SHALL results from a different `project_id` be returned.

#### Scenario: Searching within a project returns only that project plus globals when requested

- **WHEN** `memory.search` is called with `scope = 'project'`, `project_id = 'A'`, `include_global = true`
- **THEN** the response SHALL include memories with `scope = 'global'` or `(scope = 'project' AND project_id = 'A')` only

#### Scenario: Searching globals never returns project memories

- **WHEN** `memory.search` is called with `scope = 'global'`
- **THEN** the response SHALL contain no row whose `scope` is `project`

### Requirement: Confirmations MUST follow the supersedes chain

`memory.confirm(id)` SHALL walk the `replaces` graph forward from the given memory and SHALL record the confirmation against the current head (the memory with `status = active` reachable from the input id). If the input id is already the head, the confirmation is recorded against it directly.

#### Scenario: Confirming a superseded memory propagates to the head

- **GIVEN** memory A was merged into memory M, with A.status = 'superseded' and M.status = 'active', M.replaces containing A
- **WHEN** `memory.confirm('A')` is called
- **THEN** a row SHALL be inserted into `confirmations` with `memory_id = 'M'`

#### Scenario: Confirming an active memory records directly

- **WHEN** `memory.confirm('M')` is called and M.status = 'active'
- **THEN** a row SHALL be inserted into `confirmations` with `memory_id = 'M'`

### Requirement: Memory retrieval MUST expose history

`memory.get(id)` SHALL return the memory along with its full ancestry: the chain of predecessors via `replaces`, the count of confirmations against the current head, AND the set of judged relations involving the memory (sourced from `memory_relations`).

#### Scenario: Retrieving a merged memory

- **WHEN** `memory.get('M')` is called and M was formed by merging A and B
- **THEN** the response SHALL include the content of M, the predecessor ids `['A','B']`, the predecessors' content snapshots, the current confirmation count for M, and a `relations` array containing the `supersedes` entries for A and B

#### Scenario: Retrieving a memory with a pending judgment

- **GIVEN** memory N was just saved and a candidate-detection step inserted a `memory_relations` row with `status = 'pending'` referencing memory M
- **WHEN** `memory.get('N')` is called
- **THEN** the response's `relations` array SHALL include `{ kind: 'pending_conflict', targetId: 'M', judgmentId, status: 'pending' }`

### Requirement: Embeddings MUST be computed in-process by a model loaded at boot

The embedding model (gte-multilingual-base, ONNX q8, 768 dims, `pooling: 'cls'`, `normalize: true`) SHALL be loaded during bootstrap, BEFORE the HTTP listener starts. A model that cannot load SHALL abort the boot with a non-zero exit (fail fast — a listening server always has a warm model; there is no cold state). Each newly saved memory SHALL receive its embedding inline before candidate detection runs (ms-scale). An inference failure SHALL NOT fail the save: detection degrades to FTS5 for that save and the background drain retries the row. There SHALL be no external embedding endpoint, no API key, and no off switch.

#### Scenario: Saving a memory

- **WHEN** `memory.save(…)` is called
- **THEN** the row's embedding SHALL be computed inline and persisted into `memory_vec` before candidate detection runs, so vec-sourced candidates can surface in the same save's response

#### Scenario: The model cannot load at boot

- **WHEN** the server starts and the embedding model fails to load (missing, corrupt, or incompatible artifacts)
- **THEN** the boot SHALL fail with a non-zero exit before the HTTP listener starts — the server SHALL NOT run in a degraded no-embeddings mode

#### Scenario: A single inference fails at save time

- **WHEN** `memory.save(…)` is called and the inline embedding throws
- **THEN** the save SHALL succeed, candidate detection SHALL operate on FTS5 only for that save, the failure SHALL be logged, and the drain SHALL retry the row

### Requirement: Stale vectors MUST be re-embedded after a model change

The data dir SHALL record the embedding model identity. When the server starts and the recorded identity differs from the compiled-in model (including the upgrade from the external-provider era), all non-archived memories SHALL be re-embedded in batches by the in-process embedder, resumable across restarts, with progress logged. Candidate detection SHALL keep working (FTS5 + whatever vectors are fresh) throughout the backfill.

#### Scenario: First boot after the upgrade

- **GIVEN** a data dir whose `memory_vec` rows were produced by a different model
- **WHEN** the server starts
- **THEN** the backfill SHALL begin in the background, the server SHALL serve requests immediately, and after completion every active memory SHALL have a vector produced by the compiled-in model

#### Scenario: Backfill interrupted by a restart

- **WHEN** the process restarts mid-backfill
- **THEN** the backfill SHALL resume from the remaining unembedded rows, not start over

### Requirement: Memories MAY upsert by `(scope, project_id, topic_key)`

The `memory` table SHALL gain a nullable `topic_key TEXT` column. When `memory.save` is called with a non-null `topic_key`, the server SHALL look up the active memory in the same `(scope, project_id, topic_key)` slot and, if one exists, SHALL transition it to `superseded` within the same transaction as the new insert. The new row's `replaces` array SHALL include the superseded row's id. A `memory_relations` row SHALL be inserted with `relation = 'supersedes'`, `status = 'judged'`, and `marked_by_kind = 'agent_topic_key'`.

#### Scenario: First save with a new `topic_key`

- **WHEN** `memory.save({type, content, topic_key: 'architecture/auth'})` is called and no existing memory has that key in scope
- **THEN** a new memory SHALL be inserted with `topic_key = 'architecture/auth'` and an empty `replaces`; no `memory_relations` row SHALL be created for the topic_key path (candidates from FTS/vec may still surface separately)

#### Scenario: Second save with the same `topic_key`

- **GIVEN** an active memory M with `topic_key = 'architecture/auth'` already exists in scope
- **WHEN** `memory.save({type, content, topic_key: 'architecture/auth'})` is called
- **THEN** within a single transaction: (a) a new memory N SHALL be inserted with `topic_key = 'architecture/auth'`, `replaces = ['M', ...]`, `status = 'active'`; (b) M SHALL transition to `status = 'superseded'`; (c) a `memory_relations` row SHALL be inserted with `source_id = N`, `target_id = M`, `relation = 'supersedes'`, `status = 'judged'`, `marked_by_kind = 'agent_topic_key'`

#### Scenario: `topic_key` exceeds the maximum length

- **WHEN** `memory.save({topic_key})` is called with a `topic_key` longer than 128 characters
- **THEN** the call SHALL be rejected with code `invalid_input` and SHALL NOT insert any row

#### Scenario: `topic_key` is the empty string

- **WHEN** `memory.save({topic_key: ''})` is called
- **THEN** the empty string SHALL be normalized to `NULL` (no upsert path); the save SHALL proceed as if no `topic_key` were provided

### Requirement: `memory.save` MUST surface candidate conflicts at save-time

After a `memory.save` inserts the new row, the server SHALL run a candidate-detection step over rows in the same `(scope, project_id)`, excluding the newly inserted row and any rows already linked to it via `replaces`. The detection SHALL combine FTS5 lexical neighbors (always) and vec kNN neighbors (when the just-saved row has an embedding), apply the internal similarity thresholds (compile-time constants, calibrated for the compiled-in model — not environment-configurable), deduplicate by target id, and return up to `CANDIDATES_PER_SAVE_MAX` (default 5) candidates ordered by max(vec, fts) score descending.

For each candidate surfaced, a `memory_relations` row SHALL be inserted with `status = 'pending'`, `source_id = <new row>`, `target_id = <candidate>`, and a generated `judgment_id`.

#### Scenario: A save finds two strong candidates

- **GIVEN** two existing active memories M1 and M2 in the same scope each exceed the internal vec threshold against the just-saved row N
- **WHEN** `memory.save({...})` returns
- **THEN** the response SHALL include `candidates: [{ judgmentId, targetId: M1, snippet, similarity, source }, { judgmentId, targetId: M2, ... }]` and `judgmentRequired: true`; two `memory_relations` rows SHALL exist with `status = 'pending'`

#### Scenario: A save finds zero candidates

- **WHEN** no existing memory exceeds the thresholds
- **THEN** the response SHALL include `candidates: []` and `judgmentRequired: false`; no `memory_relations` rows SHALL be inserted

#### Scenario: The just-saved row has no embedding

- **GIVEN** the inline embedding of the just-saved row failed (logged, drain will retry)
- **WHEN** `memory.save` runs candidate detection
- **THEN** only FTS5-derived candidates SHALL be considered; each candidate in the response SHALL carry `source: 'fts'`

#### Scenario: Candidate count exceeds the cap

- **GIVEN** `CANDIDATES_PER_SAVE_MAX = 5` and 12 candidates exceed the thresholds
- **WHEN** `memory.save` returns
- **THEN** the response SHALL include the top 5 by score; the remaining 7 SHALL NOT have `memory_relations` rows inserted and SHALL NOT surface to the agent

#### Scenario: Candidate detection respects scope

- **GIVEN** the just-saved row is in scope `project:'A'`
- **WHEN** candidate detection runs
- **THEN** every candidate's `(scope, project_id)` SHALL match `project:'A'`; rows in other projects or in global SHALL NOT be considered, regardless of similarity

### Requirement: Search results MUST carry relation annotations

`memory.search` SHALL include a `relations` array on each result row, sourced from `memory_relations` in a single JOIN (no N+1). The annotations SHALL cover `supersedes`, `superseded_by`, `conflicts_with`, `related`, `compatible`, `scoped` (judged), and `pending_conflict` (status = 'pending'). The cap per memory is 10 annotations (configurable); excess annotations are visible via the dashboard.

#### Scenario: A judged supersedes relation appears on both sides

- **GIVEN** memory N supersedes memory M (judged)
- **WHEN** `memory.search` includes N or M in its results
- **THEN** N's row SHALL include `{ kind: 'supersedes', targetId: 'M', snippet }` and M's row (when surfaced) SHALL include `{ kind: 'superseded_by', targetId: 'N', snippet }`

#### Scenario: A pending judgment surfaces as `pending_conflict`

- **GIVEN** a save-time candidate between N and M was inserted as `status='pending'` and not yet judged
- **WHEN** `memory.search` returns N
- **THEN** N's `relations` SHALL include `{ kind: 'pending_conflict', targetId: 'M', judgmentId }`

#### Scenario: No relations on a clean memory

- **WHEN** a memory has no rows in `memory_relations`
- **THEN** the search result row SHALL include `relations: []` (the field is always present, never omitted)

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
