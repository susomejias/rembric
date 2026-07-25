# memory Specification

## Purpose

Defines the core memory model: append-only semantics, scope isolation (global vs project), supersedes chains, confirmations, retrieval with history, and in-process always-on embeddings.

## Requirements

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

`memory.get(id)` SHALL return the memory along with its full ancestry: the chain of predecessors via `replaces`, the count of confirmations against the current head, AND the set of judged relations involving the memory (sourced from `memory_relations`).

#### Scenario: Retrieving a merged memory

- **WHEN** `memory.get('M')` is called and M was formed by merging A and B
- **THEN** the response SHALL include the content of M, the predecessor ids `['A','B']`, the predecessors' content snapshots, the current confirmation count for M, and a `relations` array containing the `supersedes` entries for A and B

#### Scenario: Retrieving a memory with a pending judgment

- **GIVEN** memory N was just saved and a candidate-detection step inserted a `memory_relations` row with `status = 'pending'` referencing memory M
- **WHEN** `memory.get('N')` is called
- **THEN** the response's `relations` array SHALL include `{ kind: 'pending_conflict', targetId: 'M', judgmentId, status: 'pending' }`

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

### Requirement: Memory search MUST implement standard hybrid retrieval on the text-query branch

When `memory.search` is called with a non-empty text `query`, the system SHALL implement the standard hybrid-search pattern used by mainstream search engines: run an independent **lexical retriever** (FTS5/BM25 ranked ids) and **dense retriever** (vector k-nearest-neighbor ranked ids), then combine their ranked lists using Reciprocal Rank Fusion (RRF): `score(id) = Σ 1/(rank_constant + rank_branch(id))` over the branches in which the id appears. Each child retriever SHALL over-fetch into a bounded **rank window** (at least `limit + offset`, clamped to a fixed ceiling set strictly above the maximum `limit` so an unbounded `offset` cannot force a near-full partition scan) so that fusion is not artificially recall-capped. When `memory.search` is called WITHOUT a text `query`, the system SHALL use the existing chronological listing path unchanged (ordered by `created_at`, with exact `limit`/`offset`). The dense branch SHALL NOT apply a similarity threshold — fusion orders results, it does not filter them. The text query SHALL be sanitized before it is passed to the FTS5 `MATCH` so that an arbitrary natural-language query cannot raise an FTS5 syntax error or be reinterpreted as an FTS5 query expression. The sanitizer SHALL keep whole Unicode word tokens (it SHALL NOT split a token at a non-ASCII character nor drop tokens that are entirely non-ASCII — e.g. accented or CJK text), SHALL strip FTS5 metacharacters and balance quotes, and SHALL neutralize FTS5 bareword operators (`AND`, `OR`, `NOT`, `NEAR`) so a phrase like "coffee OR tea" matches literal terms rather than being parsed as a boolean expression. (The FTS tokenizer folds diacritics, so a sanitized accented or ASCII-folded token matches accented stored content either way; the binding requirement is to preserve whole tokens and neutralize operators, not to special-case accents.) A failure of either branch SHALL degrade gracefully to the other branch rather than failing the whole search. Filters SHALL have explicit guarantees: `status` and `type` apply to BOTH branches; `tag` is exact on the lexical branch and post-filters dense candidates inside the bounded rank window (so no wrong-tag rows are returned, but dense+tag recall is bounded by the rank window rather than globally complete). Result rows SHALL carry the same shape as today (including the `relations` array and the `last_seen_at` touch).

After RRF produces the fused, ordered candidate pool for the over-fetched rank window, the system SHALL apply a bounded post-fusion multiplier before truncating to the top `limit` results: `finalScore(id) = rrfScore(id) * boost(id)`, where `boost(id)` is a compile-time-constant function of the candidate row's `confirmationCount`, time since `last_seen_at`, and `type`, clamped to a fixed range (approximately `[0.7, 1.4]`) so it can re-order candidates within the fused pool but SHALL NOT let a boosted weaker match outrank a strongly-fused one by more than that bound. This boost applies ONLY to the text-query (fused hybrid-search) branch; the no-query chronological listing path is UNCHANGED and continues to use exact chronological order with no boost applied. The boost multiplier SHALL NOT be exposed as a per-request tunable — it is a fixed constant, matching the existing style of `RANK_CONSTANT` and the rank-window ceiling.

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
- **AND** no post-fusion boost SHALL be applied (the boost only applies to the fused hybrid-search branch)

#### Scenario: BREAKING — offset is best-effort on the hybrid branch

- **WHEN** `memory.search` is called WITH a text query and a non-zero `offset`
- **THEN** `offset` SHALL be applied best-effort over the in-memory fused result pool (which is over-fetched beyond `limit + offset`) rather than as a SQL `OFFSET`; an `offset` beyond the fused pool SHALL yield an empty page rather than an error, and this divergence from the listing branch SHALL be documented as a contract change

#### Scenario: A heavily-confirmed fresh memory outranks a stale unconfirmed one within the fused pool

- **GIVEN** two `active` memories both present in the fused RRF pool with close raw RRF scores, one confirmed multiple times and recently seen, the other never confirmed and not seen in months
- **WHEN** `memory.search` applies the post-fusion boost
- **THEN** the confirmed, recently-seen memory SHALL rank at or above the other, but the reordering SHALL NOT move a memory absent from the fused pool into the returned results (the boost reorders the pool; it does not expand it)

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

### Requirement: Memory search MUST default to a bounded, retrieval-aligned result count

When `memory.search` is called WITHOUT an explicit `limit`, the system SHALL apply a default of `DEFAULT_SEARCH_LIMIT = 8`, expressed as a single named constant rather than a magic literal. The default SHALL apply identically to BOTH search modes — the hybrid text-query branch and the no-query chronological listing — because the limit-clamping path is shared. An explicit `limit` SHALL still be honored and clamped to `[1, 200]`; the default governs only the omitted case. The value 8 sits within the retrieval-engineering norm for the final result set fed to a model (a low single-digit-to-ten count, beyond which additional rows add noise rather than recall) and is chosen above a tighter 3-5 because no reranker is applied, so the fused ranking near the top is approximate. This default SHALL NOT change the over-fetch rank window, RRF fusion, the FTS branch, or the dense kNN branch; it changes only how many of the already-ranked results are returned when the caller does not specify.

#### Scenario: A text query with no explicit limit returns at most the default count

- **GIVEN** more than 8 active memories in scope match a non-empty text `query`
- **WHEN** `memory.search` is called with that `query` and no `limit`
- **THEN** at most `DEFAULT_SEARCH_LIMIT` (8) results SHALL be returned, ordered by the fused RRF ranking

#### Scenario: A no-query listing with no explicit limit returns at most the default count

- **GIVEN** more than 8 active memories in scope
- **WHEN** `memory.search` is called WITHOUT a text `query` and without `limit`
- **THEN** at most `DEFAULT_SEARCH_LIMIT` (8) results SHALL be returned, in the chronological listing order

#### Scenario: An explicit limit overrides the default in both directions

- **WHEN** `memory.search` is called with an explicit `limit` of 3, or of 50
- **THEN** the result count SHALL be governed by the explicit `limit` (clamped to `[1, 200]`), not by `DEFAULT_SEARCH_LIMIT`

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

After a `memory.save` inserts the new row, the server SHALL run a candidate-detection step over rows in the same `(scope, project_id)`, excluding the newly inserted row and any rows already linked to it via `replaces`. The detection SHALL combine FTS5 lexical neighbors (always) and vec kNN neighbors (when the just-saved row has an embedding), apply the internal similarity thresholds (compile-time constants, calibrated for the compiled-in model — not environment-configurable), deduplicate by target id, and return up to `CANDIDATES_PER_SAVE_MAX` (default 5) candidates ordered by max(vec, fts) score descending.

The lexical pass SHALL build its FTS5 `MATCH` expression with the SAME Unicode-aware builder used by interactive `memory.search` (see the `mcp-api` hybrid-retrieval contract): it SHALL keep whole Unicode word tokens and SHALL NOT split a token at a non-ASCII character nor drop tokens that are entirely non-ASCII (accented or CJK text), and it SHALL apply a bounded term cap so a long save body cannot build an unbounded `MATCH` expression. Consequently, save-time candidate detection SHALL NOT silently degrade to vector-only for non-ASCII content: a non-ASCII memory body SHALL produce a non-empty `MATCH` expression and SHALL be eligible to surface `source: 'fts'` candidates. The lexical pass SHALL still skip only when the builder yields no usable tokens at all.

The detection SHALL additionally exclude any target id that was already judged `relation = 'not_conflict'` against the new memory's `replaces` ancestry — i.e. against any of the predecessor ids in the new row's `replaces[]` (the chain the new save supersedes). This suppresses the re-surfacing of a pair the agent already dismissed as a false positive on an earlier save of the same evolving topic. Because `memory_relations` has no topic column and each save mints a fresh `source_id`, the dismissal SHALL be carried forward by walking the `replaces` chain, NOT by the new row's own id (which no prior relation references). Only `not_conflict` SHALL be suppressed; other judged relations (notably `conflicts_with`) SHALL continue to surface so an unresolved contradiction re-confronts the agent on the next save.

For each candidate surfaced, a `memory_relations` row SHALL be inserted with `status = 'pending'`, `source_id = <new row>`, `target_id = <candidate>`, and a generated `judgment_id`.

#### Scenario: A save finds two strong candidates

- **GIVEN** two existing active memories M1 and M2 in the same scope each exceed the internal vec threshold against the just-saved row N
- **WHEN** `memory.save({...})` returns
- **THEN** the response SHALL include `candidates: [{ judgmentId, targetId: M1, snippet, similarity, source }, { judgmentId, targetId: M2, ... }]` and `judgmentRequired: true`; two `memory_relations` rows SHALL exist with `status = 'pending'`

#### Scenario: A save finds zero candidates

- **WHEN** no existing memory exceeds the thresholds
- **THEN** the response SHALL include `candidates: []` and `judgmentRequired: false`; no `memory_relations` rows SHALL be inserted

#### Scenario: The just-saved row has no embedding

- **GIVEN** the inline embedding of the just-saved row failed (logged, drain will retry)
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

#### Scenario: A previously dismissed `not_conflict` pair is not re-surfaced

- **GIVEN** an earlier memory M0 (with `topic_key = 'arch/auth'`) for which the agent judged a candidate target X as `relation = 'not_conflict'`
- **AND** a new save N for the same topic whose `replaces[]` includes M0 (so M0 is N's predecessor)
- **WHEN** `memory.save` runs candidate detection for N and X would otherwise exceed the similarity thresholds
- **THEN** X SHALL NOT appear in N's `candidates[]` and NO new pending `memory_relations` row SHALL be inserted for the `(N, X)` pair

#### Scenario: A previously judged `conflicts_with` pair still surfaces

- **GIVEN** an earlier memory M0 for which the agent judged a candidate target Y as `relation = 'conflicts_with'`
- **AND** a new save N for the same topic whose `replaces[]` includes M0
- **WHEN** `memory.save` runs candidate detection for N and Y exceeds the similarity thresholds
- **THEN** Y SHALL still appear in N's `candidates[]` with a fresh pending `memory_relations` row — only `not_conflict` dismissals are suppressed, not unresolved conflicts

#### Scenario: Suppression keys on the ancestry, not the new id

- **GIVEN** a target X dismissed as `not_conflict` only against M0, and a new save N whose `replaces[]` does NOT include M0 (an unrelated save)
- **WHEN** `memory.save` runs candidate detection for N and X exceeds the thresholds
- **THEN** X SHALL still surface for N — the suppression follows the `replaces` ancestry, so a save that does not inherit M0's chain is unaffected by M0's prior dismissal

#### Scenario: A non-ASCII save participates in the lexical pass

- **GIVEN** an existing active memory whose content is non-ASCII (e.g. CJK or accented text) in scope `project:'A'`, and a just-saved row N in the same scope whose content lexically overlaps it
- **WHEN** `memory.save` runs candidate detection
- **THEN** the FTS5 `MATCH` expression built from N's content SHALL be non-empty (it SHALL NOT degrade to skipping the lexical pass), and the overlapping memory SHALL be eligible to surface as a `source: 'fts'` candidate when it clears the FTS threshold

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

### Requirement: An active memory MAY be archived at explicit user request

An in-scope `active` memory SHALL be archivable through `MemoryService.archive(id, scope)` as a reversible `status` flip to `archived`, exposed to the agent by the `memory.archive` MCP tool. This is the **no-successor** retirement path and is distinct from supersede: it SHALL NOT set a `replaces` link, SHALL NOT insert a `supersedes` `memory_relations` row, and SHALL NOT delete the row, drop its `memory_vec`/`memory_fts` shadow rows, or mutate `content`/`title`. It is therefore consistent with the append-only invariant, which already sanctions the `active → archived` transition.

Archiving SHALL be strictly scope-bounded: the service SHALL resolve the row via the same scope check as `memory.confirm`, and an id that is missing or belongs to a different `(scope, project_id)` SHALL raise `memory_not_found`. There is no cross-scope or cross-project archive path. Only `active` memories are eligible; archiving a `superseded` or `archived` memory SHALL raise `conflict`.

Every archive SHALL be journaled — in the SAME transaction as the `status` flip — as a `consolidation_ops` row with `op_type = 'agent_memory_archive'` and `affected_ids` carrying the archived memory id, so the retirement is attributable and reversible through the same journal the sweep uses. The archive SHALL be reversible: an `agent_memory_archive` op SHALL be undoable via `undoOp` exactly as a `decay` op is (the affected memory is flipped back to `active`, subject to the same `topic_key`-slot-occupied guard), so an operator can revert an agent's archive from the consolidation view. Because this journal row's sole purpose is to record the archive of its own subject, it SHALL NOT count as a purge-blocking reference for that memory (see the modified purge requirement below).

#### Scenario: Archiving an active memory retires it from active recall

- **GIVEN** an `active` memory `M` in scope `S`
- **WHEN** `MemoryService.archive('M', S)` is called
- **THEN** `M.status` SHALL become `archived`
- **AND** `M` SHALL no longer appear in a default (`status = 'active'`) `memory.search` or `memory.context` in scope `S`
- **AND** `M.content`, `M.title`, and `M.replaces` SHALL be unchanged, and no `memory_relations` row SHALL be inserted for the archive

#### Scenario: Archive is journaled and reversible

- **WHEN** `MemoryService.archive('M', S)` completes for an active memory `M`
- **THEN** a `consolidation_ops` row SHALL exist with `op_type = 'agent_memory_archive'` and `affected_ids` containing `M.id`
- **AND** calling `undoOp` on that op SHALL flip `M` back to `status = 'active'` and mark the op `reverted_at`

#### Scenario: Archiving a cross-scope id is not found

- **GIVEN** a memory `X` that exists only in project `A`
- **WHEN** `MemoryService.archive('X', S)` is called with `S` being global scope or project `B`
- **THEN** the call SHALL raise `memory_not_found`
- **AND** `X.status` SHALL be unchanged

#### Scenario: Archiving a non-active memory conflicts

- **GIVEN** a memory `M` whose `status` is `superseded` or `archived`
- **WHEN** `MemoryService.archive('M', scope-of-M)` is called
- **THEN** the call SHALL raise `conflict`
- **AND** `M.status` SHALL be unchanged

### Requirement: Memories MAY be physically purged when archived and disconnected

A row SHALL be physically deletable from the `memory` table ONLY through `MemoryService.purgeDisconnectedArchived({ adminBypass: true })` and ONLY when the row satisfies all of the following at the moment of deletion:

1. `status = 'archived'`.
2. No row exists in the derived `memory_replaces` table with this row's id as `predecessor_id`. (No supersession chain reaches this row.) `memory_replaces` is a reverse-edge index over `memory.replaces`, kept in sync by triggers — this condition is behaviorally identical to "no other row in `memory` has this row's id in its `replaces` JSON array," just checked against the indexed table instead of a full-table `json_each` scan.
3. No row in `consolidation_ops` **other than an `agent_memory_archive` op** references this row's id via its `affected_ids` JSON array. An `agent_memory_archive` op IS the journal of the archive that retired this very memory; it exists to record and (optionally) reverse that archive, so it SHALL NOT pin its own subject against a later operator purge. A reference from any OTHER op type (e.g. `decay`, `merge`, `supersede`) still blocks the purge.
4. No row in `consolidation_ops` references this row's id via its `created_id` column.
5. No row in `memory_relations` references this row's id via `source_id` or `target_id`.
6. No row in `confirmations` references this row's id via `memory_id`.

The method SHALL delete the matching rows from `memory_vec`, `memory_fts`, and `memory` inside a single SQLite transaction, in that order (drop derived data first, base data last, so derived-table syncs do not observe a half-deleted base row). The `memory_replaces_ad` trigger removes the deleted row's own entries from `memory_replaces` (both as predecessor and as successor) as part of the same `DELETE FROM memory` statement — no separate cleanup step is needed. The method SHALL write a `consolidation_ops` row with `op_type = 'archived_memory_purge'`, `affected_ids` carrying the deleted memory ids, and a static `reasoning` string, in the same transaction. Purging a memory whose only journal reference was its `agent_memory_archive` op renders that op's undo terminal (the row cannot be reconstructed), handled by the existing purged-referent path in `undoOp`.

Without `adminBypass: true`, the method SHALL throw `DomainError('forbidden', ...)` and SHALL NOT touch the database.

#### Scenario: A fully-disconnected archived memory is purged

- **GIVEN** memory `M` with `status='archived'`, not referenced by any other `memory.replaces`, any `consolidation_ops.affected_ids` (other than its own `agent_memory_archive` op) or `created_id`, any `memory_relations.source_id` or `target_id`, or any `confirmations.memory_id`
- **WHEN** `MemoryService.purgeDisconnectedArchived({ adminBypass: true })` is called
- **THEN** the row SHALL be removed from `memory`
- **AND** any matching row in `memory_vec` SHALL be removed
- **AND** any matching row in `memory_fts` SHALL be removed
- **AND** a row SHALL exist in `consolidation_ops` with `op_type='archived_memory_purge'` and `affected_ids` containing `M.id`
- **AND** the response SHALL include `M.id` in `deletedIds`

#### Scenario: An archived memory referenced only by its own agent_memory_archive op is still purgeable

- **GIVEN** memory `M` with `status='archived'` whose only `consolidation_ops.affected_ids` reference is the `agent_memory_archive` op that archived it, and no other blocking reference
- **WHEN** `MemoryService.purgeDisconnectedArchived({ adminBypass: true })` is called
- **THEN** `M` SHALL be removed from `memory` and `M.id` SHALL appear in `deletedIds`

#### Scenario: An archived memory referenced by a later replaces is preserved

- **GIVEN** memory `M` with `status='archived'` and memory `N` with `replaces` containing `M.id`
- **WHEN** `MemoryService.purgeDisconnectedArchived({ adminBypass: true })` is called
- **THEN** `M` SHALL remain in `memory` — the supersession chain reaches it
- **AND** `M.id` SHALL NOT appear in the response's `deletedIds`

#### Scenario: An archived memory referenced by a non-archive consolidation op is preserved

- **GIVEN** memory `M` with `status='archived'` and a `consolidation_ops` row whose `op_type` is NOT `agent_memory_archive` (e.g. `decay`) and whose `affected_ids` contains `M.id`
- **WHEN** `MemoryService.purgeDisconnectedArchived({ adminBypass: true })` is called
- **THEN** `M` SHALL remain in `memory` — the consolidation journal still references it
- **AND** the consolidation op SHALL remain reversible

#### Scenario: An archived memory referenced by a memory_relations row is preserved

- **GIVEN** memory `M` with `status='archived'` and a `memory_relations` row whose `source_id` or `target_id` equals `M.id`
- **WHEN** `MemoryService.purgeDisconnectedArchived({ adminBypass: true })` is called
- **THEN** `M` SHALL remain in `memory`

#### Scenario: An archived memory with a surviving confirmation is preserved

- **GIVEN** memory `M` with `status='archived'` and at least one `confirmations` row whose `memory_id = M.id`
- **WHEN** `MemoryService.purgeDisconnectedArchived({ adminBypass: true })` is called
- **THEN** `M` SHALL remain in `memory` — confirmation history is audit-relevant

#### Scenario: An active or superseded memory is never purged

- **GIVEN** memory `M` with `status IN ('active', 'superseded')`, even if all other "disconnected" conditions hold
- **WHEN** `MemoryService.purgeDisconnectedArchived({ adminBypass: true })` is called
- **THEN** `M` SHALL remain in `memory` — only archived rows are eligible

#### Scenario: A non-admin caller is rejected before any read

- **WHEN** `MemoryService.purgeDisconnectedArchived({})` or `MemoryService.purgeDisconnectedArchived({ adminBypass: false })` is called
- **THEN** the method SHALL throw `DomainError('forbidden', ...)`
- **AND** SHALL NOT issue any SQL statement

### Requirement: The archived-memory purge journal is permanent

`consolidation_ops` rows written by `purgeDisconnectedArchived` SHALL NOT themselves be subject to deletion. The journal preserves the audit trail of WHICH memory ids existed and WHEN they were removed, even after the memory rows and their embeddings are gone.

#### Scenario: An archived-memory purge journal row survives later purges

- **GIVEN** `purgeDisconnectedArchived` has run and produced a `consolidation_ops` row referencing 43 deleted memory ids
- **WHEN** a subsequent `purgeDisconnectedArchived` runs on a different set of memory ids
- **THEN** the original `consolidation_ops` row SHALL still exist and its `affected_ids` SHALL still list the original 43 ids

### Requirement: Active memories MUST expose a derived review state

Each memory with `status = 'active'` SHALL expose a **derived, read-time-only** review state on retrieval. The state is computed, never stored: no column SHALL be added to `memory`, and no row SHALL be mutated to record it.

For an `active` memory of type `T`:

- `reviewBaseline` SHALL be `max(created_at, latest confirmation event_ts)` — the last time the memory was **affirmed** (its own creation, or a `memory.confirm` recorded against the head of its supersedes chain). `last_seen_at` SHALL NOT be used as the baseline, because `last_seen_at` advances on every read (access), not on affirmation.
- `reviewAfter` SHALL be `reviewBaseline + REVIEW_TTL_MS[T]` when `REVIEW_TTL_MS` has an entry for `T`, and `null` otherwise.
- `reviewState` SHALL be `'needs_review'` when `reviewAfter` is non-null AND `reviewAfter <= now`; otherwise `'fresh'`.

`REVIEW_TTL_MS` SHALL be a per-`type` shelf-life map exported from a single source (`apps/server/src/services/review.ts`). A type with no entry SHALL never produce `needs_review`. The shelf life is a soft re-verification nudge, not a hard expiry: a `needs_review` memory SHALL remain `active` and SHALL be unaffected in ranking, scope isolation, or decay eligibility.

Memories whose `status` is `superseded` or `archived` SHALL NOT carry a review state (`reviewState` is omitted / null for them).

The time derivation SHALL live in one pure function (`deriveReviewState`) so it is independently unit-testable and so the read projection and the scoped `needsReview` query agree by construction.

#### Scenario: A freshly created memory is fresh

- **GIVEN** an `active` memory of a type that has a `REVIEW_TTL_MS` entry, created `now`, with no confirmations
- **WHEN** its review state is derived at `now`
- **THEN** `reviewAfter` SHALL equal `created_at + REVIEW_TTL_MS[type]` and `reviewState` SHALL be `'fresh'`

#### Scenario: An unaffirmed memory past its shelf life needs review

- **GIVEN** an `active` memory whose `reviewBaseline` is older than `now - REVIEW_TTL_MS[type]` and which has no confirmation newer than that baseline
- **WHEN** its review state is derived at `now`
- **THEN** `reviewState` SHALL be `'needs_review'`

#### Scenario: Confirming a memory clears needs_review

- **GIVEN** an `active` memory currently deriving `reviewState = 'needs_review'`
- **WHEN** `memory.confirm` records a confirmation event at `now`
- **THEN** the next derivation SHALL use `reviewBaseline = now`, yielding `reviewAfter = now + REVIEW_TTL_MS[type]` and `reviewState = 'fresh'`
- **AND** no `memory` row SHALL have been mutated to achieve this (the confirmation is the only write)

#### Scenario: Reading a memory does NOT clear needs_review

- **GIVEN** an `active` memory deriving `reviewState = 'needs_review'`
- **WHEN** the memory is fetched via `memory.get` or returned by `memory.search` (both of which touch `last_seen_at`)
- **THEN** its derived `reviewState` SHALL remain `'needs_review'` — access does not count as affirmation

#### Scenario: A type without a TTL never needs review

- **GIVEN** an `active` memory whose `type` has no `REVIEW_TTL_MS` entry, created arbitrarily long ago, never confirmed
- **WHEN** its review state is derived
- **THEN** `reviewAfter` SHALL be `null` and `reviewState` SHALL be `'fresh'`

#### Scenario: Non-active memories carry no review state

- **GIVEN** a memory with `status = 'superseded'` or `status = 'archived'`
- **WHEN** it is retrieved
- **THEN** `reviewState` SHALL be omitted (or null) and `reviewAfter` SHALL be omitted

### Requirement: A scope-enforced batch retrieve MUST back the batch `memory.get`

The service layer SHALL expose a scoped batch retrieve that returns multiple memories by id while preserving scope isolation. The batch retrieve SHALL accept a list of ids and a resolved scope, and SHALL return only the memories whose `(scope, project_id)` matches the given scope, in the same order as the requested ids; ids that are missing OR outside the given scope SHALL be omitted from the result, and the caller SHALL NOT be able to distinguish "missing" from "out of scope" (closing the same information-leak channel as single-memory `get`). The underlying cross-scope primitive (`unsafeGetByIds`) SHALL remain internal and SHALL NOT be callable from the MCP handler directly; only the scoped batch read SHALL be exposed to MCP.

#### Scenario: Batch retrieve returns in-scope rows in request order

- **GIVEN** in-scope active memories M1, M2, M3 in scope `project:'A'`
- **WHEN** the scoped batch retrieve is called with `['M3', 'M1', 'M2']` and scope `project:'A'`
- **THEN** it SHALL return the three memories in the order `[M3, M1, M2]`

#### Scenario: Batch retrieve drops cross-scope ids without leaking

- **GIVEN** memory X in scope `project:'B'` and memory M1 in scope `project:'A'`
- **WHEN** the scoped batch retrieve is called with `['M1', 'X']` and scope `project:'A'`
- **THEN** the result SHALL contain only M1; X SHALL be absent, with no error or field that reveals X exists in another scope

#### Scenario: Batch retrieve with no resolvable ids returns empty

- **WHEN** the scoped batch retrieve is called with ids that are all missing or all out of scope
- **THEN** it SHALL return an empty list, not an error

### Requirement: Memory search MAY expand results via one-hop relation traversal

`memory.search` SHALL accept an optional `include_relations` boolean parameter (default `false`). When `true`, after the normal top-`limit` fused (or chronological) result set is computed, the system SHALL inspect each result row's `relations[]` annotations (see "Search results MUST carry relation annotations") for `kind` in (`supersedes`, `superseded_by`, `conflicts_with`) and, for each such `targetId` not already present in the result set, fetch that memory (respecting the same scope-isolation rule as the primary search) and append it to the response under a separate `expanded` array, each entry carrying `{ ...memoryRow, expandedFrom: <originId>, relationKind }`. The `expanded` array SHALL be capped at 5 entries total regardless of how many primary results carry annotations, and entries in `expanded` SHALL NOT count against the caller's `limit` and SHALL NOT be re-ranked into the primary `results` ordering.

#### Scenario: A superseded hit's head is co-surfaced

- **GIVEN** memory M is `superseded_by` memory N (judged), and a text-query search returns M as a primary result but not N
- **WHEN** `memory.search` is called with `include_relations = true`
- **THEN** the response SHALL include M in `results` and N in `expanded` with `{ expandedFrom: M.id, relationKind: 'superseded_by' }`

#### Scenario: Expansion is capped

- **GIVEN** a primary result set whose combined relation annotations reference more than 5 distinct memories not already in the result set
- **WHEN** `memory.search` is called with `include_relations = true`
- **THEN** `expanded` SHALL contain at most 5 entries

#### Scenario: Expansion is opt-in and off by default

- **WHEN** `memory.search` is called without `include_relations` (or with it explicitly `false`)
- **THEN** the response SHALL NOT contain an `expanded` field

### Requirement: Supersedes-chain reads MUST be bounded and content-free

A memory's predecessor ancestry is a DAG, not a chain: `replaces[]` is extended both by `saveWithTopicKey` (one immediate predecessor) and by `applySupersedesSideEffect` (an additional predecessor per judged `supersedes` verdict). Any read that walks that ancestry SHALL bound the traversal by a compile-time depth/count limit and SHALL project each predecessor to identity and lifecycle fields only — `{id, title, status, createdAt}` — never its `content`.

The response SHALL carry `predecessorCount` (the number of predecessors reached) and `truncated` (whether the bound was hit), so a caller can tell that more ancestry exists and page into it with the existing batch read. Because `title` is fixed at insert and never updated, the projected title is a faithful immutable label for the omitted content.

#### Scenario: A deep topic_key chain is read

- **GIVEN** a memory whose `topic_key` has been saved 52 times, producing 51 reachable predecessors
- **WHEN** `memory.get` is called on the current head
- **THEN** the response SHALL contain at most the bounded number of predecessors, each without `content`
- **AND** `truncated` SHALL be `true` and `predecessorCount` SHALL report the bound that was applied

#### Scenario: A short chain is read in full

- **GIVEN** a memory with three reachable predecessors
- **WHEN** `memory.get` is called on it
- **THEN** all three SHALL be returned as `{id, title, status, createdAt}` projections
- **AND** `truncated` SHALL be `false`

#### Scenario: Head resolution exceeding its hop cap is signalled

- **GIVEN** a `replaces` graph whose forward walk from the requested id exceeds the head-resolution hop cap
- **WHEN** the head is resolved (e.g. by `memory.confirm`)
- **THEN** the caller SHALL receive an explicit signal that the head was not reached, rather than a silently-returned non-active row

### Requirement: Reactivating a decayed memory MUST survive the next sweep

Undoing a decay operation SHALL restore the affected rows to `active` **and** stamp their `last_seen_at` to the undo instant, because an operator reviving a memory is an access event. Without the stamp all three decay-candidate predicates (`status='active'`, `last_seen_at` older than the per-type window, confirmation count below the floor) still hold and the next sweep re-archives the same rows, making undo appear to work and then silently revert itself.

The undo SHALL NOT record a confirmation and SHALL NOT advance the review baseline, so the decay axis and the review axis stay orthogonal.

#### Scenario: A decayed memory is restored and the sweep runs again

- **GIVEN** a memory archived by a decay op, whose op is then undone
- **WHEN** the consolidation sweep runs again with no intervening writes
- **THEN** the memory SHALL still be `active` and SHALL NOT appear in the new run's decay candidates

#### Scenario: Reactivation does not affirm the memory

- **GIVEN** a memory archived by decay and then restored by undo
- **WHEN** its derived review state is computed
- **THEN** the review baseline SHALL be unchanged by the reactivation, and no confirmation row SHALL have been inserted

### Requirement: Text inputs MUST reject NUL bytes at the service boundary

SQLite's `length()` terminates at the first NUL byte, so a value whose JavaScript `.length` satisfies a bound can still violate the database-level `CHECK` on the same column — a `title` beginning with a NUL byte has JS length ≥ 1 but SQLite length 0 and is rejected by the `CHECK(length(title) BETWEEN 1 AND 100)` constraint, surfacing as an opaque `internal_error` with the memory never written. Every agent-supplied text field SHALL be rejected with `invalid_input`, naming the offending field, when it contains a NUL byte: `title`, `content`, each element of `tags`, and the session `title` and `summary`. This generalises the guard that already exists for `topic_key`.

#### Scenario: A title containing a leading NUL byte is rejected

- **WHEN** `memory.save` is called with a `title` whose first character is a NUL byte
- **THEN** the call SHALL be rejected with `invalid_input` naming `title`, and SHALL NOT reach the database

#### Scenario: Content containing an embedded NUL byte is rejected

- **WHEN** `memory.save` is called with a `content` containing a NUL byte at any position
- **THEN** the call SHALL be rejected with `invalid_input` naming `content`

### Requirement: Derived titles MUST NOT split a surrogate pair

`deriveTitle` truncates to the title bound with a raw UTF-16 slice, so content whose boundary character is astral (an emoji, some CJK extensions) yields a title ending in a lone surrogate, which becomes U+FFFD when encoded and then feeds the FTS index and every list view. Title derivation SHALL use the same surrogate-safe slice helper already used for session summary truncation.

#### Scenario: Content whose truncation boundary falls inside an emoji

- **WHEN** `memory.capture_passive` derives a title from content whose character at the truncation boundary is an astral-plane codepoint
- **THEN** the derived title SHALL end at the preceding whole codepoint and SHALL NOT contain an unpaired surrogate
