# memory-entities Specification

## Purpose

Deterministic, no-LLM extraction of syntactically-recognisable entities (file paths, git refs, URLs, error codes, ticket ids) from a memory's `title + content`, indexed and scoped like memories themselves. The index backs exact-address retrieval (an index lookup, not a ranked query), a save-time conflict-detection channel for entity overlap, and a precise seed for context relevance — while staying out of the existing hybrid-search RRF fusion, which it must not affect.

## Requirements

### Requirement: Entity extraction MUST be deterministic and MUST NOT use a model

Entities SHALL be extracted from a memory's `title + content` by a pure function with no inference, no model, and no network call, so extraction is reproducible, auditable, and free. Only entity kinds recognisable from syntax with high confidence SHALL be extracted: file paths, git refs, package names, error codes and code identifiers, URLs, and ticket-style identifiers.

Extraction SHALL run inside the same transaction as the save, and an extraction failure SHALL NOT fail the save — the memory is the primary record and the index is derived. Prose that merely resembles an entity SHALL NOT be extracted: precision is preferred over recall, because a false entity link pollutes exact-address lookup, which is the mechanism's whole value.

#### Scenario: A file path in memory content is extracted

- **WHEN** a memory is saved whose content references `apps/server/src/db/migrate.ts`
- **THEN** an entity of kind `path` SHALL be linked to that memory

#### Scenario: Extraction is reproducible

- **WHEN** the extractor runs twice over identical text
- **THEN** it SHALL produce an identical set of entities

#### Scenario: An extraction failure does not fail the save

- **WHEN** extraction throws for a given memory
- **THEN** the memory SHALL still be saved and the failure SHALL be logged

#### Scenario: Ordinary prose does not produce entities

- **WHEN** a memory is saved whose content is prose containing no path, ref, package, identifier, URL, or ticket id
- **THEN** no entity SHALL be linked to it

### Requirement: Entities MUST be scoped, and entity lookup MUST respect scope isolation

Each entity SHALL be scoped exactly as memories are — global, or belonging to one project. Retrieval by entity SHALL return only memories the caller's scope permits, and SHALL never return a memory from a different project. An entity string appearing in two projects SHALL NOT join their memories.

#### Scenario: The same path in two projects does not join them

- **GIVEN** memories in project A and project B both referencing `src/index.ts`
- **WHEN** entity retrieval is performed on a connection scoped to project A
- **THEN** only project A's memories SHALL be returned

#### Scenario: Global entities are available to a project-scoped read when requested

- **GIVEN** a global memory referencing a package name and a project memory referencing the same package
- **WHEN** entity retrieval is performed in the project scope including globals
- **THEN** both SHALL be returned, each labelled with its scope

### Requirement: Retrieval by entity MUST bypass ranking

Exact-address retrieval is not a relevance problem: the caller has supplied an exact key. Retrieval by entity SHALL be an index lookup returning every linked memory in the requested scope, ordered chronologically, with no fusion, no rank window, no similarity threshold, and no post-fusion boost. It SHALL therefore be complete within the scope — a memory linked to the entity SHALL NOT be omitted because of a ranking cutoff.

This is deliberately the opposite of the text-query branch, and it exists because the identifier query class is the one where ranked retrieval performs worst.

#### Scenario: Every linked memory is returned

- **GIVEN** twenty memories in scope linked to one entity
- **WHEN** entity retrieval is performed for that entity with a sufficient limit
- **THEN** all twenty SHALL be returned

#### Scenario: A rare identifier is found regardless of embedding distance

- **GIVEN** a memory whose only connection to a query is a rare identifier, and which no text query surfaces in its top results
- **WHEN** entity retrieval is performed on that identifier
- **THEN** the memory SHALL be returned

#### Scenario: Entity retrieval applies no relevance boost

- **WHEN** entity retrieval returns results
- **THEN** the ordering SHALL be chronological and SHALL NOT be modified by confirmation count, recency, or type

### Requirement: Entity overlap MUST be a save-time conflict-detection channel

Two memories can contradict each other while sharing almost no vocabulary and sitting far apart in embedding space — a fix and its reversal, stated in different words about the same file. Lexical and dense similarity both miss that case. A newly saved memory sharing a sufficiently rare entity with an existing active memory in the same scope SHALL therefore be eligible as a save-time candidate, alongside the existing lexical and dense channels.

Candidates surfaced this way SHALL carry a source identifying the entity channel, so the agent judging them knows why they were proposed. Common entities SHALL NOT generate candidates: an entity linked to a large share of the scope's memories carries no signal and would flood the per-save candidate budget.

#### Scenario: A contradiction about the same file is surfaced

- **GIVEN** an active memory stating one approach for a specific file, and a new memory stating an incompatible approach for the same file, with little shared vocabulary
- **WHEN** the new memory is saved
- **THEN** the existing memory SHALL be surfaced as a candidate with the entity channel as its source

#### Scenario: A very common entity generates no candidates

- **GIVEN** an entity linked to a large share of the scope's active memories
- **WHEN** a new memory linked to that entity is saved
- **THEN** that entity alone SHALL NOT generate candidates

#### Scenario: The per-save candidate budget is respected

- **WHEN** the entity channel would surface more candidates than the per-save maximum permits
- **THEN** the total number of candidates SHALL still respect that maximum

### Requirement: The entity index MUST be rebuildable and its drift MUST be observable

Both entity tables are derived data, reconstructible from the append-only memory rows alone — the same class as the search and vector indexes. A rebuild path SHALL exist that recomputes them from `memory`, and the diagnostics surface SHALL report a link-count delta so drift caused by a missed backfill, a failed extraction, or a future table-rebuild migration is visible rather than silent.

#### Scenario: The index is rebuilt from primary data

- **GIVEN** an entity index that has been emptied
- **WHEN** the rebuild runs
- **THEN** the index SHALL be reconstructed and entity retrieval SHALL return the same results as before it was emptied

#### Scenario: Drift is reported

- **GIVEN** memories whose entities were never extracted
- **WHEN** diagnostics are read
- **THEN** a non-zero delta SHALL be reported as a warning

### Requirement: Entity retrieval MUST NOT be added as a fusion stream in this change

Published evidence indicates that adding a graph stream to a BM25-plus-vector fusion **reduced** Recall@5, NDCG@10 and MRR against BM25 alone in its own author's benchmark. Entity retrieval SHALL therefore remain a separate exact-address mechanism and SHALL NOT contribute a ranked list to the text-query branch's Reciprocal Rank Fusion. Introducing such a stream SHALL require a measured improvement on the evaluation harness, recorded in a dedicated change.

#### Scenario: The text-query branch is unchanged

- **WHEN** `memory.search` is called with a text query and no entity filter
- **THEN** the fused result SHALL be identical to what the same query returns without the entity index present
