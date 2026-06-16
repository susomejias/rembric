## ADDED Requirements

### Requirement: Memory search MUST implement standard hybrid retrieval on the text-query branch

When `memory.search` is called with a non-empty text `query`, the system SHALL implement the standard hybrid-search pattern used by mainstream search engines: run an independent **lexical retriever** (FTS5/BM25 ranked ids) and **dense retriever** (vector k-nearest-neighbor ranked ids), then combine their ranked lists using Reciprocal Rank Fusion (RRF): `score(id) = Σ 1/(rank_constant + rank_branch(id))` over the branches in which the id appears, ordered by descending score, returning the top `limit` results. Each child retriever SHALL over-fetch into a bounded **rank window** (at least `limit + offset`, clamped to a fixed ceiling set strictly above the maximum `limit` so an unbounded `offset` cannot force a near-full partition scan) so that fusion is not artificially recall-capped. When `memory.search` is called WITHOUT a text `query`, the system SHALL use the existing chronological listing path unchanged (ordered by `created_at`, with exact `limit`/`offset`). The dense branch SHALL NOT apply a similarity threshold — fusion orders results, it does not filter them. The text query SHALL be sanitized before it is passed to the FTS5 `MATCH` so that an arbitrary natural-language query cannot raise an FTS5 syntax error or be reinterpreted as an FTS5 query expression. The sanitizer SHALL keep whole Unicode word tokens (it SHALL NOT split a token at a non-ASCII character nor drop tokens that are entirely non-ASCII — e.g. accented or CJK text), SHALL strip FTS5 metacharacters and balance quotes, and SHALL neutralize FTS5 bareword operators (`AND`, `OR`, `NOT`, `NEAR`) so a phrase like "coffee OR tea" matches literal terms rather than being parsed as a boolean expression. (The FTS tokenizer folds diacritics, so a sanitized accented or ASCII-folded token matches accented stored content either way; the binding requirement is to preserve whole tokens and neutralize operators, not to special-case accents.) A failure of either branch SHALL degrade gracefully to the other branch rather than failing the whole search. Filters SHALL have explicit guarantees: `status` and `type` apply to BOTH branches; `tag` is exact on the lexical branch and post-filters dense candidates inside the bounded rank window (so no wrong-tag rows are returned, but dense+tag recall is bounded by the rank window rather than globally complete). Result rows SHALL carry the same shape as today (including the `relations` array and the `last_seen_at` touch).

#### Scenario: A cross-lingual query surfaces a memory stored in another language

- **GIVEN** an `active` memory whose content is in English (e.g. "user prefers black coffee, no sugar")
- **WHEN** `memory.search` is called with a Spanish query expressing the same meaning (e.g. "¿cómo toma el café?") in the same scope
- **THEN** the FTS branch SHALL NOT raise a syntax error on the punctuation/accents, and the English memory SHALL appear in the fused results via the vector branch even though no query terms overlap lexically

#### Scenario: An exact proper-noun query ranks the lexical match

- **GIVEN** an `active` memory containing a proper noun or identifier (e.g. "Sobrino de Botín")
- **WHEN** `memory.search` is called with a query containing that exact token (e.g. "Botín")
- **THEN** the lexically-matching memory SHALL be ranked highly in the fused results via the FTS branch

#### Scenario: A memory consensually ranked by both branches wins

- **GIVEN** two `active` memories where one is surfaced by BOTH the vector and FTS branches and another by only one branch
- **WHEN** the two ranked lists are fused with RRF
- **THEN** the memory present in both branches SHALL receive the higher fused score, all else equal

#### Scenario: A memory without an embedding is still found lexically

- **GIVEN** an `active` memory whose embedding has not yet been computed (inline embed failed, drain lag, or mid-backfill)
- **WHEN** `memory.search` is called with a text query that lexically matches it
- **THEN** the memory SHALL appear in the fused results via the FTS branch, and search correctness SHALL NOT depend on full embedding coverage

#### Scenario: Archived text-query search degrades to lexical only

- **GIVEN** an `archived` memory still present in storage
- **WHEN** `memory.search` is called with `status = 'archived'` and a text query that lexically matches it
- **THEN** the lexical branch SHALL still be allowed to return it
- **AND** the search SHALL NOT require a vector hit for correctness because archived rows are outside the semantic-search guarantee after model changes

#### Scenario: The no-query listing branch keeps exact pagination

- **WHEN** `memory.search` is called WITHOUT a text query and with `limit` and `offset`
- **THEN** the results SHALL be the chronological listing with exact SQL `LIMIT`/`OFFSET` semantics, identical to prior behavior

#### Scenario: BREAKING — offset is best-effort on the hybrid branch

- **WHEN** `memory.search` is called WITH a text query and a non-zero `offset`
- **THEN** `offset` SHALL be applied best-effort over the in-memory fused result pool (which is over-fetched beyond `limit + offset`) rather than as a SQL `OFFSET`; an `offset` beyond the fused pool SHALL yield an empty page rather than an error, and this divergence from the listing branch SHALL be documented as a contract change

### Requirement: The vector index MUST mirror the memory lifecycle and support scoped kNN over an arbitrary query vector

`memory_vec` is a derived index, not primary data: an embedding is a deterministic function of `memory.content` (which append-only preserves) and is recomputable at any time. The index therefore is NOT bound by the append-only invariant of the `memory` table; it MAY be updated to track the memory lifecycle, mirroring the existing `memory_fts` trigger-driven sync. `memory_vec` SHALL carry a scope-derived partition key (the `project_id` for project scope, a fixed sentinel that cannot collide with a real `project_id` for global scope), a `status`, and a `type`. The partition key, `status`, and `type` SHALL be supplied when the embedding row is inserted (not by a trigger on the vector table, which the engine forbids); `status` SHALL thereafter be kept in sync with the owning memory's `status` by a trigger on the base `memory` table. The repository SHALL expose a scoped kNN query over an arbitrary query vector that filters by partition key plus requested `status` and optional `type`, so that a scoped search scans only its own partition and its own structured slice. Vectors SHALL be retained across `status` transitions so that `superseded` history remains semantically recoverable when explicitly requested. `archived` rows MAY still have retained vectors while present, but because the post-model-change backfill intentionally targets non-archived rows, archived rows are outside the semantic-search guarantee and SHALL be treated as lexical-only for correctness. Vectors SHALL be physically removed only when the owning memory row is physically purged through an existing journaled escape hatch.

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

## MODIFIED Requirements

### Requirement: Embeddings MUST be computed in-process by a model loaded at boot

The embedding model (gte-multilingual-base, ONNX q8, 768 dims, `pooling: 'cls'`, `normalize: true`) SHALL be loaded during bootstrap, BEFORE the HTTP listener starts. A model that cannot load SHALL abort the boot with a non-zero exit (fail fast — a listening server always has a warm model; there is no cold state). Each newly saved memory SHALL receive its embedding inline before candidate detection runs (ms-scale). An inference failure SHALL NOT fail the save: detection degrades to FTS5 for that save and the background drain retries the row. There SHALL be no external embedding endpoint, no API key, and no off switch. The same in-process embedder SHALL also embed the incoming query text on the `memory.search` text-query branch, so the stored vectors back BOTH save-time candidate detection AND interactive search. The `memory_vec` row written for each memory SHALL carry a scope-derived partition key and the memory's `status` and `type`, supplied at insert time, so that search kNN can filter scope, status, and type inside the index.

#### Scenario: Saving a memory

- **WHEN** `memory.save(…)` is called
- **THEN** the row's embedding SHALL be computed inline and persisted into `memory_vec` (together with its partition key, `status`, and `type`) before candidate detection runs, so vec-sourced candidates can surface in the same save's response

#### Scenario: The model cannot load at boot

- **WHEN** the server starts and the embedding model fails to load (missing, corrupt, or incompatible artifacts)
- **THEN** the boot SHALL fail with a non-zero exit before the HTTP listener starts — the server SHALL NOT run in a degraded no-embeddings mode

#### Scenario: A single inference fails at save time

- **WHEN** `memory.save(…)` is called and the inline embedding throws
- **THEN** the save SHALL succeed, candidate detection SHALL operate on FTS5 only for that save, the failure SHALL be logged, and the drain SHALL retry the row

#### Scenario: A search query is embedded on demand

- **WHEN** `memory.search` is called with a non-empty text query
- **THEN** the in-process embedder SHALL embed the query text and the vector branch SHALL run a scoped kNN against `memory_vec`; no external embedding call SHALL be made

### Requirement: Stale vectors MUST be re-embedded after a model change

The data dir SHALL record the embedding model identity. When the server starts and the recorded identity differs from the compiled-in model (including the upgrade from the external-provider era), all non-archived memories SHALL be re-embedded in batches by the in-process embedder, resumable across restarts, with progress logged. "Non-archived" explicitly includes `superseded` memories, whose vectors are retained for semantic recoverability — so the re-embed set covers every vector the index keeps semantically guaranteed searchable, and the searchable set SHALL NOT mix embedding spaces once the backfill completes. `archived` rows remain text-searchable while present, but are outside the semantic-search guarantee because they are intentionally excluded from the post-change backfill. Candidate detection AND search SHALL keep working (FTS5 + whatever vectors are fresh) throughout the backfill.

#### Scenario: First boot after the upgrade

- **GIVEN** a data dir whose `memory_vec` rows were produced by a different model
- **WHEN** the server starts
- **THEN** the backfill SHALL begin in the background, the server SHALL serve requests immediately, and after completion every active AND superseded memory SHALL have a vector produced by the compiled-in model

#### Scenario: Backfill interrupted by a restart

- **WHEN** the process restarts mid-backfill
- **THEN** the backfill SHALL resume from the remaining unembedded rows, not start over

#### Scenario: A superseded memory is re-embedded after a model change

- **GIVEN** a `superseded` memory whose retained vector was produced by the previous model
- **WHEN** the post-model-change backfill runs
- **THEN** that memory's vector SHALL be regenerated by the compiled-in model, so a future search over retained history does not compare across incompatible embedding spaces
