## ADDED Requirements

### Requirement: A change of embedding model MUST rebuild the vector index at the new dimension without touching memory rows

The vector index's column dimension SHALL equal the dimension of the compiled-in embedding model. A change that replaces the model with one of a different dimension SHALL ship a migration that recreates `memory_vec` at the new dimension, and that migration SHALL NOT copy the old vectors: a vector of another model is not comparable to a query vector of the new one at any dimension, so carrying it forward would return wrong neighbours rather than none.

The migration SHALL leave `memory`, `memory_fts` and every other table untouched. `memory_vec` holds derived data only, so emptying it does not violate the append-only memory invariant; the rows it described SHALL be re-embedded by the existing identity reset and background drain, and until a row is re-embedded it SHALL remain findable through the lexical branch.

The compiled-in model SHALL be `hindsight-ai/hs-embed-1` at a pinned revision: 384 dimensions, mean pooling, normalized output, and the same input recipe for queries and memories, with no query or document prefix.

#### Scenario: Upgrading across the model change keeps every memory

- **GIVEN** a data directory written by a server on the previous embedding model
- **WHEN** the server on the new model starts against it
- **THEN** every `memory` row SHALL be present and unchanged, `memory_vec` SHALL exist at the new dimension, and no vector of the previous model SHALL remain

#### Scenario: Search works while the re-embed drains

- **GIVEN** an upgraded data directory whose vectors are still being recomputed
- **WHEN** `memory.search` is called with a text query that lexically matches a memory not yet re-embedded
- **THEN** that memory SHALL be returned through the lexical branch

#### Scenario: A vector of the wrong dimension is refused

- **WHEN** the embedder returns a vector whose length is not the compiled-in dimension
- **THEN** the embedding SHALL fail with an error naming both lengths and SHALL NOT be written to `memory_vec`

### Requirement: Every constant calibrated against embedding similarity MUST be re-derived when the embedding model changes

A cosine similarity is a quantity of the model that produced it: two models place the same pair of texts at different distances, so a threshold tuned on one is uncalibrated on another. A change of embedding model SHALL therefore re-derive, from a committed evaluation run on the new model, every constant that reads a cosine similarity or a quantity built from one, and SHALL NOT carry any of them forward by default.

Those constants are the save-time dense admission threshold, the save-time confidence band boundaries, and every enabled relevance gate, whose level takes the dense branch's cosine as one of its two components. A constant whose re-derived value equals its old one SHALL still be accompanied by the run that shows it.

The same change SHALL regenerate the retrieval evaluation baselines against the new model, and its committed floors SHALL NOT be lower than the previous model's on any gated metric at any committed `k`.

#### Scenario: A carried-forward threshold is rejected

- **WHEN** a change replaces the embedding model and leaves a cosine-calibrated constant at its previous value without a committed run on the new model
- **THEN** the change SHALL be rejected

#### Scenario: The new model does not lower retrieval quality

- **WHEN** the retrieval evaluation runs on the new embedding model
- **THEN** every gated metric SHALL be at or above the floor committed for the previous model at the same `k`

## MODIFIED Requirements

### Requirement: Embeddings MUST be computed in-process by a model loaded on first use

The embedding model (`hindsight-ai/hs-embed-1`, its int8 ONNX export, 384 dims, `pooling: 'mean'`, `normalize: true`, the same input recipe for queries and memories with no prefix) SHALL be loaded in-process on first use — the first `memory.save`, `memory.search` query, or background drain tick that needs a vector — and SHALL NOT be loaded during bootstrap. The server SHALL therefore bind its HTTP listener without loading the model; an idle server that needs no embedding holds no model. The embedder SHALL be loaded at most once per process: every load site SHALL share one memoized load. A model that cannot load SHALL NOT abort the server: the load failure SHALL surface as the documented degradation (the operation that needed the vector proceeds lexically and the drain retries the load on a later tick), it SHALL be logged, and `memory.doctor` SHALL continue to surface the reset-owed warning while the identity is unsettled. The embedding-identity check (`ensureVectorModel`) SHALL run exactly once per process, immediately after the first load resolves and BEFORE that embedder serves its first vector, so a recorded-identity mismatch wipes the stale vectors and settles the marker before any new vector is written. Each newly saved memory SHALL receive its embedding inline before candidate detection runs (ms-scale). The text embedded for each memory SHALL be the concatenation of its `title` and `content` (the same `embeddingInput` recipe at save time and in the background drain), so the curated headline contributes to the stored vector. An inference failure SHALL NOT fail the save: detection degrades to FTS5 for that save and the background drain retries the row. There SHALL be no external embedding endpoint, no API key, and no off switch. The same in-process embedder SHALL also embed the incoming query text on the `memory.search` text-query branch, so the stored vectors back BOTH save-time candidate detection AND interactive search. The `memory_vec` row written for each memory SHALL carry a scope-derived partition key and the memory's `status` and `type`, **derived from the memory row's current values in the same `INSERT` statement**, so that search kNN can filter scope, status, and type inside the index without a window where a concurrent status change (e.g. a topic-key supersede racing an in-flight embed) could leave the vector row's status stale.

#### Scenario: Saving a memory

- **WHEN** `memory.save(…)` is called
- **THEN** the row's embedding SHALL be computed inline from its `title + content` and persisted into `memory_vec` (together with its partition key, `status`, and `type`) before candidate detection runs, so vec-sourced candidates can surface in the same save's response

#### Scenario: The model cannot load on first use

- **WHEN** the embedder first loads the embedding model and it fails to load (missing, corrupt, or incompatible artifacts)
- **THEN** the server SHALL keep serving, the affected operation SHALL proceed lexically, the failure SHALL be logged, and a later drain tick SHALL retry the load — the boot SHALL NOT abort

#### Scenario: An idle boot does not load the model

- **WHEN** the process starts and no request and no drained row has needed an embedding
- **THEN** the embedding model SHALL NOT have been loaded, and the HTTP listener SHALL already be serving

#### Scenario: The identity check runs once at the first load

- **GIVEN** a data dir whose recorded embedding identity does not match the compiled-in identity, with vectors present
- **WHEN** the embedder first loads
- **THEN** the stale vectors SHALL be wiped and the marker settled BEFORE the embedder returns its first vector, so the searchable set does not mix embedding spaces
- **AND** the check SHALL run no more than once per process for that embedder

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
