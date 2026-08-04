## MODIFIED Requirements

### Requirement: Entities MUST be scoped, and entity lookup MUST respect scope isolation

Each entity SHALL be scoped exactly as memories are — belonging to exactly one project. The identity of an entity is `(scope, project_id, kind, value)`, enforced by a unique index, so the same literal string in two projects is two distinct entities and no join between them exists to be exploited. Retrieval by entity SHALL return only memories the caller's scope permits, and SHALL never return a memory from a different project. An entity string appearing in two projects SHALL NOT join their memories.

**No widening exists.** The previous allowance for a project-scoped read to also admit global entities is retired with the global scope itself: there is no second scope to widen into, and the widening argument it mirrored (`include_global`) is removed from the published tool contract. An entity lookup returns the caller's project and nothing else, on every branch.

**The entity tables SHALL be repointed or rebuilt by the migration that retires the global scope**, and the choice is bounded by the identity index. Because `memory_entity_links` holds foreign-key references into `memory_entities`, and because the identity index is UNIQUE over `(scope, project_id, kind, value)`, a repointing collides in general. Two conforming options:

1. **Rebuild** — the supported operator path already documented for restores: delete the entity-state recipe marker so the server wipes and re-derives the entity tables from `memory`. Preferred, because it needs no new SQL and its failure mode (a temporary backlog) is visible in `memory.doctor`.
2. **Repoint in place** — conforming ONLY because the destination project is newly created by the same migration (see the `projects` capability), so its only entity rows are the repointed ones and a collision is impossible by construction. This option SHALL NOT be taken if the destination is ever an existing project.

Either way the derived state SHALL drain to zero after the migration: the operator-visible entity backlog SHALL reach `0` and the scan cursor SHALL cover every `memory` row. A rebuild that stalls part-way leaves entities keyed to a project that no longer addresses them, with no error and no counter that moves.

#### Scenario: The same path in two projects does not join them

- **GIVEN** memories in project A and project B both referencing `src/index.ts`
- **WHEN** entity retrieval is performed on a connection scoped to project A
- **THEN** only project A's memories SHALL be returned

#### Scenario: Global entities are available to a project-scoped read when requested

- **GIVEN** a memory in the default project referencing `src/shared.ts` and a memory in project A referencing the same path
- **WHEN** entity retrieval is performed on a connection scoped to project A, with any argument
- **THEN** only project A's memory SHALL be returned, and no argument SHALL admit the default project's
- **AND** the scenario title predates this change: the widening it names is retired, and this scenario now pins that it stays retired

#### Scenario: Widening to globals does not widen to other projects

- **GIVEN** a third project's memory referencing the same path
- **WHEN** entity retrieval is performed on a connection scoped to project A, with any argument
- **THEN** the third project's memory SHALL NOT be returned
- **AND** no argument on any branch SHALL admit a second project's entity rows

#### Scenario: The entity tables drain to zero after the migration

- **GIVEN** a populated database whose entity rows were repointed or rebuilt by the retiring migration
- **WHEN** the derived-state drain completes after boot
- **THEN** the operator-visible entity backlog SHALL be `0`, the scan cursor SHALL cover every `memory` row, and an entity lookup in the default project SHALL return its repointed memories

### Requirement: Retrieval by entity MUST bypass ranking

Exact-address retrieval is not a relevance problem: the caller has supplied an exact key. Retrieval by entity SHALL be an index lookup returning the linked memories in the requested scope, ordered chronologically, with no fusion, no rank window, no similarity threshold, and no post-fusion boost. It SHALL be complete within the scope up to an explicit, generous bound — a memory linked to the entity SHALL NOT be omitted because of a RANKING cutoff, and an omitted `limit` SHALL NOT be interpreted as the ranked branches' small default page. The bound SHALL be the same over-fetch ceiling those branches already use, so "complete" means "every linked memory, up to a stated cap far above any realistic per-entity link count" rather than "everything, unbounded" — an unbounded read of a pathologically common entity would return the whole corpus in one response. A `limit` the caller states explicitly SHALL still bound the page, exactly as on the ranked path (see `mcp-api`); completeness is what an OMITTED limit means, not an override of a stated one.

The same selection filters the ranked path accepts (`status`, `type`, `tag`, `topic_key`) SHALL apply here with the same meaning. Filtering is not ranking: narrowing to what the caller asked for does not reintroduce relevance ordering, whereas silently ignoring a filter returns rows the caller explicitly excluded. There is no scope-widening filter, on this branch or any other.

`status` composes only if the index covers every status, so **archived memories SHALL be indexed**. Excluding them made `status: 'archived'` a filter that could never match anything, and made every extractor recipe change drop the archived corpus's links permanently — a row archived before the bump is re-scanned by nothing, ever. Extraction is a pure synchronous function of `title + content`, so the only cost is a longer first drain on a corpus with many archived rows, paid once. The drain's queue and the operator-visible backlog count SHALL agree on that population, or the backlog never reaches zero.

Chronological ordering SHALL be a TOTAL order. `created_at` has millisecond resolution and a batch capture writes several memories inside one millisecond, so it alone is a partial order; the result is paged by the caller, and an unstable tie makes page 2 repeat or skip a row page 1 already showed. The ordering SHALL therefore carry a deterministic tiebreaker that is itself chronological.

A text `query` supplied alongside an entity SHALL narrow, not rank: the entity's memories are filtered by case-insensitive substring containment over `title + content`, and the fetch SHALL cover more than the requested page so a match older than one page is not window-dropped. Substring containment, not the lexical branch, is deliberate — routing the narrowing through FTS5 would reintroduce exactly the tokenizer imprecision this index exists to remove.

This is deliberately the opposite of the text-query branch, and it exists because the identifier query class is the one where ranked retrieval performs worst.

#### Scenario: Every linked memory is returned

- **GIVEN** twenty memories in scope linked to one entity
- **WHEN** entity retrieval is performed for that entity with no `limit`
- **THEN** all twenty SHALL be returned — the omitted `limit` means the generous bound, not the ranked default page

#### Scenario: An explicit limit still bounds the page

- **GIVEN** the same twenty linked memories
- **WHEN** entity retrieval is performed with `limit: 5`
- **THEN** five SHALL be returned; a stated limit is honoured rather than overridden by completeness

#### Scenario: An archived memory is reachable by entity

- **GIVEN** a memory linked to an entity and subsequently archived
- **WHEN** entity retrieval is performed for that entity with `status: 'archived'`
- **THEN** that memory SHALL be returned

#### Scenario: Same-millisecond rows page without repeating

- **GIVEN** four in-scope memories linked to one entity and all carrying the same `created_at`
- **WHEN** two consecutive pages of two are read
- **THEN** the four rows SHALL be partitioned across the pages, with none repeated and none dropped

#### Scenario: Narrowing by query is substring containment, not a second ranked pass

- **GIVEN** an entity linked to more memories than one page holds, one of them the oldest and the only one containing the query text
- **WHEN** entity retrieval is performed with that query
- **THEN** that memory SHALL be returned, matched case-insensitively, and the result SHALL NOT be ordered by any relevance score

#### Scenario: A rare identifier is found regardless of embedding distance

- **GIVEN** a memory whose only connection to a query is a rare identifier, and which no text query surfaces in its top results
- **WHEN** entity retrieval is performed on that identifier
- **THEN** the memory SHALL be returned

#### Scenario: Entity retrieval applies no relevance boost

- **WHEN** entity retrieval returns results
- **THEN** the ordering SHALL be chronological and SHALL NOT be modified by confirmation count, recency, or type
