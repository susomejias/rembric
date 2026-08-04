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

### Requirement: Memory search MUST respect scope isolation

`memory.search` SHALL return only memories matching the requested scope, which is always exactly one project. No argument widens it, and under no circumstances SHALL results from a different `project_id` be returned.

#### Scenario: Searching within a project returns only that project plus globals when requested

The title predates this change: there is nothing left to add to the project half, which is all that survives.

- **WHEN** `memory.search` is called with `project_id = 'A'`
- **THEN** the response SHALL include memories with `project_id = 'A'` only, and no argument SHALL admit another project's row

#### Scenario: Searching globals never returns project memories

The title predates this change: the wider search it names is no longer expressible, which is what this scenario now pins.

- **WHEN** a caller attempts to search anything other than the connection's resolved project
- **THEN** no such request SHALL be expressible: `memory.search` accepts no scope argument, and scope resolution yields a project on every branch or refuses the call

### Requirement: `memory.save` MUST surface candidate conflicts at save-time

After a `memory.save` inserts the new row, the server SHALL run a candidate-detection step over rows in the same `(scope, project_id)`, excluding the newly inserted row and any rows already linked to it via `replaces`. The detection SHALL combine FTS5 lexical neighbors (always), vec kNN neighbors (when the just-saved row has an embedding), and entity-overlap neighbors (see `memory-entities`'s save-time conflict-detection requirement, which owns the gate: an entity common enough to occupy the whole per-save budget contributes nothing, while one linked to fewer memories than that budget holds is not gated at all), apply the internal similarity thresholds (compile-time constants, calibrated for the compiled-in model — not environment-configurable), deduplicate by target id, rank the merged list by the precedence the `memory-entities` capability defines (entity-sourced candidates lead, then the reported `similarity` descending), and return up to `CANDIDATES_PER_SAVE_MAX` (default 5) candidates.

Each detection channel SHALL scan a bounded pool before that ranking is applied, sized by a single named constant (`CANDIDATE_POOL_SIZE`, see "Retrieval and lifecycle constants MUST be named and bounded in one place"). The pool bound is therefore UPSTREAM of the cap: the merged, ranked list is itself bounded, and no scope-wide count of related memories is available at save time. Consequently the count the response reports (see the `mcp-api` capability, "`memory.save` MUST report how many candidates its detection produced") SHALL be specified as a LOWER BOUND on how many memories in scope resemble the saved row, and SHALL NOT be specified as a total. A count that happens to be exact — which it is whenever the scope holds fewer comparable rows than the pool bound — SHALL NOT be relied upon as exact, because that exactness is a property of corpus size and not of the count.

The lexical pass SHALL build its FTS5 `MATCH` expression with the SAME Unicode-aware builder used by interactive `memory.search` (see the `mcp-api` hybrid-retrieval contract): it SHALL keep whole Unicode word tokens and SHALL NOT split a token at a non-ASCII character nor drop tokens that are entirely non-ASCII (accented or CJK text), and it SHALL apply a bounded term cap so a long save body cannot build an unbounded `MATCH` expression. Consequently, save-time candidate detection SHALL NOT silently degrade to vector-only for non-ASCII content: a non-ASCII memory body SHALL produce a non-empty `MATCH` expression and SHALL be eligible to surface `source: 'fts'` candidates. The lexical pass SHALL still skip only when the builder yields no usable tokens at all.

The detection SHALL additionally exclude any target id that was already judged `relation = 'not_conflict'` against the new memory's `replaces` ancestry. That ancestry is the TRANSITIVE closure of `replaces[]`, bounded by its own constant — see "Dismissal suppression MUST bound its ancestry walk with its own named constant", which owns the depth, the order and the bound. It is NOT the array's own elements: `replaces[]` alone is one hop, and one hop loses a dismissal made two or more saves back on the same topic, which is the case this suppression exists for. This suppresses the re-surfacing of a pair the agent already dismissed as a false positive on an earlier save of the same evolving topic. Because `memory_relations` has no topic column and each save mints a fresh `source_id`, the dismissal SHALL be carried forward by walking that ancestry, NOT by the new row's own id (which no prior relation references). Only `not_conflict` SHALL be suppressed; other judged relations (notably `conflicts_with`) SHALL continue to surface so an unresolved contradiction re-confronts the agent on the next save.

For each candidate surfaced, a `memory_relations` row SHALL be inserted with `status = 'pending'`, `source_id = <new row>`, `target_id = <candidate>`, and a generated `judgment_id`.

Candidates that were detected but fall outside `CANDIDATES_PER_SAVE_MAX` SHALL NOT be recorded: no `memory_relations` row, no `judgment_id`, no journal entry. This is not an information loss, and the requirement states why so that a future change does not "fix" it by recording them.

A candidate pair is DERIVED: its two endpoints and its `similarity` are a function of `memory.title` and `memory.content` — immutable under "Memories MUST be append-only" — together with recipes pinned in the shipped image behind version markers (the FTS5 tokenizer, the entity extractor behind `EXTRACTOR_VERSION`, and the embedding identity behind `EMBEDDING_INPUT_VERSION` and the pinned model constants, per "Embeddings MUST be computed in-process by a model loaded at boot" and "Stale vectors MUST be re-embedded after a model change"). It therefore satisfies the same test the `persistence` capability applies to its own derived tables (`memory_fts`, `memory_vec`, `memory_replaces`, and the entity tables, which that capability requires to be "declared derived, never primary"): dropping it loses nothing that cannot be recomputed from rows still in the database. An agent's VERDICT on a pair is the opposite — SOURCE data, recomputable by nothing — which is precisely what earns a row.

Dropping a candidate therefore discards a prompt, not a fact, and the prompt is re-derivable at any time from the surviving inputs via `memory.search` over the memory's own text (lexical and dense channels) and `memory.search` with an `entity` filter (entity channel).

That re-derivability SHALL be specified as re-derivability and NOT as reproducibility. A re-derived candidate set is the CURRENT one, not the save-time one: rows created since the save are included, `superseded` and `archived` rows are absent, and a change to the pinned embedding recipe changes the vectors. Nor is it identical in shape: `memory.search` is a fused ranked read that returns memories, not pairs carrying `judgment_id`s, so recording a verdict on a re-derived pair is `memory.compare`. No requirement SHALL claim that a dropped candidate can be reconstructed as it stood at save time.

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
- **THEN** the response SHALL include the top 5 by the ranking precedence above; the remaining 7 SHALL NOT have `memory_relations` rows inserted and SHALL NOT surface to the agent; and the response SHALL report the detected count so the truncation is not silent

#### Scenario: The number of pending rows equals the number of surfaced candidates

- **GIVEN** a save whose detection ranked more candidates than `CANDIDATES_PER_SAVE_MAX`
- **WHEN** the save completes
- **THEN** the number of `memory_relations` rows inserted for that save SHALL equal the length of the returned `candidates[]`, and SHALL NOT equal the reported detected count

#### Scenario: The detected count is taken before the cap, not after

- **GIVEN** a save whose detection ranked 12 candidates with `CANDIDATES_PER_SAVE_MAX = 5`
- **WHEN** the save completes
- **THEN** the reported detected count SHALL be 12, and the returned `candidates[]` SHALL hold 5 entries which SHALL be the first 5 of that same ranked order

#### Scenario: A topic-key save's superseded predecessor is neither surfaced nor counted

- **GIVEN** a save carrying a `topic_key` that supersedes a previously-active row P in the same slot
- **WHEN** candidate detection runs for the new row
- **THEN** P SHALL NOT appear in `candidates[]` and SHALL NOT be included in the reported detected count, because P is in the new row's `replaces[]` and is therefore excluded from every channel's pool

#### Scenario: Candidate detection respects scope

- **GIVEN** the just-saved row is in scope `project:'A'`
- **WHEN** candidate detection runs
- **THEN** every candidate's `project_id` SHALL match `'A'`; rows in any other project SHALL NOT be considered, regardless of similarity

#### Scenario: The detected count respects scope

- **GIVEN** memories in another project that would resemble the just-saved row
- **WHEN** candidate detection runs for a row in scope `project:'A'`
- **THEN** the reported detected count SHALL count only pairs whose target lies in `project:'A'`

#### Scenario: A previously dismissed `not_conflict` pair is not re-surfaced

- **GIVEN** an earlier memory M0 (with `topic_key = 'arch/auth'`) for which the agent judged a candidate target X as `relation = 'not_conflict'`
- **AND** a new save N for the same topic whose `replaces[]` includes M0 (so M0 is N's predecessor)
- **WHEN** `memory.save` runs candidate detection for N and X would otherwise exceed the similarity thresholds
- **THEN** X SHALL NOT appear in N's `candidates[]` and NO new pending `memory_relations` row SHALL be inserted for the `(N, X)` pair

#### Scenario: A previously judged `conflicts_with` pair still surfaces

- **GIVEN** an earlier memory M0 for which the agent judged a candidate target Y as `relation = 'conflicts_with'`
- **AND** a new save N for the same topic whose `replaces[]` includes M0
- **WHEN** `memory.save` runs candidate detection for N and Y exceeds the similarity thresholds
- **THEN** Y SHALL still appear in N's `candidates[]` with a fresh pending `memory_relations` row — only `not_conflict` dismissals are suppressed, not unresolved conflicts

#### Scenario: Suppression keys on the ancestry, not the new id

- **GIVEN** a target X dismissed as `not_conflict` only against M0, and a new save N whose `replaces[]` does NOT include M0 (an unrelated save)
- **WHEN** `memory.save` runs candidate detection for N and X exceeds the thresholds
- **THEN** X SHALL still surface for N — the suppression follows the `replaces` ancestry, so a save that does not inherit M0's chain is unaffected by M0's prior dismissal

#### Scenario: A non-ASCII save participates in the lexical pass

- **GIVEN** an existing active memory whose content is non-ASCII (e.g. CJK or accented text) in scope `project:'A'`, and a just-saved row N in the same scope whose content lexically overlaps it
- **WHEN** `memory.save` runs candidate detection
- **THEN** the FTS5 `MATCH` expression built from N's content SHALL be non-empty (it SHALL NOT degrade to skipping the lexical pass), and the overlapping memory SHALL be eligible to surface as a `source: 'fts'` candidate when it clears the FTS threshold

#### Scenario: A dropped candidate is re-derivable but not reproducible

- **GIVEN** a save whose detection ranked more candidates than the cap, and a later session that wants the pairs which were not surfaced
- **WHEN** the agent re-derives them by calling `memory.search` with the memory's own text and with an `entity` filter
- **THEN** the pairs SHALL be reachable, and the re-derived set SHALL reflect the CURRENT corpus — including memories saved after the original save and excluding rows now `superseded` or `archived` — rather than the set that existed at save time

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
- **WHEN** `MemoryService.archive('X', S)` is called with `S` being project `B`
- **THEN** the call SHALL raise `memory_not_found`
- **AND** `X.status` SHALL be unchanged

#### Scenario: Archiving a non-active memory conflicts

- **GIVEN** a memory `M` whose `status` is `superseded` or `archived`
- **WHEN** `MemoryService.archive('M', scope-of-M)` is called
- **THEN** the call SHALL raise `conflict`
- **AND** `M.status` SHALL be unchanged

## REMOVED Requirements

### Requirement: Memories MUST be scoped to either global or a project

**Reason**: The requirement's name and body are the retired model. `global` no longer exists as a scope, so "either global or a project" describes a choice the system no longer offers, and its second scenario ("Saving a global memory with a project id") tests an argument that has been deleted from `memory.save`. Replaced in full by "Every memory MUST belong to exactly one project", which states the closed-scope model the change establishes.

**Migration**: Every memory row previously carrying `scope = 'global'` and `project_id IS NULL` is repointed by schema migration to a newly created default project, preserving the total row count. `memory.save`'s `scope` argument is removed; the destination is determined by the connection URL the operator configured. The `scope` column itself is retained in this release, written as the constant `'project'`, so a rolled-back previous image can still execute its queries; dropping it is a separate change.
