## MODIFIED Requirements

### Requirement: Embeddings MUST be computed in-process by a model loaded at boot

The embedding model (gte-multilingual-base, ONNX q8, 768 dims, `pooling: 'cls'`, `normalize: true`) SHALL be loaded during bootstrap, BEFORE the HTTP listener starts. A model that cannot load SHALL abort the boot with a non-zero exit (fail fast — a listening server always has a warm model; there is no cold state). Each newly saved memory SHALL receive its embedding inline before candidate detection runs (ms-scale). The text embedded for each memory SHALL be the concatenation of its `title` and `content` (the same `embeddingInput` recipe at save time and in the background drain), so the curated headline contributes to the stored vector. An inference failure SHALL NOT fail the save: detection degrades to FTS5 for that save and the background drain retries the row. There SHALL be no external embedding endpoint, no API key, and no off switch. The same in-process embedder SHALL also embed the incoming query text on the `memory.search` text-query branch, so the stored vectors back BOTH save-time candidate detection AND interactive search. The `memory_vec` row written for each memory SHALL carry a scope-derived partition key and the memory's `status` and `type`, **derived from the memory row's current values in the same `INSERT` statement**, so that search kNN can filter scope, status, and type inside the index without a window where a concurrent status change (e.g. a topic-key supersede racing an in-flight embed) could leave the vector row's status stale.

#### Scenario: Saving a memory

- **WHEN** `memory.save(…)` is called
- **THEN** the row's embedding SHALL be computed inline from its `title + content` and persisted into `memory_vec` (together with its partition key, `status`, and `type`) before candidate detection runs, so vec-sourced candidates can surface in the same save's response

#### Scenario: The model cannot load at boot

- **WHEN** the server starts and the embedding model fails to load (missing, corrupt, or incompatible artifacts)
- **THEN** the boot SHALL fail with a non-zero exit before the HTTP listener starts — the server SHALL NOT run in a degraded no-embeddings mode

#### Scenario: A single inference fails at save time

- **WHEN** `memory.save(…)` is called and the inline embedding throws
- **THEN** the save SHALL succeed, candidate detection SHALL operate on FTS5 only for that save, the failure SHALL be logged, and the drain SHALL retry the row

#### Scenario: A search query is embedded on demand

- **WHEN** `memory.search` is called with a non-empty text query
- **THEN** the in-process embedder SHALL embed the query text and the vector branch SHALL run a scoped kNN against `memory_vec`; no external embedding call SHALL be made

#### Scenario: A status change racing an in-flight embed does not leave a stale vector

- **GIVEN** a memory row is saved and its inline embedding inference is in flight
- **WHEN** a concurrent write (e.g. a `topic_key` supersede) changes that row's `status` before the embedding inference completes
- **THEN** the `memory_vec` row inserted once inference completes SHALL carry the row's current `status` at insert time, not the `status` captured when embedding started
- **AND** `memory.search` SHALL NOT return that row for a status filter it no longer matches, regardless of which retrieval branch (lexical or dense) surfaced its id
