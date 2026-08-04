## ADDED Requirements

### Requirement: Every memory MUST belong to exactly one project

Every memory row SHALL be attached to exactly one project. `project_id` SHALL reference an existing row in `projects` and SHALL NOT be null. There SHALL be no memory that belongs to no project, and no read SHALL return a memory belonging to a project other than the one the caller's scope resolved to.

This replaces "Memories MUST be scoped to either global or a project". The `memory.scope` column remains present in this release, written as the constant `'project'` on every insert, solely so a rolled-back previous image can still execute its own queries; it carries no information and no read SHALL branch on it. Its removal is a separate change.

#### Scenario: A memory cannot be saved without a project

- **WHEN** a memory insert is attempted with `project_id` null
- **THEN** the insert SHALL be rejected and no row SHALL be created

#### Scenario: A memory cannot be saved against a project that does not exist

- **WHEN** a memory insert is attempted with a `project_id` naming no row in `projects`
- **THEN** the insert SHALL be rejected and no row SHALL be created

#### Scenario: No read admits a second project's rows

- **GIVEN** two projects each holding memories, and no argument on any read tool that widens a result set past its scope
- **WHEN** a read is performed in the scope of one of them
- **THEN** the result SHALL contain only that project's memories, and no request argument SHALL be able to change that

#### Scenario: The retained scope column is constant

- **WHEN** any memory row is inserted by any runtime path after this change
- **THEN** its `scope` column SHALL hold `'project'`
- **AND** no repository read SHALL use the value of `scope` to select rows other than as a constant conjunct

## MODIFIED Requirements

### Requirement: Memories MUST be append-only

The system SHALL never delete a memory row and SHALL never mutate the `content` or `title` of an existing memory, EXCEPT through the operator-only physical-purge escape hatch defined in "Memories MAY be physically purged when archived and disconnected". Lifecycle changes are otherwise expressed exclusively by transitioning the `status` column among `active`, `superseded`, and `archived`, and by setting the `replaces` JSON array on newly inserted memories. Because `title` is fixed at insert and never updated, a memory's title can never drift away from the immutable `content` it labels.

One carve-out is added, scoped as narrowly as the case requires: **a schema migration MAY rewrite a memory row's `project_id` where doing so preserves a row that would otherwise become unreachable.** No runtime path may — not a service, not a repository method, not a consolidation op, not an MCP tool. The carve-out exists because retiring a scope leaves rows attached to a partition that no longer resolves, and a row nothing can address is a deleted row in every sense except the physical one. Its bound is that the rewrite SHALL be part of an applied migration, SHALL preserve the total row count, and SHALL be journaled in the boot report so an operator can see it happened.

`content` and `title` remain immutable under this carve-out, and lifecycle remains `status` flips plus `replaces` links. Nothing here permits a migration to change what a memory SAYS — only which project addresses it.

#### Scenario: Code path attempts to physically delete a memory

- **WHEN** any service or migration emits a `DELETE FROM memory` statement from any file OTHER than `apps/server/src/services/memory.ts`
- **THEN** a CI invariant test SHALL fail and the build SHALL be rejected

#### Scenario: Code path attempts to mutate `content`

- **WHEN** any service emits an `UPDATE memory SET content = ?` statement
- **THEN** a CI invariant test SHALL fail and the build SHALL be rejected

#### Scenario: Code path attempts to mutate `title`

- **WHEN** any service emits an `UPDATE memory SET title = ?` statement
- **THEN** a CI invariant test SHALL fail and the build SHALL be rejected

#### Scenario: A runtime path attempts to rewrite `project_id`

- **WHEN** any file under `apps/server/src` other than `apps/server/src/db/migrations/` emits an `UPDATE memory SET project_id` statement
- **THEN** a CI invariant test SHALL fail and the build SHALL be rejected

#### Scenario: A migration rewriting `project_id` conserves the corpus

- **GIVEN** a populated database whose memories are spread across the retiring partition and one or more projects
- **WHEN** the migration that repoints them is applied
- **THEN** the total `memory` row count SHALL be unchanged, `PRAGMA foreign_key_check` SHALL report no violations, and `PRAGMA integrity_check` SHALL report `ok`
- **AND** the number of rows repointed SHALL be reported in the boot output

### Requirement: The vector index MUST mirror the memory lifecycle and support scoped kNN over an arbitrary query vector

`memory_vec` is a derived index, not primary data: an embedding is a deterministic function of `memory.content` (which append-only preserves) and is recomputable at any time. The index therefore is NOT bound by the append-only invariant of the `memory` table; it MAY be updated to track the memory lifecycle, mirroring the existing `memory_fts` trigger-driven sync. `memory_vec` SHALL carry a scope-derived partition key — the owning memory's `project_id`, with no sentinel value and no unpartitioned rows — plus a `status` and a `type`. The partition key, `status`, and `type` SHALL be supplied when the embedding row is inserted (not by a trigger on the vector table, which the engine forbids); `status` SHALL thereafter be kept in sync with the owning memory's `status` by a trigger on the base `memory` table. The repository SHALL expose a scoped kNN query over an arbitrary query vector that filters by partition key plus requested `status` and optional `type`, so that a scoped search scans only its own partition and its own structured slice. Vectors SHALL be retained across `status` transitions so that `superseded` history remains semantically recoverable when explicitly requested. `archived` rows MAY still have retained vectors while present, but because the post-model-change backfill intentionally targets non-archived rows, archived rows are outside the semantic-search guarantee and SHALL be treated as lexical-only for correctness. Vectors SHALL be physically removed only when the owning memory row is physically purged through an existing journaled escape hatch.

**A partition key SHALL NOT be changed by `UPDATE`.** The vector engine rejects `UPDATE memory_vec SET partition_key = …` outright, so any migration or maintenance path that must move a row between partitions SHALL DELETE the row and re-INSERT it carrying the identical embedding blob. The re-inserted blob SHALL be byte-identical to the original; re-embedding is NOT an acceptable substitute, because it makes the operation's correctness depend on a background worker completing after the transaction commits.

**A wrongly-partitioned row is undetectable by the existing repair path, so it SHALL be pinned by test rather than left to a health check.** `findMissingEmbeddings` is an anti-join that detects the ABSENCE of a `memory_vec` row, not a wrong partition key: a stale-partition row is present, so it is never queued for re-embedding, the doctor's embeddings backlog reads zero, the dense branch filters it out forever, and the lexical branch keeps returning the memory — so search returns results and nothing anywhere reports a fault. Any change that moves rows between partitions SHALL assert both that the retiring partition is empty AND that the destination partition is non-empty, and SHALL exercise recall end-to-end through the search entry point rather than through the kNN repository method.

#### Scenario: Scoped kNN returns only in-scope active neighbors

- **WHEN** the search vector branch runs a kNN for a query vector in `scope = 'project'`, `project_id = 'A'`
- **THEN** it SHALL return only memories with that partition key and `status = 'active'`, and SHALL NOT return memories from a different `project_id` or with a non-`active` status

#### Scenario: Scoped kNN can target superseded history explicitly

- **GIVEN** a `superseded` memory in scope whose vector has been retained and re-embedded with the current model
- **WHEN** the search vector branch runs a kNN with `status = 'superseded'`
- **THEN** that memory MAY be returned by the dense branch
- **AND** rows with `status = 'active'` or a different scope SHALL NOT leak into that result set unless they also match the requested filter

#### Scenario: Scoped kNN isolates by type when a type is requested

- **GIVEN** two `active` in-scope memories with different `type` values (e.g. one `preference`, one `decision`)
- **WHEN** the search vector branch runs a kNN with a requested `type`
- **THEN** it SHALL return only the memory whose `type` matches the request, and the other `type` SHALL NOT leak into the result set

#### Scenario: A superseded memory keeps its vector

- **GIVEN** an `active` memory M with an embedding
- **WHEN** M is superseded (its `status` flips to `superseded`)
- **THEN** the `memory_vec` row for M SHALL be retained with its `status` updated to `superseded` by the base-table trigger, so M remains semantically recoverable and is excluded from the default `active` search

#### Scenario: Partitioning shards across scopes but not within one

- **GIVEN** a corpus spread across many project scopes
- **WHEN** a scoped search runs a kNN
- **THEN** it SHALL scan only its own partition (cost proportional to in-partition rows, not total corpus); within a single large partition the kNN remains a brute-force scan whose latency grows with the in-partition row count

#### Scenario: A partition key cannot be updated in place

- **WHEN** a statement attempts `UPDATE memory_vec SET partition_key = ?`
- **THEN** the engine SHALL reject it, and the only conforming way to move the row SHALL be DELETE followed by re-INSERT of the identical blob

#### Scenario: Repointed vectors remain reachable by the dense branch

- **GIVEN** a migration that has moved every vector out of a retiring partition
- **WHEN** the retiring partition is counted and a semantic search is run in the destination scope through the search entry point
- **THEN** the retiring partition SHALL hold zero rows, the total `memory_vec` row count SHALL be greater than zero, and a repointed memory SHALL be returned by the dense branch alongside a control memory native to the destination scope

## REMOVED Requirements

### Requirement: Memories MUST be scoped to either global or a project

**Reason**: The requirement's name and body are the retired model. `global` no longer exists as a scope, so "either global or a project" describes a choice the system no longer offers, and its second scenario ("Saving a global memory with a project id") tests an argument that has been deleted from `memory.save`. Replaced in full by "Every memory MUST belong to exactly one project", which states the closed-scope model the change establishes.

**Migration**: Every memory row previously carrying `scope = 'global'` and `project_id IS NULL` is repointed by schema migration to a newly created default project, preserving the total row count. `memory.save`'s `scope` argument is removed; the destination is determined by the connection URL the operator configured. The `scope` column itself is retained in this release, written as the constant `'project'`, so a rolled-back previous image can still execute its queries; dropping it is a separate change.
