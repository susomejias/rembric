## ADDED Requirements

### Requirement: Memories MUST carry a non-empty title

Every memory row SHALL have a `title` column that is a human-readable label of 1–100 characters. The column SHALL be `NOT NULL` and SHALL carry a database-level `CHECK(length(title) BETWEEN 1 AND 100)`, so the database itself rejects an empty, missing, or over-long title regardless of the calling layer. The service layer SHALL also validate the 1–100 bound before insert.

`memory.save` SHALL require a `title` argument (no implicit default at the tool boundary). Non-curated internal write paths (`memory.capture_passive`, the dev seed) SHALL supply a title produced by a deterministic, LLM-free `deriveTitle(content)` helper that takes the first content line, strips leading Markdown emphasis/heading markers, truncates to 100 characters, and falls back to the first 100 characters of `content` when the first line is empty — guaranteeing a non-empty result because `content` is itself non-empty.

Existing rows SHALL be backfilled with a title derived from their `content` by the same rule during the schema migration, so no memory ever lacks a title.

#### Scenario: Saving a memory without a title is rejected

- **WHEN** `memory.save` is called without a `title`, or with a `title` that is empty or longer than 100 characters
- **THEN** the call SHALL be rejected with code `invalid_input` and SHALL NOT insert any row

#### Scenario: A title that bypasses validation is rejected by the database

- **WHEN** any code path attempts to insert a memory row with a `NULL`, empty, or over-100-character `title`
- **THEN** the SQLite `NOT NULL` / `CHECK` constraint SHALL reject the insert

#### Scenario: Passive capture derives a title

- **WHEN** `memory.capture_passive` saves a captured learning that carries no explicit title
- **THEN** the saved row SHALL have a non-empty `title` produced by `deriveTitle(content)`

#### Scenario: Existing rows are backfilled

- **WHEN** the schema migration that introduces the `title` column runs against a database with pre-existing memories
- **THEN** every pre-existing row SHALL end with a non-empty `title` derived from its `content`

#### Scenario: Reads expose the title

- **WHEN** any memory-returning read (`memory.get`, `memory.search`, `memory.timeline`, `memory.context`, and `memory.save` candidates) returns a memory
- **THEN** the returned shape SHALL include that memory's `title`

### Requirement: Memory title MUST participate in both retrieval branches

A memory's `title` SHALL contribute to `memory.search` on BOTH branches of hybrid retrieval, not merely as a display label:

- **Lexical**: the FTS5 index (`memory_fts`) SHALL cover `title` in addition to `content` and `tags`, kept in sync by the same INSERT/UPDATE/DELETE triggers. The interactive search lexical branch SHALL rank with a BM25 column weighting that boosts `title` above `content` (`wTitle > wContent`), so a query matching a memory's title ranks it higher. Save-time candidate detection MAY keep default (unweighted) BM25 ranking so its calibrated thresholds are unaffected.
- **Dense**: the per-memory embedding SHALL be computed from the concatenation of `title` and `content` (not `content` alone), so the curated headline shapes the stored vector and the query-vs-memory cosine similarity.

#### Scenario: A title-only term ranks the memory lexically

- **GIVEN** an `active` memory whose curated `title` contains a term that does NOT appear in its `content`
- **WHEN** `memory.search` is called with a query containing that term
- **THEN** the memory SHALL appear in the fused results via the FTS branch, surfaced by the title match

#### Scenario: Title shapes the embedding

- **WHEN** a memory's embedding is computed (inline at save or by the background drain)
- **THEN** the embedded text SHALL be the memory's `title` concatenated with its `content`, not `content` alone

## MODIFIED Requirements

### Requirement: Embeddings MUST be computed in-process by a model loaded at boot

The embedding model (gte-multilingual-base, ONNX q8, 768 dims, `pooling: 'cls'`, `normalize: true`) SHALL be loaded during bootstrap, BEFORE the HTTP listener starts. A model that cannot load SHALL abort the boot with a non-zero exit (fail fast — a listening server always has a warm model; there is no cold state). Each newly saved memory SHALL receive its embedding inline before candidate detection runs (ms-scale). The text embedded for each memory SHALL be the concatenation of its `title` and `content` (the same `embeddingInput` recipe at save time and in the background drain), so the curated headline contributes to the stored vector. An inference failure SHALL NOT fail the save: detection degrades to FTS5 for that save and the background drain retries the row. There SHALL be no external embedding endpoint, no API key, and no off switch. The same in-process embedder SHALL also embed the incoming query text on the `memory.search` text-query branch, so the stored vectors back BOTH save-time candidate detection AND interactive search. The `memory_vec` row written for each memory SHALL carry a scope-derived partition key and the memory's `status` and `type`, supplied at insert time, so that search kNN can filter scope, status, and type inside the index.

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

### Requirement: Stale vectors MUST be re-embedded after a model change

The data dir SHALL record the embedding identity, comprising BOTH the compiled-in model id AND the embedding-input recipe version (`EMBEDDING_INPUT_VERSION`). When the server starts and the recorded identity differs from the compiled-in identity on EITHER axis — a model change (including the upgrade from the external-provider era) OR a change to the text recipe fed to the embedder (e.g. moving from `content` to `title + content`) — all non-archived memories SHALL be re-embedded in batches by the in-process embedder, resumable across restarts, with progress logged. "Non-archived" explicitly includes `superseded` memories, whose vectors are retained for semantic recoverability — so the re-embed set covers every vector the index keeps semantically guaranteed searchable, and the searchable set SHALL NOT mix embedding spaces once the backfill completes. `archived` rows remain text-searchable while present, but are outside the semantic-search guarantee because they are intentionally excluded from the post-change backfill. Candidate detection AND search SHALL keep working (FTS5 + whatever vectors are fresh) throughout the backfill.

#### Scenario: First boot after the upgrade

- **GIVEN** a data dir whose `memory_vec` rows were produced by a different model
- **WHEN** the server starts
- **THEN** the backfill SHALL begin in the background, the server SHALL serve requests immediately, and after completion every active AND superseded memory SHALL have a vector produced by the compiled-in model

#### Scenario: First boot after an embedding-input recipe change

- **GIVEN** a data dir whose `memory_vec` rows were produced by the same model but an older `EMBEDDING_INPUT_VERSION` (e.g. content-only)
- **WHEN** the server starts after the recipe changes to `title + content`
- **THEN** the recorded identity SHALL mismatch on the input-version axis, the stale vectors SHALL be wiped, and the background drain SHALL re-embed every non-archived row from `title + content`

#### Scenario: Backfill interrupted by a restart

- **WHEN** the process restarts mid-backfill
- **THEN** the backfill SHALL resume from the remaining unembedded rows, not start over

#### Scenario: A superseded memory is re-embedded after a model change

- **GIVEN** a `superseded` memory whose retained vector was produced by the previous model
- **WHEN** the post-model-change backfill runs
- **THEN** that memory's vector SHALL be regenerated by the compiled-in model, so a future search over retained history does not compare across incompatible embedding spaces

### Requirement: Memories MUST be append-only

The system SHALL never delete a memory row and SHALL never mutate the `content` or `title` of an existing memory, EXCEPT through the operator-only physical-purge escape hatch defined in "Memories MAY be physically purged when archived and disconnected". Lifecycle changes are otherwise expressed exclusively by transitioning the `status` column among `active`, `superseded`, and `archived`, and by setting the `replaces` JSON array on newly inserted memories. Because `title` is fixed at insert and never updated, a memory's title can never drift away from the immutable `content` it labels.

#### Scenario: Code path attempts to physically delete a memory

- **WHEN** any service or migration emits a `DELETE FROM memory` statement from any file OTHER than `apps/server/src/services/memory.ts`
- **THEN** a CI invariant test SHALL fail and the build SHALL be rejected

#### Scenario: Code path attempts to mutate `content`

- **WHEN** any service emits an `UPDATE memory SET content = ?` statement
- **THEN** a CI invariant test SHALL fail and the build SHALL be rejected

#### Scenario: Code path attempts to mutate `title`

- **WHEN** any service emits an `UPDATE memory SET title = ?` statement
- **THEN** a CI invariant test SHALL fail and the build SHALL be rejected
