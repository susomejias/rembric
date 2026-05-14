## MODIFIED Requirements

### Requirement: Memory retrieval MUST expose history

`memory.get(id)` SHALL return the memory along with its full ancestry: the chain of predecessors via `replaces`, the count of confirmations against the current head, AND the set of judged relations involving the memory (sourced from `memory_relations`).

#### Scenario: Retrieving a merged memory

- **WHEN** `memory.get('M')` is called and M was formed by merging A and B
- **THEN** the response SHALL include the content of M, the predecessor ids `['A','B']`, the predecessors' content snapshots, the current confirmation count for M, and a `relations` array containing the `supersedes` entries for A and B

#### Scenario: Retrieving a memory with a pending judgment

- **GIVEN** memory N was just saved and a candidate-detection step inserted a `memory_relations` row with `status = 'pending'` referencing memory M
- **WHEN** `memory.get('N')` is called
- **THEN** the response's `relations` array SHALL include `{ kind: 'pending_conflict', targetId: 'M', judgmentId, status: 'pending' }`

## ADDED Requirements

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

After a `memory.save` inserts the new row, the server SHALL run a candidate-detection step over rows in the same `(scope, project_id)`, excluding the newly inserted row and any rows already linked to it via `replaces`. The detection SHALL combine FTS5 lexical neighbors (always) and vec kNN neighbors (when `EMBEDDING_ENABLED = true`), apply the configured similarity thresholds, deduplicate by target id, and return up to `CANDIDATES_PER_SAVE_MAX` (default 5) candidates ordered by max(vec, fts) score descending.

For each candidate surfaced, a `memory_relations` row SHALL be inserted with `status = 'pending'`, `source_id = <new row>`, `target_id = <candidate>`, and a generated `judgment_id`.

#### Scenario: A save finds two strong candidates

- **GIVEN** EMBEDDING_ENABLED is true, two existing active memories M1 and M2 in the same scope each exceed `CANDIDATE_VEC_THRESHOLD = 0.85` against the just-saved row N
- **WHEN** `memory.save({...})` returns
- **THEN** the response SHALL include `candidates: [{ judgmentId, targetId: M1, snippet, similarity, source }, { judgmentId, targetId: M2, ... }]` and `judgmentRequired: true`; two `memory_relations` rows SHALL exist with `status = 'pending'`

#### Scenario: A save finds zero candidates

- **WHEN** no existing memory exceeds the thresholds
- **THEN** the response SHALL include `candidates: []` and `judgmentRequired: false`; no `memory_relations` rows SHALL be inserted

#### Scenario: Embeddings are disabled

- **GIVEN** `EMBEDDING_ENABLED = false`
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
