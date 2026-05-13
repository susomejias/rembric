## ADDED Requirements

### Requirement: Memories MUST be append-only

The system SHALL never delete a memory row and SHALL never mutate the `content` of an existing memory. Lifecycle changes are expressed exclusively by transitioning the `status` column among `active`, `superseded`, and `archived`, and by setting the `replaces` JSON array on newly inserted memories.

#### Scenario: Code path attempts to delete a memory
- **WHEN** any service or migration emits a `DELETE FROM memory` statement
- **THEN** a CI invariant test SHALL fail and the build SHALL be rejected

#### Scenario: Code path attempts to mutate memory content
- **WHEN** any service emits an `UPDATE memory SET content = …` statement
- **THEN** a CI invariant test SHALL fail and the build SHALL be rejected

#### Scenario: A memory becomes obsolete and is replaced
- **WHEN** a ceremony decides that an existing memory is replaced by a new one
- **THEN** the new memory SHALL be inserted with `replaces` containing the predecessor's id, and the predecessor's `status` SHALL transition from `active` to `superseded` within the same transaction

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

`memory.get(id)` SHALL return the memory along with its full ancestry: the chain of predecessors via `replaces`, and the count of confirmations against the current head.

#### Scenario: Retrieving a merged memory
- **WHEN** `memory.get('M')` is called and M was formed by merging A and B
- **THEN** the response SHALL include the content of M, the predecessor ids `['A','B']`, the predecessors' content snapshots, and the current confirmation count for M

### Requirement: Embeddings MUST be optional and asynchronous

When `EMBEDDING_ENABLED = true`, each newly saved memory SHALL be enqueued for embedding computation by the worker. Embedding computation SHALL NOT block the `memory.save` call. When `EMBEDDING_ENABLED = false`, no embedding is computed and ceremony candidate detection SHALL fall back to FTS5-based similarity.

#### Scenario: Saving with embeddings enabled
- **WHEN** `memory.save(…)` is called and `EMBEDDING_ENABLED = true`
- **THEN** the call SHALL return successfully without waiting for the embedding endpoint, and a background worker SHALL compute and persist the embedding into `memory_vec`

#### Scenario: Saving with embeddings disabled
- **WHEN** `memory.save(…)` is called and `EMBEDDING_ENABLED = false`
- **THEN** the call SHALL return successfully, no embedding job SHALL be created, and `memory_vec` SHALL NOT receive a row for this memory
