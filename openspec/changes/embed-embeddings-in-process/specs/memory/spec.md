# memory — delta for embed-embeddings-in-process

## ADDED Requirements

### Requirement: Embeddings MUST be computed in-process and asynchronously

Each newly saved memory SHALL be enqueued for embedding computation by the in-process embedder (gte-multilingual-base, ONNX q8, 768 dims, `pooling: 'cls'`, `normalize: true`). Embedding computation SHALL NOT block the `memory.save` call. The model SHALL be lazy-loaded on first use; while the model is loading (or vectors are not yet computed) candidate detection degrades to FTS5-only with no error. There SHALL be no external embedding endpoint, no API key, and no off switch.

#### Scenario: Saving a memory

- **WHEN** `memory.save(…)` is called
- **THEN** the call SHALL return successfully without waiting for embedding inference, and the in-process embedder SHALL compute and persist the embedding into `memory_vec` asynchronously

#### Scenario: Saving before the model finished loading

- **WHEN** `memory.save(…)` is called while the lazy model load is still in progress
- **THEN** the save SHALL succeed, candidate detection SHALL operate on FTS5 only for that save, and the embedding SHALL be computed once the model is ready

### Requirement: Stale vectors MUST be re-embedded after a model change

The data dir SHALL record the embedding model identity. When the server starts and the recorded identity differs from the compiled-in model (including the upgrade from the external-provider era), all non-archived memories SHALL be re-embedded in batches by the in-process embedder, resumable across restarts, with progress logged. Candidate detection SHALL keep working (FTS5 + whatever vectors are fresh) throughout the backfill.

#### Scenario: First boot after the upgrade

- **GIVEN** a data dir whose `memory_vec` rows were produced by a different model
- **WHEN** the server starts
- **THEN** the backfill SHALL begin in the background, the server SHALL serve requests immediately, and after completion every active memory SHALL have a vector produced by the compiled-in model

#### Scenario: Backfill interrupted by a restart

- **WHEN** the process restarts mid-backfill
- **THEN** the backfill SHALL resume from the remaining unembedded rows, not start over

## MODIFIED Requirements

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

#### Scenario: The just-saved row has no embedding yet

- **GIVEN** the embedding for the just-saved row has not been computed (model loading or worker lag)
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

## REMOVED Requirements

### Requirement: Embeddings MUST be optional and asynchronous

**Reason**: Embeddings are core architecture (decision 2026-06-05): in-process, always on, no external provider. The optional/external model is replaced by the two ADDED requirements above.
**Migration**: No operator action. `EMBEDDING_ENABLED`, `EMBEDDING_PROVIDER`, `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_EMBEDDING_MODEL`, `CANDIDATE_VEC_THRESHOLD` are ignored with the standard stale-env boot warning. Existing vectors are re-embedded automatically by the backfill.
