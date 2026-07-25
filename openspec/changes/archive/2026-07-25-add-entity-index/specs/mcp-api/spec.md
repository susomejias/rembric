## ADDED Requirements

### Requirement: `memory.search` MUST accept an `entity` filter, and no new tool SHALL be added

Exact-address retrieval SHALL be reachable as an `entity` argument on `memory.search` rather than as a new tool. The MCP tool surface is already at the practical ceiling for reliable tool selection — 23 tools with four clusters the model cannot easily distinguish — so a capability expressible as an argument SHALL be an argument.

When `entity` is supplied, the response SHALL be the complete scoped set of memories linked to that entity, chronologically ordered, and the response SHALL indicate that the entity path was taken rather than the ranked text-query path, so the agent does not read the absence of relevance scores as a defect. `entity` MAY be combined with the existing `status` and `type` filters; combining it with a text `query` SHALL narrow within the entity's memories rather than fusing two result sets.

#### Scenario: Retrieving everything known about a file

- **WHEN** `memory.search` is called with an `entity` naming a file path present in scope
- **THEN** every in-scope memory linked to that path SHALL be returned in chronological order

#### Scenario: The response distinguishes the entity path

- **WHEN** `memory.search` returns results for an `entity` lookup
- **THEN** the response SHALL indicate that exact-address retrieval was used

#### Scenario: An unknown entity returns empty rather than falling back to text search

- **WHEN** `memory.search` is called with an `entity` that exists nowhere in scope
- **THEN** the response SHALL be empty and SHALL NOT silently degrade into a text query over that string

#### Scenario: Entity plus text query narrows rather than fuses

- **WHEN** `memory.search` is called with both an `entity` and a text `query`
- **THEN** the result SHALL be the entity's memories ranked by the text query, not a fusion of two independent result sets

### Requirement: Memory-returning reads MUST expose the entities a memory is about

An agent that receives a memory SHALL be able to see what it is about, so it can pivot to related knowledge without guessing a query. Memory-returning reads SHALL include an `entities[]` field listing the entities linked to each memory, each with its kind. The list SHALL be bounded per memory so a content-heavy row cannot inflate a response, and the bound SHALL be visible when it is hit.

#### Scenario: A returned memory carries its entities

- **GIVEN** a memory linked to two file paths and a package name
- **WHEN** it is returned by `memory.get` or `memory.search`
- **THEN** its `entities[]` SHALL list those three with their kinds

#### Scenario: The entity list is bounded

- **GIVEN** a memory linked to more entities than the per-memory bound
- **WHEN** it is returned
- **THEN** the list SHALL be truncated to the bound and the truncation SHALL be indicated

### Requirement: Save candidates MUST identify the entity channel as their source

Save-time candidates already carry a source identifying which retrieval channel proposed them. Candidates proposed by entity overlap SHALL carry a source distinguishing them from lexical and dense candidates, so the agent judging a pair understands why the server thought they were related — an entity-sourced candidate means "these concern the same thing", which is a materially different claim from "these read similarly".

#### Scenario: An entity-sourced candidate is labelled

- **WHEN** a candidate is surfaced because it shares a rare entity with the saved memory
- **THEN** its source SHALL identify the entity channel, and the shared entity SHALL be reported
