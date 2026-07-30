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

`memory.get(id)` SHALL return the memory along with its ancestry: the predecessors reachable via `replaces`, the count of AFFIRMING confirmations against the current head, AND the set of judged relations involving the memory (sourced from `memory_relations`).

The ancestry projection is bounded and content-free — see "Supersedes-chain reads MUST be bounded and content-free", which governs it: each predecessor is `{id, title, status, createdAt}`, the traversal stops at a compile-time cap, and the response reports `predecessorCount` and `truncated`. "Full ancestry" therefore means "every predecessor up to the cap, identified but not quoted": a caller that needs a predecessor's content fetches it by id, which is what the batch read exists for. Predecessor **content snapshots** SHALL NOT be returned, because a deep `topic_key` chain would otherwise multiply one call's token cost by its own history.

#### Scenario: Retrieving a merged memory

- **WHEN** `memory.get('M')` is called and M was formed by merging A and B
- **THEN** the response SHALL include the content of M, the predecessor projections for `['A','B']` (id, title, status, createdAt — no content), the current affirmation count for M, and a `relations` array containing the `supersedes` entries for A and B

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

The re-embed is conditional on the reset committing. Since marker maintenance no longer aborts the boot (see "The embedding-identity reset MUST be crash-safe and MUST NOT be able to abort the boot"), a boot that cannot maintain the marker SHALL defer the whole reset rather than perform a partial one: the index keeps serving vectors from the previous recipe, no backfill is owed by any row, and the mismatch is re-checked on the next boot. That deferred state SHALL be operator-visible rather than silent, which is why it is warned about there.

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

### Requirement: The embedding-identity reset MUST be crash-safe and MUST NOT be able to abort the boot

The reset that follows an embedding-identity mismatch has two effects that live in different storage systems — the vectors are removed from SQLite, the new identity is recorded in a file under the data dir — and there is no transaction spanning both. The recipe marker SHALL therefore be maintained in two phases: it SHALL record an **in-progress** reset for the compiled-in identity BEFORE any vector is removed, and it SHALL assert that identity as **settled** only AFTER the wipe has committed. An in-progress marker SHALL be treated as an identity mismatch, so an interrupted reset is retried on a later boot. A marker whose in-progress field is present but is not a boolean SHALL also be read as in-progress: unlike the input-version axis, where an unexpected value already mismatches, a corrupt value here would otherwise skip the retry, so the fail-safe direction is to retry.

Three properties follow, and each SHALL hold for every reachable interleaving:

1. **The index SHALL NOT be observed empty under a settled marker asserting the current identity.** That combination is the unrecoverable one: the vectors are gone and nothing will ever conclude they need rebuilding.
2. **A reset that fails at any point SHALL leave the reset owed, and SHALL leave the marker NOT asserting the compiled-in identity as settled.** The debt is carried by the state itself, not by a flag the reset writes for the drain: either the wipe committed — a memory row with no `memory_vec` row is already what the drain selects, so a committed wipe is self-announcing — or the marker still records an in-progress reset, which forces the wipe to be retried. When the failure happens BEFORE the wipe, neither carrier is visible in the vector data at all: every row keeps a vector from the previous recipe, so the embedding backlog reads zero and the marker is the only record of the debt. That state SHALL therefore be surfaced to the operator explicitly — logged at boot with the marker's path, and reported as a `memory.doctor` warning naming the affected row count for as long as the reset is owed AND the index still holds rows — because dense results are unreliable in it while every other health counter reads normal. The warning SHALL be silent when the index is empty (there is nothing stale left to distrust) and SHALL NOT pay for a count of the vector table on the healthy path.
3. **Recording the in-progress marker SHALL precede the wipe on EVERY boot that detects a mismatch**, including a boot whose marker already carries the compiled-in identity but records the reset as in progress. This is what bounds the failure: when the data dir is unwritable, the in-progress write fails before any vector is removed, so a persistently unwritable data dir SHALL perform zero wipes rather than one per boot.

Marker maintenance SHALL NOT abort the boot, and responsibility for that is split deliberately. The pre-wipe write SHALL NOT be swallowed by the reset routine — its failure SHALL propagate to the routine's caller, because that propagation is exactly what prevents the wipe from running; a routine that caught it and carried on to the wipe would reinstate the defect this requirement exists to prevent. The boot SHALL therefore wrap the whole reset (pre-wipe write, wipe, settle) and degrade any failure to "leave the index as it is and re-check on the next boot", logged with the marker's path, without preventing the HTTP listener from binding. Only the settling write SHALL be handled inside the reset routine, and its failure SHALL be reported to the caller as an outcome rather than thrown, so the wipe count survives it.

This SHALL NOT be read as relaxing the model-load rule: an embedding model that cannot load still aborts the boot with a non-zero exit. The distinction is deliberate — a server without a warm model cannot serve its core function, whereas a server whose derived vector index is stale or mid-rebuild serves every request with the documented lexical degradation.

A wipe that commits and a marker that fails to settle SHALL be reported as two separate facts, because their operator consequences differ: the first announces a rebuild that is now under way, the second announces that the rebuild may be repeated on the next boot. The wipe SHALL be reported as an identity reset rather than as a model change: a boot that retries an unsettled reset wipes an index no recipe change had invalidated, so naming a model change there would name the wrong cause.

A marker written by a build that predates the two-phase scheme carries no in-progress field, and its absence SHALL be read as "settled". An upgrade SHALL therefore perform no reset that the previous build would not have performed.

#### Scenario: The marker cannot be written and no vector is lost

- **GIVEN** an identity mismatch and a data dir where writing the marker fails (full or read-only)
- **WHEN** the server starts
- **THEN** no row SHALL be removed from `memory_vec`, the boot SHALL proceed to bind the listener, and the failure SHALL be logged with the marker path

#### Scenario: The wipe commits but the marker cannot be settled

- **GIVEN** an identity mismatch where the in-progress marker persists, the wipe commits, and settling the marker then fails
- **WHEN** the server starts
- **THEN** the boot SHALL proceed, the wipe and the marker failure SHALL be logged as separate facts, and the marker SHALL NOT assert the compiled-in identity as settled
- **AND** the background drain SHALL re-embed the corpus, because every non-archived memory now lacks a `memory_vec` row

#### Scenario: An interrupted reset converges on the next boot

- **GIVEN** a marker left recording an in-progress reset for the compiled-in identity
- **WHEN** the server starts again with a writable data dir
- **THEN** the marker SHALL be treated as a mismatch, the reset SHALL be retried, and the marker SHALL end settled on the compiled-in identity

#### Scenario: A persistently unwritable data dir performs no wipes at all

- **GIVEN** an identity mismatch and a data dir that stays unwritable across restarts
- **WHEN** the server is started repeatedly
- **THEN** the number of wipes performed SHALL be zero, because each boot re-attempts the in-progress write before the wipe and fails there
- **AND** every one of those boots SHALL still bind the listener

#### Scenario: An in-progress marker is not mistaken for a completed reset

- **GIVEN** a marker recording an in-progress reset whose model id and input version already equal the compiled-in identity
- **WHEN** the server starts
- **THEN** the reset SHALL run rather than short-circuit, so an index still holding pre-change vectors cannot be left mixing embedding spaces

#### Scenario: A corrupt in-progress field errs toward retrying

- **GIVEN** a marker naming the compiled-in model id and input version whose in-progress field is present but is not a boolean (a string, a number, an object, or null)
- **WHEN** the server starts
- **THEN** the recorded identity SHALL be reported as not matching and the reset SHALL run

#### Scenario: An owed reset is visible while the index still holds rows

- **GIVEN** a boot that could not perform the reset, leaving the index populated with vectors from the previous recipe
- **WHEN** `memory.doctor` runs
- **THEN** the report SHALL carry a warning naming the number of rows that may predate the current recipe, even though the embedding backlog reads zero
- **AND** no such warning SHALL be produced once the reset has committed, nor while the index holds no rows

#### Scenario: Upgrading over a marker from an earlier build resets nothing

- **GIVEN** a populated install whose marker records the compiled-in model id and input version and has no in-progress field
- **WHEN** the server starts on a build that implements the two-phase marker
- **THEN** the marker SHALL be read as settled, no vector SHALL be removed, and no write to the marker SHALL be attempted

#### Scenario: A model that cannot load still fails the boot

- **WHEN** the embedding model fails to load and the marker is perfectly healthy
- **THEN** the boot SHALL still abort with a non-zero exit — the non-fatal treatment applies to identity-marker maintenance only

### Requirement: Memory search MUST implement standard hybrid retrieval on the text-query branch

When `memory.search` is called with a non-empty text `query`, the system SHALL implement the standard hybrid-search pattern used by mainstream search engines: run an independent **lexical retriever** (FTS5/BM25 ranked ids) and **dense retriever** (vector k-nearest-neighbor ranked ids), then combine their ranked lists using Reciprocal Rank Fusion (RRF): `score(id) = Σ 1/(rank_constant + rank_branch(id))` over the branches in which the id appears. Each child retriever SHALL over-fetch into a bounded **rank window** (at least `limit + offset`, clamped to a fixed ceiling set strictly above the maximum `limit` so an unbounded `offset` cannot force a near-full partition scan) so that fusion is not artificially recall-capped. When `memory.search` is called WITHOUT a text `query`, the system SHALL use the existing chronological listing path unchanged (ordered by `created_at`, with exact `limit`/`offset`). The dense branch SHALL NOT apply a similarity threshold — fusion orders results, it does not filter them. The text query SHALL be sanitized before it is passed to the FTS5 `MATCH` so that an arbitrary natural-language query cannot raise an FTS5 syntax error or be reinterpreted as an FTS5 query expression. The sanitizer SHALL keep whole Unicode word tokens (it SHALL NOT split a token at a non-ASCII character nor drop tokens that are entirely non-ASCII — e.g. accented or CJK text), SHALL strip FTS5 metacharacters and balance quotes, and SHALL neutralize FTS5 bareword operators (`AND`, `OR`, `NOT`, `NEAR`) so a phrase like "coffee OR tea" matches literal terms rather than being parsed as a boolean expression. (The FTS tokenizer folds diacritics, so a sanitized accented or ASCII-folded token matches accented stored content either way; the binding requirement is to preserve whole tokens and neutralize operators, not to special-case accents.) A failure of either branch SHALL degrade gracefully to the other branch rather than failing the whole search. Filters SHALL have explicit guarantees: `status` and `type` apply to BOTH branches; `tag` is exact on the lexical branch and post-filters dense candidates inside the bounded rank window (so no wrong-tag rows are returned, but dense+tag recall is bounded by the rank window rather than globally complete). Result rows SHALL carry the same shape as today (including the `relations` array). Search SHALL NOT advance `last_seen_at` for any returned row — see "Being returned by a search MUST NOT be sufficient to confer durability".

After RRF produces the fused, ordered candidate pool for the over-fetched rank window, the system SHALL apply a post-fusion multiplier BEFORE truncating to the top `limit` results: `finalScore(id) = rrfScore(id) * boost(id)`, where `boost(id)` is a compile-time-constant function of the candidate row's `confirmationCount`, time since `last_seen_at`, and `type`, clamped to a fixed range (declared `[0.7, 1.4]`; reachable in practice `[0.9, 1.35]` given the current per-signal weights). Applying the boost before truncation is deliberate: it CAN and is meant to change which rows make the page — a fresh, confirmed memory SHALL be able to outrank a stale unconfirmed one at a close raw RRF score. The clamp bounds the multiplier's magnitude; it does not, and is not meant to, prevent reordering near-ties. This boost applies ONLY to the text-query (fused hybrid-search) branch; the no-query chronological listing path is UNCHANGED and continues to use exact chronological order with no boost applied. The boost multiplier SHALL NOT be exposed as a per-request tunable — it is a fixed constant, matching the existing style of `RANK_CONSTANT` and the rank-window ceiling.

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

- **Lexical**: the FTS5 index (`memory_fts`) SHALL cover `title` in addition to `content` and `tags`, kept in sync by the same INSERT/UPDATE/DELETE triggers. The interactive search lexical branch SHALL rank with a BM25 column weighting that boosts `title` above `content` (`wTitle > wContent`), so a query matching a memory's title ranks it higher. Save-time candidate detection MAY keep default (unweighted) BM25 ranking — admission there is by rank position within the pool (not an absolute threshold), so reweighting would silently change which rows are admitted.
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

### Requirement: Recall MUST be able to return nothing

The text-query branch SHALL be able to report that it found nothing relevant, rather than always returning the highest-scoring available rows. A confidently-irrelevant result is worse than an empty one, because the calling agent has no signal to distrust it and will treat it as established project knowledge.

Both gates SHALL read ONE quantity, at ONE point in the pipeline.

The quantity is a per-row **relevance level** in `[0,1]`: the greater of (a) the fraction of the query's distinct tokens present in the row's title and content, and (b) the dense branch's cosine similarity for that row. It is bounded and independent of corpus size by construction, so a calibrated value means the same thing on a 40-row corpus and a 5,000-row one. The level SHALL NOT be derived from:

- **raw or logistically-normalised `bm25()`** — unbounded, corpus-relative, and, because FTS5 clamps a non-positive IDF to `1e-6`, always at or above 0.5 under the logistic, saturating to 0.98 within a few IDF units. No absolute threshold on it can fire in the usable range;
- **fused RRF scores** — a function of rank position, not of match quality. Their consecutive ratios are fixed by the rank constant (0.984 rising to 0.996 within a branch-membership class, exactly 0.500 across the both-branches → single-branch boundary), so a threshold over them selects branch membership rather than relevance;
- **any window-relative normalisation** (min-max, rank-percentile, z-score over the branch's own rank window) — each maps the window's best row to a constant, so it can express the _shape_ of a result list but never its _level_, and an absolute floor is a statement about level.

The evaluation point is **after fusion and before the ranking boost**. After fusion, because the page only exists once the branches are fused. Before the boost, because the boost is a ranking multiplier over recency, type and confirmation count with a reachable spread of 1.5× — it is not a relevance measure, and a gate placed behind it lets a fresh, repeatedly-confirmed, irrelevant row clear an abstention check that a stale relevant row fails.

At that point the two gates are:

- The **floor** is absolute and is compared against the highest relevance level in the **whole fused pool**, not a `limit + offset` prefix of it. When no row in the pool reaches the floor, the response SHALL contain no results and SHALL carry an explicit abstention flag and a reason. Levelling a prefix would make both gates a function of the page requested and of the order the branches happened to fuse in: a deeper page widens the prefix and can only raise the leader, so the same query against the same corpus could abstain at one offset and not at the next, and a row the filter judged relevant could be cut from the pool the page is then sliced out of.
- The **relative filter** keeps a row only while its level is at or above `ratio × leaderLevel`, where `leaderLevel` is the same pool maximum the floor used, and preserves fused order. It is a per-row test **relative to the best level**, not a truncation at the first consecutive-pair drop: a gradually decaying tail passes every consecutive test and so returns rows far below the leader, and over a level sequence that is not monotone in fused order, truncating at the first offender discards strictly better rows behind it.

A page shortened by the relative filter SHALL NOT be padded to the requested limit, and SHALL report `abstained: false` — abstention is the floor's verdict, and a caller MUST be able to tell "nothing relevant exists" from "fewer than `limit` rows were relevant".

Both gates SHALL be disabled by default. While both are disabled the branch SHALL perform no gate-related work at all: it SHALL issue the same queries and return the same result ids as if the gates did not exist.

#### Scenario: A query with nothing relevant abstains

- **GIVEN** the floor is enabled with a calibrated value, and a scope whose memories are all unrelated to the query
- **WHEN** `memory.search` is called
- **THEN** the response SHALL contain no results and SHALL report abstention with a reason

#### Scenario: A gate decision does not change when the corpus grows

- **GIVEN** the floor and the relative filter are enabled, and a query whose decision is recorded against a corpus
- **WHEN** the corpus is enlarged with rows that share the query's vocabulary without answering it, so they sort ahead of the answering row
- **THEN** both gates SHALL reach the same decision, because the level of a row depends only on that row and the query AND every fused candidate is levelled

#### Scenario: A gate decision does not change with the page requested

- **GIVEN** the floor is enabled and a query whose pool contains more candidates than one page
- **WHEN** the same query is issued at several offsets
- **THEN** every page SHALL report the same abstention verdict

#### Scenario: A gradually decaying tail is cut

- **GIVEN** the relative filter is enabled at a ratio of 0.5, and a fused pool whose relevance levels are 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3
- **WHEN** `memory.search` is called with a limit of 8
- **THEN** the rows at 0.4 and 0.3 SHALL be omitted, because each is below `0.5 × 0.9`

#### Scenario: A sharp query returns a short result set

- **GIVEN** the relative filter is enabled, and a scope containing one strongly-matching memory and several weak ones
- **WHEN** `memory.search` is called with a limit larger than one
- **THEN** the weak results below `ratio × leaderLevel` SHALL be omitted, and the response SHALL NOT be padded to the requested limit

#### Scenario: A short page is distinguishable from an abstention

- **GIVEN** the relative filter is enabled and it drops every row but two, while the leader clears the floor
- **WHEN** `memory.search` is called with a limit of 8
- **THEN** the response SHALL contain two results and SHALL report `abstained: false`

#### Scenario: Abstention is off by default

- **WHEN** the system runs without calibrated abstention values configured
- **THEN** the text-query branch SHALL return the same result ids it returns with the gates removed, returning up to the requested limit, and SHALL issue no additional database read on their behalf

### Requirement: Search results MUST be diversified across originating sessions

A single verbose session can supply enough highly-ranked memories to occupy an entire result page, displacing the one memory from a different session that answers the query. This requirement specifies the SHAPE of the diversification, not that it is currently switched on: `DIVERSITY_CAP` ships `null` (see "Retrieval and lifecycle constants MUST be named and bounded in one place" for why, and for what re-enabling it requires), so every clause below is conditional on a non-null cap and describes what the cap MUST do when one is configured.

When a per-session cap is configured, the fused, ordered candidate pool SHALL be walked in order and at most that many results per originating session SHALL be admitted; when the cap would leave the page under the requested limit, the page SHALL be backfilled from the skipped remainder in fused order, so the cap never reduces the number of results returned.

Memories with no originating session SHALL NOT be grouped together by that absence.

#### Scenario: One session cannot monopolise a page

- **GIVEN** a configured per-session cap and a fused pool whose top eight results all originate in the same session, and further results from other sessions
- **WHEN** the page is assembled at a limit of eight
- **THEN** at most the per-session cap SHALL come from that session, and the remainder SHALL come from other sessions

#### Scenario: The cap never shrinks the result set

- **GIVEN** a configured per-session cap and a fused pool in which every candidate originates in the same session
- **WHEN** the page is assembled at a limit of eight
- **THEN** eight results SHALL still be returned, backfilled in fused order

#### Scenario: Session-less memories are not treated as one session

- **GIVEN** a configured per-session cap and a fused pool containing several memories with a null session id
- **WHEN** the page is assembled
- **THEN** those memories SHALL NOT be capped as though they shared a session

#### Scenario: With no cap configured the page is the fused page

- **GIVEN** `DIVERSITY_CAP` is `null`, as it ships
- **WHEN** a page is assembled from a fused pool whose rows all share one session
- **THEN** the returned rows SHALL be the top of the fused order unchanged, and no diversification work SHALL be performed

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

After a `memory.save` inserts the new row, the server SHALL run a candidate-detection step over rows in the same `(scope, project_id)`, excluding the newly inserted row and any rows already linked to it via `replaces`. The detection SHALL combine FTS5 lexical neighbors (always), vec kNN neighbors (when the just-saved row has an embedding), and entity-overlap neighbors (see `memory-entities`'s save-time conflict-detection requirement — gated by a rarity threshold so a common entity contributes nothing), apply the internal similarity thresholds (compile-time constants, calibrated for the compiled-in model — not environment-configurable), deduplicate by target id, rank the merged list by the precedence the `memory-entities` capability defines (entity-sourced candidates lead, then the reported `similarity` descending), and return up to `CANDIDATES_PER_SAVE_MAX` (default 5) candidates.

Each detection channel SHALL scan a bounded pool before that ranking is applied, sized by a single named constant (`CANDIDATE_POOL_SIZE`, see "Retrieval and lifecycle constants MUST be named and bounded in one place"). The pool bound is therefore UPSTREAM of the cap: the merged, ranked list is itself bounded, and no scope-wide count of related memories is available at save time. Consequently the count the response reports (see the `mcp-api` capability, "`memory.save` MUST report how many candidates its detection produced") SHALL be specified as a LOWER BOUND on how many memories in scope resemble the saved row, and SHALL NOT be specified as a total. A count that happens to be exact — which it is whenever the scope holds fewer comparable rows than the pool bound — SHALL NOT be relied upon as exact, because that exactness is a property of corpus size and not of the count.

The lexical pass SHALL build its FTS5 `MATCH` expression with the SAME Unicode-aware builder used by interactive `memory.search` (see the `mcp-api` hybrid-retrieval contract): it SHALL keep whole Unicode word tokens and SHALL NOT split a token at a non-ASCII character nor drop tokens that are entirely non-ASCII (accented or CJK text), and it SHALL apply a bounded term cap so a long save body cannot build an unbounded `MATCH` expression. Consequently, save-time candidate detection SHALL NOT silently degrade to vector-only for non-ASCII content: a non-ASCII memory body SHALL produce a non-empty `MATCH` expression and SHALL be eligible to surface `source: 'fts'` candidates. The lexical pass SHALL still skip only when the builder yields no usable tokens at all.

The detection SHALL additionally exclude any target id that was already judged `relation = 'not_conflict'` against the new memory's `replaces` ancestry. That ancestry is the TRANSITIVE closure of `replaces[]`, bounded by its own constant — see "Dismissal suppression MUST bound its ancestry walk with its own named constant", which owns the depth, the order and the bound. It is NOT the array's own elements: `replaces[]` alone is one hop, and one hop loses a dismissal made two or more saves back on the same topic, which is the case this suppression exists for. This suppresses the re-surfacing of a pair the agent already dismissed as a false positive on an earlier save of the same evolving topic. Because `memory_relations` has no topic column and each save mints a fresh `source_id`, the dismissal SHALL be carried forward by walking that ancestry, NOT by the new row's own id (which no prior relation references). Only `not_conflict` SHALL be suppressed; other judged relations (notably `conflicts_with`) SHALL continue to surface so an unresolved contradiction re-confronts the agent on the next save.

For each candidate surfaced, a `memory_relations` row SHALL be inserted with `status = 'pending'`, `source_id = <new row>`, `target_id = <candidate>`, and a generated `judgment_id`.

Candidates that were detected but fall outside `CANDIDATES_PER_SAVE_MAX` SHALL NOT be recorded: no `memory_relations` row, no `judgment_id`, no journal entry. This is not an information loss, and the requirement states why so that a future change does not "fix" it by recording them.

A candidate pair is DERIVED: its two endpoints and its `similarity` are a function of `memory.title` and `memory.content` — immutable under "Memories MUST be append-only" — together with recipes pinned in the shipped image behind version markers (the FTS5 tokenizer, the entity extractor behind `EXTRACTOR_VERSION`, and the embedding identity behind `EMBEDDING_INPUT_VERSION` and the pinned model constants, per "Embeddings MUST be computed in-process by a model loaded at boot" and "Stale vectors MUST be re-embedded after a model change"). It therefore satisfies the same test the `persistence` capability applies to its own derived tables (`memory_fts`, `memory_vec`, `memory_replaces`, and the entity tables, which that capability requires to be "declared derived, never primary"): dropping it loses nothing that cannot be recomputed from rows still in the database. An agent's VERDICT on a pair is the opposite — SOURCE data, recomputable by nothing — which is precisely what earns a row.

Dropping a candidate therefore discards a prompt, not a fact, and the prompt is re-derivable at any time from the surviving inputs via `memory.search` over the memory's own text (lexical and dense channels) and `memory.search` with an `entity` filter (entity channel).

That re-derivability SHALL be specified as re-derivability and NOT as reproducibility. A re-derived candidate set is the CURRENT one, not the save-time one: rows created since the save are included, `superseded` and `archived` rows are absent, and a change to the pinned embedding recipe changes the vectors. Nor is it identical in shape: `memory.search` is a fused ranked read that returns memories, not pairs carrying `judgment_id`s, so recording a verdict on a re-derived pair is `memory.compare`. No requirement SHALL claim that a dropped candidate can be reconstructed as it stood at save time.

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
- **THEN** the response SHALL include the top 5 by the ranking precedence above; the remaining 7 SHALL NOT have `memory_relations` rows inserted and SHALL NOT surface to the agent; and the response SHALL report the detected count so the truncation is not silent

#### Scenario: The number of pending rows equals the number of surfaced candidates

- **GIVEN** a save whose detection ranked more candidates than `CANDIDATES_PER_SAVE_MAX`
- **WHEN** the save completes
- **THEN** the number of `memory_relations` rows inserted for that save SHALL equal the length of the returned `candidates[]`, and SHALL NOT equal the reported detected count

#### Scenario: The detected count is taken before the cap, not after

- **GIVEN** a save whose detection ranked 12 candidates with `CANDIDATES_PER_SAVE_MAX = 5`
- **WHEN** the save completes
- **THEN** the reported detected count SHALL be 12, and the returned `candidates[]` SHALL hold 5 entries which SHALL be the first 5 of that same ranked order

#### Scenario: A topic-key save's superseded predecessor is neither surfaced nor counted

- **GIVEN** a save carrying a `topic_key` that supersedes a previously-active row P in the same slot
- **WHEN** candidate detection runs for the new row
- **THEN** P SHALL NOT appear in `candidates[]` and SHALL NOT be included in the reported detected count, because P is in the new row's `replaces[]` and is therefore excluded from every channel's pool

#### Scenario: Candidate detection respects scope

- **GIVEN** the just-saved row is in scope `project:'A'`
- **WHEN** candidate detection runs
- **THEN** every candidate's `(scope, project_id)` SHALL match `project:'A'`; rows in other projects or in global SHALL NOT be considered, regardless of similarity

#### Scenario: The detected count respects scope

- **GIVEN** memories in another project that would resemble the just-saved row
- **WHEN** candidate detection runs for a row in scope `project:'A'`
- **THEN** the reported detected count SHALL count only pairs whose target lies in `project:'A'`

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

#### Scenario: A dropped candidate is re-derivable but not reproducible

- **GIVEN** a save whose detection ranked more candidates than the cap, and a later session that wants the pairs which were not surfaced
- **WHEN** the agent re-derives them by calling `memory.search` with the memory's own text and with an `entity` filter
- **THEN** the pairs SHALL be reachable, and the re-derived set SHALL reflect the CURRENT corpus — including memories saved after the original save and excluding rows now `superseded` or `archived` — rather than the set that existed at save time

### Requirement: Search results MUST carry relation annotations

`memory.search` SHALL include a `relations` array on each result row, sourced from `memory_relations` in a single JOIN (no N+1). The annotations SHALL cover `supersedes`, `superseded_by`, `conflicts_with`, `related`, `compatible`, `scoped` (judged), and `pending_conflict` (status = 'pending'). The bound is 10 annotations per memory by default, raisable per request by the caller up to a fixed maximum (see the `mcp-api` capability, "`memory.search` and `memory.get` MUST expose the annotation bound and its true total"); excess annotations are visible via the dashboard.

Which annotations survive the bound SHALL NOT depend on the order a database scan returns rows. The annotation list SHALL be ordered before it is bounded, by:

1. **Kind tier**, most decision-relevant first — `conflicts_with`, then `supersedes`, then `superseded_by` (load-bearing: a contradiction the reader must resolve, and the two lifecycle edges telling the reader the row is not current), then `pending_conflict`, then `scoped`, `compatible`, `related` (informational).
2. **The relation's creation time, most recent first.**
3. **The relation's `judgment_id`.**

The ordering SHALL be a **total** order: because `judgment_id` is unique, no two annotations can compare equal, so a batch of judgments sharing a creation timestamp is still ordered deterministically rather than left to scan order.

Consequently a memory carrying more relations than the bound SHALL surface its load-bearing edges rather than an arbitrary sample: neither a large number of informational edges nor a backlog of unjudged candidates SHALL be able to displace a `conflicts_with`, `supersedes` or `superseded_by` annotation. Repeated reads of unchanged data SHALL return the same annotations in the same order, and raising the bound SHALL only extend the list — it SHALL NOT reorder the annotations already returned at a lower bound.

Every row carrying `relations` SHALL also carry `relationsTotal`: the number of annotations that exist for that memory after the `not_conflict` and `orphaned` exclusions and BEFORE the bound is applied. It SHALL be present whether or not the list was bounded, and it SHALL NEVER be the returned list's length restated — when the list was cut, `relationsTotal` SHALL be strictly greater. Computing it SHALL NOT cost an additional query: the underlying reads are unbounded, so the complete count is already available at the moment the list is bounded.

The same ordering, the same caller-supplied bound, and the same total SHALL apply to every annotation list a memory-returning read projects, including both forms of `memory.get`, so two surfaces can never describe the same memory's relations differently. The one-hop expansion in "Memory search MAY expand results via one-hop relation traversal" reads this same ordered list; its kind set and its own cap of 5 are unchanged, but its input SHALL no longer depend on scan order.

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

#### Scenario: A contradiction is not evicted by informational edges

- **GIVEN** memory M carries twelve judged `related` relations and one judged `conflicts_with` relation, the `conflicts_with` row created before the `related` rows
- **WHEN** `memory.search` returns M at the default bound
- **THEN** M's `relations` SHALL contain 10 entries, the first of which is the `conflicts_with` annotation, and `relationsTotal` SHALL be 13

#### Scenario: A pending backlog cannot evict a judged load-bearing edge

- **GIVEN** memory M carries twenty `pending_conflict` candidates and one judged `supersedes` relation
- **WHEN** `memory.search` returns M
- **THEN** M's `relations` SHALL contain the `supersedes` annotation ahead of every `pending_conflict` annotation

#### Scenario: Repeated reads agree, including on a same-timestamp batch

- **GIVEN** memory M carries more relations than the bound, several of which were judged in one transaction and therefore share a creation timestamp
- **WHEN** `memory.search` returns M twice with no intervening write
- **THEN** both responses SHALL carry the same annotations in the same order

#### Scenario: The true total is reported, bounded or not

- **GIVEN** memory M carries 40 annotations and memory Q carries 3
- **WHEN** `memory.search` returns both at the default bound of 10
- **THEN** M's row SHALL carry 10 annotations and `relationsTotal: 40`, and Q's row SHALL carry 3 annotations and `relationsTotal: 3`

#### Scenario: Raising the bound extends the list without reordering it

- **GIVEN** memory M carries 40 annotations
- **WHEN** `memory.search` is called for M at the default bound and again at a bound of 25
- **THEN** the 25-entry list SHALL begin with exactly the 10 entries the default returned, in the same order, and `relationsTotal` SHALL be 40 in both responses

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

### Requirement: `procedural` MUST be a first-class memory type

Procedural knowledge — how a task is performed in this codebase, a runbook, a workflow — is the highest-value memory class for a coding agent and has a shelf life unlike any existing type. It is currently expressible only as `reference`, which deliberately carries **no** review TTL and a ten-year decay window on the grounds that a reference is a pointer whose staleness surfaces when used. A runbook is not a pointer: it goes stale silently when the underlying process changes, and a stale runbook actively misleads.

The memory-type enum SHALL include `procedural`, with its own review TTL and its own decay window, distinct from `reference`. Existing rows SHALL NOT be reclassified: assigning a type is a content judgement, and the server SHALL NOT make it on the agent's behalf.

#### Scenario: A procedural memory needs review on its own schedule

- **GIVEN** an active `procedural` memory older than its type TTL and never re-affirmed
- **WHEN** its review state is derived
- **THEN** it SHALL be `needs_review`, independently of what a `reference` memory of the same age would report

#### Scenario: Existing reference memories are untouched by the migration

- **GIVEN** a database containing `reference` memories, some of which describe procedures
- **WHEN** the migration introducing `procedural` runs
- **THEN** every existing row SHALL retain its current type

#### Scenario: The type is accepted at the tool boundary

- **WHEN** `memory.save` is called with `type = 'procedural'`
- **THEN** the row SHALL be persisted with that type and SHALL be filterable by it

### Requirement: Active memories MUST expose a derived review state

Each memory with `status = 'active'` SHALL expose a **derived, read-time-only** review state on retrieval. The state is computed, never stored: no column SHALL be added to `memory`, and no row SHALL be mutated to record it.

For an `active` memory of type `T`:

- `reviewBaseline` SHALL be `max(created_at, latest AFFIRMING confirmation event_ts)` — the last time the memory was **affirmed** (its own creation, or a `memory.confirm` with verdict `affirm` recorded against the head of its supersedes chain). A refuting confirmation SHALL NOT advance it. `last_seen_at` SHALL NOT be used as the baseline: it is the ACCESS signal, advanced by dereferencing a memory (`memory.get` on a single id), by an affirming `memory.confirm`, and by an operator undoing a decay archival — never by a search returning a row, and never by the batch `memory.get({ids})` form. Access and affirmation are different facts about a memory, which is the whole reason the two axes exist.
- `reviewAfter` SHALL be `reviewBaseline + REVIEW_TTL_MS[T]` when `REVIEW_TTL_MS` has an entry for `T`, and `null` otherwise.
- `reviewState` SHALL be `'needs_review'` when `reviewAfter` is non-null AND `reviewAfter <= now`; otherwise `'fresh'`.
- A refutation newer than `reviewBaseline` SHALL force `reviewState = 'needs_review'` regardless of `T`'s TTL, and `reviewAfter` SHALL then report the refutation's timestamp.

`REVIEW_TTL_MS` SHALL be a per-`type` shelf-life map exported from a single source (`apps/server/src/services/review.ts`). A type with no entry SHALL never produce `needs_review` on the clock. The shelf life is a soft re-verification nudge, not a hard expiry: a `needs_review` memory SHALL remain `active` and SHALL be unaffected in ranking, scope isolation, or decay eligibility.

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
- **WHEN** `memory.confirm` records an affirming confirmation event at `now`
- **THEN** the next derivation SHALL use `reviewBaseline = now`, yielding `reviewAfter = now + REVIEW_TTL_MS[type]` and `reviewState = 'fresh'`
- **AND** no `memory` row SHALL have been mutated to achieve this (the confirmation is the only write, plus the access-signal touch that an affirmation carries)

#### Scenario: Reading a memory does NOT clear needs_review

- **GIVEN** an `active` memory deriving `reviewState = 'needs_review'`
- **WHEN** the memory is dereferenced via `memory.get({id})` (which advances `last_seen_at`), fetched via `memory.get({ids})` (which does not), or returned by `memory.search` (which does not)
- **THEN** its derived `reviewState` SHALL remain `'needs_review'` in all three cases — access does not count as affirmation, whether or not the read advanced the access signal

#### Scenario: A type without a TTL never needs review on the clock

- **GIVEN** an `active` memory whose `type` has no `REVIEW_TTL_MS` entry, created arbitrarily long ago, never confirmed and never refuted
- **WHEN** its review state is derived
- **THEN** `reviewAfter` SHALL be `null` and `reviewState` SHALL be `'fresh'`

#### Scenario: A refuted TTL-less memory still needs review

- **GIVEN** an `active` `reference` memory (no TTL) that has been refuted since its affirmation baseline
- **WHEN** its review state is derived
- **THEN** `reviewState` SHALL be `'needs_review'` and `reviewAfter` SHALL be the refutation's timestamp

#### Scenario: Non-active memories carry no review state

- **GIVEN** a memory with `status = 'superseded'` or `status = 'archived'`
- **WHEN** it is retrieved
- **THEN** `reviewState` SHALL be omitted (or null) and `reviewAfter` SHALL be omitted

### Requirement: Being returned by a search MUST NOT be sufficient to confer durability

A memory appearing in a page of search results is evidence that it ranked, not that it was useful. The access signal that drives decay eligibility and the retrieval recency boost SHALL NOT be advanced merely by a row being included in a result page, because doing so makes ranking self-reinforcing: a row that ranks well becomes decay-immune, gains a recency boost that helps it rank well again, and is pinned to the top of subsequent context pulls, with no evidence the agent read past its title.

Whatever signal the system adopts for "accessed", it SHALL be advanced only by an interaction that distinguishes a dereferenced memory from a listed one, and any row that is filtered out before reaching the caller SHALL NOT have its access signal advanced.

The shipped resolution is the strongest form of that rule: search advances the access signal for **no** row — neither the rows it returns nor the rows it drops — and only dereferencing a memory by id advances it. The drop-before-return scenario below is therefore satisfied vacuously today; it remains a stated requirement so that a future re-introduction of a search-time touch cannot reach a row the caller never saw.

#### Scenario: A broad search does not confer durability on every hit

- **GIVEN** a corpus in which a memory is old enough to be decay-eligible
- **WHEN** a search returns that memory in a page of results and the caller does not dereference it
- **THEN** the memory SHALL remain decay-eligible

#### Scenario: A dereferenced memory is treated as accessed

- **WHEN** a memory is fetched by id
- **THEN** its access signal SHALL be advanced

#### Scenario: A row dropped before return is not touched

- **GIVEN** a row retrieved by a retrieval branch but excluded by the live-status re-check before the response is built
- **WHEN** the search completes
- **THEN** that row's access signal SHALL NOT have been advanced

### Requirement: The system MUST accept a negative affirmation, recorded append-only

The only affirmation verb today is positive, and autonomous archival is deliberately forbidden. An agent that surfaces a memory, acts on it, and discovers it is stale or wrong therefore has no way to record that — while the act of retrieving it has advanced its access signal, making it more durable than an untouched memory. The system SHALL accept a refutation against a memory, recorded as an append-only event carrying the refuting agent's reason.

A refutation SHALL NOT advance the memory's access signal, SHALL NOT mutate or delete the memory, and SHALL NOT itself archive it. It SHALL be an input to the read-time derivation of review state, so review state remains derived and never stored.

Its consequences for the review queue SHALL be exactly these:

- A refuted memory SHALL surface in the review queue immediately, whatever its type's shelf life and whether or not its type has one.
- A refutation SHALL NOT advance the affirmation baseline. Refuting is not affirming, so the ordering signal the queue uses to find the least-recently-affirmed memory SHALL be untouched by it.
- Because the baseline is untouched, a freshly-refuted memory would sort LAST under baseline ordering — so the queue SHALL surface refuted rows ahead of merely-expired ones, bounded as the sibling requirement specifies.
- An affirming `memory.confirm` newer than the refutation SHALL clear the state: the baseline advances past the refutation and the memory derives `fresh` again. That is the ONLY way a refuted memory leaves the queue short of being superseded or archived — there is no second verb, and reading it does not clear it.
- Affirmation counts SHALL count affirming events only, so a refutation never inflates the confidence signal that decay reads.

#### Scenario: A refuted memory needs review immediately

- **GIVEN** an active memory whose derived review state is `fresh`
- **WHEN** an agent refutes it
- **THEN** its derived review state SHALL become `needs_review` without waiting out its type TTL

#### Scenario: A refutation is not an access

- **WHEN** an agent refutes a memory
- **THEN** the memory's access signal SHALL be unchanged

#### Scenario: A refutation preserves the memory

- **WHEN** an agent refutes a memory
- **THEN** the memory's `content`, `title` and `status` SHALL be unchanged, and the refutation SHALL be recoverable as an event

#### Scenario: A refutation does not advance the affirmation baseline

- **GIVEN** an active memory with a known `reviewBaseline`
- **WHEN** an agent refutes it
- **THEN** `reviewBaseline` SHALL be unchanged and the affirmation count SHALL be unchanged

#### Scenario: A refuted memory can be re-affirmed

- **GIVEN** a memory that was refuted and subsequently confirmed
- **WHEN** its review state is derived
- **THEN** the later confirmation SHALL advance the affirmation baseline, and the memory SHALL derive `fresh` and leave the review queue

### Requirement: The review queue MUST have a terminal state

A memory that is retrieved regularly but never re-affirmed crosses its review TTL and then remains `needs_review` indefinitely: reads deliberately do not clear it, and — because reads advance the access signal — decay cannot archive it either. The two staleness axes do not cover this case, and the affected population only grows.

The escalation SHALL be a **read-time derived signal**, `reviewEscalated`, true once the memory has been unaffirmed for a bounded multiple of its own type TTL (`reviewBaseline + ttl * (1 + ESCALATION_MULTIPLIER) <= now`). It SHALL be derived by the same pure function as the rest of the review state, SHALL be reported on the single-`id` `memory.get` read alongside `reviewState`/`reviewAfter` (see `mcp-api`), and SHALL introduce no column, no sweep and no new mutation verb. It SHALL NOT be produced by the decay axis: the decay pass reads `last_seen_at` and the confidence floor only, and coupling it to the review clock would break the orthogonality the two axes are built on.

Two populations are deliberately outside the escalation clock, and both are stated rather than left implicit:

- A type with no TTL has no clock to be a multiple of, so it never escalates. It also never enters the queue on the clock, so this is closure, not limbo.
- A **refuted** memory of a TTL-less type is the one genuinely open case: it is in the queue with no TTL to escalate against, so it stays `needs_review` until it is re-affirmed, superseded, or archived by explicit action. This exemption is deliberate. The limbo the escalation signal exists to close is the one nobody chose — a memory nobody ever formed an opinion about — whereas a refutation is an explicit, attributed, reasoned claim that the memory is wrong; expiring that claim on a timer would discard the strongest evidence in the system on the grounds that it had been ignored for long enough. Its queue POSITION is time-bounded (see the sibling requirement) so it cannot starve the rest of the queue; its STATE is not.

#### Scenario: A long-unaffirmed but frequently-read memory escalates

- **GIVEN** an active memory that has been `needs_review` for a bounded multiple of its type TTL, and whose access signal has been advanced throughout that period
- **WHEN** its review state is derived
- **THEN** `reviewEscalated` SHALL be true, distinguishing it from a memory that has only just entered `needs_review`

#### Scenario: Escalation stores no state

- **WHEN** a memory escalates within the review axis
- **THEN** no column SHALL record the escalation and no sweep SHALL be required to produce it

#### Scenario: A recently-expired memory is not escalated

- **GIVEN** an active memory one day past its `reviewAfter`
- **WHEN** its review state is derived
- **THEN** `reviewState` SHALL be `'needs_review'` and `reviewEscalated` SHALL be false

#### Scenario: A TTL-less type never escalates

- **GIVEN** an active memory of a type with no `REVIEW_TTL_MS` entry, refuted long ago and never re-affirmed
- **WHEN** its review state is derived
- **THEN** `reviewState` SHALL be `'needs_review'` and `reviewEscalated` SHALL be false

### Requirement: Review and judgment queue depths MUST be observable by the agent

`memory.context` returns only the few oldest memories needing review and no total, and the observability tools report no review or pending-judgment counts, so an agent cannot distinguish a healthy corpus from one with hundreds of unaffirmed memories — even though the count is already computed for the operator sidebar. The agent-facing surfaces SHALL report the total number of memories needing review and the total number of unresolved pending judgments in the effective scope, so an agent can batch-affirm using the existing multi-id form rather than clearing a three-item drip.

The scoped guarantee binds `memory.context` and `memory.stats`. The equivalent field in the `memory.doctor` report SHALL be server-wide rather than scope-resolved, deliberately matching the precedent that `memory.doctor`'s `sessions.active` is already server-wide while `memory.stats`'s session counter is scoped.

#### Scenario: The context response reports queue depth

- **WHEN** `memory.context` is called in a scope with more memories needing review than it returns
- **THEN** the response SHALL include the total count alongside the returned subset

#### Scenario: Stats report both queues

- **WHEN** `memory.stats` is called
- **THEN** the response SHALL include the count of memories needing review and the count of unresolved pending judgments, scoped to the request context

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

That traversal SHALL be a SINGLE bounded query owned by the data layer (see the `data-access` capability, "Bounded ancestry traversal MUST be one recursive query over `memory.replaces`"), never a per-ancestor probe loop in a service. Its cost SHALL therefore be independent of both the chain's length and the corpus size: a walk from the head of a 1 000-save chain reads the same bounded number of rows as one from the head of a 40-save chain.

The bound SHALL count ancestor IDS reached, and SHALL mean the same thing to every reader of the ancestry. An ancestor id carrying no `memory` row SHALL consume the bound and contribute no projection, rather than causing the walk to continue past the bound in search of one. That state is not expected — the purge predicate refuses to purge a row that another row's `replaces` references — so the bound is defined for it rather than the walk being tuned around it.

The read itself SHALL select only the projected fields. Projecting at the response boundary while the read fetches whole rows satisfies the letter of "never its `content`" and none of its purpose: on a chain at the bound that is ten memory bodies read from disk and discarded on every `memory.get`.

The response SHALL carry `predecessorCount` (the number of predecessors PROJECTED, i.e. the length of the returned array) and `truncated` (whether the bound was hit), so a caller can tell that more ancestry exists and page into it with the existing batch read. The two are independent: an ancestor id inside the bound that carries no row is reached without being projected, so `predecessorCount` MAY be below the bound while `truncated` is `true`. Because `title` is fixed at insert and never updated, the projected title is a faithful immutable label for the omitted content.

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

#### Scenario: A dangling ancestor id consumes the bound

- **GIVEN** an ancestry whose reachable ids include one with no corresponding `memory` row, within the bound
- **WHEN** the ancestry is read
- **THEN** that id SHALL count against the bound and SHALL NOT appear in the returned projections
- **AND** `predecessorCount` SHALL report the number of projections returned, which MAY be fewer than the bound while `truncated` is `true`

#### Scenario: The traversal cost does not grow with the chain

- **GIVEN** two memories, one at the head of a 40-save `topic_key` chain and one at the head of a 1 000-save chain
- **WHEN** each one's ancestry is read
- **THEN** both reads SHALL issue the same number of statements, and SHALL read a number of rows bounded by the cap rather than by the chain length

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

### Requirement: Save-time lexical candidate scoring MUST increase with match quality

FTS5's bm25 score is negative and unbounded, and a better match is _more_ negative. Any similarity derived from it SHALL be monotonically **increasing** in match quality, and SHALL be bounded to `[0, 1]` so that the value reported to the agent as `similarity` is truthful against its documented range and comparable with the cosine similarity produced by the dense detector.

Because bm25 magnitudes scale with corpus size and term IDF, the system SHALL NOT gate lexical candidates on an absolute threshold over the raw bm25 value: no such threshold is stable across corpus sizes. Admission SHALL instead be by rank position within the already-correctly-ordered candidate pool, and the reported `similarity` SHALL be computed as a corpus-independent lexical overlap measure between the saved text and the candidate.

#### Scenario: A byte-identical duplicate is surfaced lexically

- **GIVEN** a scope containing at least fifty active memories, and a newly saved memory whose text is byte-identical to one of them, with no embedding available
- **WHEN** save-time candidate detection runs
- **THEN** the identical memory SHALL be surfaced as a candidate with `source: 'fts'`
- **AND** its reported `similarity` SHALL be 1.0

#### Scenario: A near-zero-IDF match is not reported as identical

- **GIVEN** a scope in which a term appears in nearly every memory
- **WHEN** a save shares only that term with an otherwise unrelated memory
- **THEN** that memory SHALL NOT be reported with a `similarity` near 1.0
- **AND** it SHALL NOT displace a genuinely similar candidate from the per-save candidate budget

#### Scenario: Lexical detection does not go silent as the corpus grows

- **GIVEN** the same duplicate-save scenario evaluated at corpus sizes of 50, 150 and 300 active memories
- **WHEN** save-time candidate detection runs at each size
- **THEN** the identical memory SHALL be surfaced at every size

### Requirement: The rank window MUST be wide enough for the rank constant it uses

Reciprocal Rank Fusion with rank constant `k` only preserves the intended ordering when the rank window is wide enough that a bottom-of-window row present in both branches cannot outscore a rank-1 row present in one branch. That condition is `2/(k + window) <= 1/(k + 1)`, i.e. the window must be at least `k + 2`. With `k = 60` and the default result limit the window is currently 38, well below the crossover, so the invariant is violated on the default path.

The rank window SHALL be floored at or above the crossover implied by the rank constant, so that a single-branch rank-1 match is never displaced by rows whose only advantage is appearing in both branches' windows. Both retrievers already over-fetch and the dense kNN cost is flat in `k`, so the floor SHALL be implemented by widening the window rather than by lowering the rank constant. This guarantee is bounded by construction: at most `window - (rank_constant + 2)` rows can simultaneously rank below the crossover in both branches. A single-branch match displaced by more genuinely-relevant competitors than fit on a page is not a violation of this requirement — no window floor can or should prevent a page from filling with better matches.

The guarantee is a property of **fusion**, and it holds over fused RRF scores only. The post-fusion boost is applied afterwards and is explicitly licensed to reorder near-ties (see "The post-fusion boost's documented guarantee MUST match its behavior"): its reachable multiplier spread is far wider than the fusion margin this floor protects, so a boosted row CAN overtake a single-branch rank-1 row. That is the boost doing its job, not a window violation, and the two requirements SHALL be read in that order.

#### Scenario: An exact single-branch match outranks a both-branches pair

- **GIVEN** a query whose exact-token match is returned at rank 1 by the lexical branch and is absent from the dense branch's window
- **AND** two rows that appear near the bottom of both branches' windows
- **WHEN** the ranked lists are fused at the default result limit
- **THEN** the exact match SHALL outrank both of those rows in the FUSED ordering, before the boost is applied

#### Scenario: The boost may reorder what fusion ordered

- **GIVEN** the same fused ordering
- **WHEN** the post-fusion boost is applied and a trailing row carries a materially higher boost
- **THEN** the reordering SHALL be permitted, and SHALL NOT be treated as a failure of the window floor

#### Scenario: An identifier query returns the memory naming it

- **GIVEN** an active memory whose content contains a rare identifier, and no more than `window - (rank_constant + 2)` other memories ranked below the crossover in both branches
- **WHEN** `memory.search` is called with that identifier at the default limit
- **THEN** the memory containing the identifier SHALL appear in the returned page

#### Scenario: Large-limit behavior is unchanged

- **WHEN** `memory.search` is called with a limit whose derived window already exceeds the crossover
- **THEN** the window SHALL be unchanged by the floor

### Requirement: The post-fusion boost's documented guarantee MUST match its behavior

The post-fusion boost is applied before results are truncated to the requested limit, so it can and does change which rows are returned — reordering near-ties is its purpose, not a side effect to be bounded away. Its declared clamp (`[0.7, 1.4]`) MUST NOT be narrower, in its documentation, than what the boost is actually meant to do; and MUST NOT be documented as tighter than its reachable range (`[0.9, 1.35]` given the current per-signal weights), since a bound the implementation cannot reach reads as a guarantee that was never true.

Coverage of this behavior SHALL use test inputs inside the range fusion can actually produce. A guard test whose inputs exceed the maximum achievable fused score is not coverage — it cannot distinguish the boost working from the boost being disabled entirely.

#### Scenario: The boost guarantee is tested within the reachable domain

- **WHEN** the boost's ordering guarantee is tested
- **THEN** the test inputs SHALL be scores achievable by the fusion function over ranked lists, not values above its arithmetic ceiling

#### Scenario: The documented bound matches the reachable range

- **WHEN** the boost's documented range is compared against the sum of its reachable terms
- **THEN** the documentation SHALL not claim bounds the implementation cannot reach

### Requirement: A refutation MUST lead the review queue only while it is recent

The review queue is ordered by affirmation baseline, oldest first, and a refutation deliberately does not advance that baseline — so a just-refuted memory sorts LAST and the agent that called it wrong never sees it come back. Refuted rows therefore lead the queue. That lead SHALL NOT be permanent: `memory.context` returns three rows, so a handful of refuted memories nobody attends to would hold the head of the queue forever and every TTL-expired memory in the corpus would be starved out of the only channel that surfaces it. The failure is silent and it worsens monotonically, because refuted rows only accumulate.

The queue SHALL order by a **time-bounded** refutation lead: a row whose refutation is newer than a bounded window sorts ahead of the rest, and past that window it queues by affirmation baseline like any other expired row. Crossing the window SHALL NOT change the row's `reviewState` — it is still `needs_review` and still counted in the queue depth; only its position changes. The window SHALL be a single named constant declared beside `REVIEW_TTL_MS`, and the ordering SHALL be computed in one place so the scoped queue read and its unscoped dashboard twin cannot drift apart.

#### Scenario: A fresh refutation leads

- **GIVEN** a scope containing a memory refuted today whose affirmation baseline is the newest in scope, and older memories past their TTL
- **WHEN** the review queue is read with a limit of one
- **THEN** the refuted memory SHALL be returned

#### Scenario: An unattended refutation stops starving the queue

- **GIVEN** three memories whose refutations are all older than the lead window, and one memory past its TTL whose affirmation baseline is the oldest in scope
- **WHEN** the review queue is read with a limit of three
- **THEN** the TTL-expired memory SHALL be in the page

#### Scenario: Losing the lead does not leave the queue

- **GIVEN** the same corpus
- **WHEN** the queue depth is counted
- **THEN** all four memories SHALL still be counted as needing review

### Requirement: Retrieval and lifecycle constants MUST be named and bounded in one place

Ranking, projection and lifecycle behaviour is governed by a set of compile-time constants that no requirement previously named, which made each one invisible to review and free to drift. None SHALL be operator-configurable or exposed as a per-request tunable, and each SHALL be declared once, as a named constant, in the module that owns the behaviour:

- `RANK_WINDOW_MARGIN` — the over-fetch added to `limit + offset` before the floor and ceiling are applied, so a page near a window edge still fuses over more candidates than it returns.
- `RANK_WINDOW_CEILING` — the hard cap on that window, set strictly above the maximum `limit`. It doubles as the entity path's page size when no `limit` is given (see `mcp-api`), so exact-address retrieval is complete-within-a-bound rather than truncated to a ranked default.
- `RELATIVE_LEVEL_RATIO` — the relative-filter ratio applied against the fused pool's highest relevance level. Named for what it measures; it is not a consecutive-pair gap ratio and SHALL NOT be described as one.
- `RELEVANCE_LIMIT` — the cap on `memory.context`'s relevance channel, shared by its entity pre-pass and its ranked pass.
- `CANDIDATE_POOL_SIZE` — the per-channel pool each save-time candidate channel scans BEFORE the merged list is ranked and capped. It is the bound that makes the reported detected count a lower bound rather than a total, and for the lexical channel it IS the admission rule (see "Save-time lexical candidate scoring MUST increase with match quality"), so exposing it as configuration would make an admission rule operator-settable. It is applied per channel, and the entity channel applies it once per extracted entity, so the merged pool — and therefore the detected count — MAY exceed it.
- `ENTITY_RARITY_THRESHOLD` — the maximum share of a scope's active memories an entity may be linked to before it stops proposing save-time candidates. A proportion, not an absolute count, so it does not become inert as a corpus grows.
- `ENTITIES_PROJECTION_CAP` — the per-memory bound on the `entities[]` projection. The reads behind it carry no `LIMIT`, so the complete per-memory count is in hand where the bound is applied and SHALL be reported as a count rather than as an indication that the bound was hit. Unlike `CANDIDATE_POOL_SIZE` above there is no pool upstream of it, so that count is exact and MAY carry a `Total` suffix. It SHALL be applied to a fair-shared order rather than an arbitrary one (see `mcp-api`), so that what the bound withholds is a stated consequence of the memory's entity composition rather than an accident of kind naming — a bound over an arbitrary order cannot be reviewed, because what it costs is unknowable. Changing its value SHALL therefore be argued against a measured distribution of entities per memory, produced by running the shipped extractor over production-shaped content, not against the returned array's length.
- `PREDECESSOR_CAP` — the bound on `memory.get`'s predecessor PROJECTION, and nothing else. Its value is a token budget for that one response, so no other consumer of the `replaces` ancestry SHALL borrow it: a decision to show more or fewer predecessors would otherwise silently change unrelated behaviour elsewhere.
- `DISMISSAL_ANCESTRY_CAP` — how far back along the `replaces` ancestry a `not_conflict` dismissal is carried forward when save-time candidates are suppressed. A suppression-reach decision, not a payload decision, and SHALL be declared separately from `PREDECESSOR_CAP` even while the two hold the same value.
- `ESCALATION_MULTIPLIER` — the multiple of its own TTL a memory sits `needs_review` before `reviewEscalated` derives true.
- `REBUILD_MAX_BATCHES` — the bound on one operator-triggered derived-index rebuild pass, so the rebuild cannot become an unbounded blocking loop.

Three gates ship disabled (`null`): the abstention floor and `RELATIVE_LEVEL_RATIO` (see "Recall MUST be able to return nothing"), and the per-session `DIVERSITY_CAP`. Their disabled state is not itself the contract — an uncalibrated gate silently removes recall, so what is contracted is the evidence a commit must carry to enable one.

Enabling the abstention floor or `RELATIVE_LEVEL_RATIO` SHALL require, in the same change:

1. a committed sweep across a grid of candidate values, produced by the evaluation harness rather than asserted;
2. an over-abstention rate of zero at every committed `k` — no query with a gold answer returns nothing;
3. an abstention false-positive rate at or below its committed cap;
4. precision, recall and MRR at or above their committed floors at every committed `k`;
5. the chosen value in the interior of a plateau at least two grid steps wide on each of the criteria above, so a value that holds at exactly one grid point is rejected as a cliff edge rather than accepted as a calibration.

Enabling `DIVERSITY_CAP` SHALL additionally require a session-labelled evaluation fixture, because it is applied to the whole fused pool before the page is sliced — a held-back row is replaced by whatever ranked next in a 64–400 row pool rather than by a comparable row, which on a single-topic session measurably swaps most of page 1 for noise — and the current corpus cannot see that regression, every corpus row carrying a null session id, which is never grouped.

#### Scenario: A constant is not reachable as a request parameter

- **WHEN** any MCP tool input schema is inspected
- **THEN** none of the constants above SHALL be settable per request

#### Scenario: The candidate pool size is not operator-configurable

- **WHEN** the environment schema is inspected
- **THEN** `CANDIDATE_POOL_SIZE` SHALL NOT be readable from the environment, and `CANDIDATES_PER_SAVE_MAX` SHALL remain the only operator knob over save-time candidate surfacing

#### Scenario: A disabled gate stays disabled without a calibration

- **WHEN** the abstention floor, `RELATIVE_LEVEL_RATIO`, or the diversity cap is enabled
- **THEN** the change SHALL be accompanied by a measurement on the evaluation harness, and for the diversity cap by a session-labelled fixture the harness can see the regression through

#### Scenario: A gate is enabled without a committed sweep

- **WHEN** a change sets the abstention floor or `RELATIVE_LEVEL_RATIO` to a non-null value without a committed harness sweep across a grid of candidate values
- **THEN** the change SHALL be rejected

#### Scenario: A candidate value that costs recall is rejected

- **GIVEN** a swept candidate value at which any query with a gold answer returns nothing
- **WHEN** that value is proposed for the abstention floor
- **THEN** it SHALL be rejected regardless of its abstention false-positive rate

#### Scenario: A candidate value that holds at only one grid point is rejected

- **GIVEN** a swept candidate value that meets every criterion at its own grid point and fails at both adjacent grid points
- **WHEN** that value is proposed
- **THEN** it SHALL be rejected as a cliff edge, and the gate SHALL remain disabled

#### Scenario: Re-enabling the diversity cap without a session-labelled fixture

- **WHEN** `DIVERSITY_CAP` is set to a non-null value while every row in the evaluation corpus carries a null session id
- **THEN** the change SHALL be rejected, because the harness cannot observe the regression the cap causes

#### Scenario: The projection bound is not reused as the suppression bound

- **WHEN** `PREDECESSOR_CAP` is changed
- **THEN** the depth of save-time dismissal suppression SHALL be unchanged, and no module outside `memory.get`'s predecessor projection SHALL read that constant

#### Scenario: The projection bound is changed without a distribution

- **WHEN** a change alters `ENTITIES_PROJECTION_CAP` citing only that the bound is reached, without a measured distribution of entities per memory over production-shaped content
- **THEN** the change SHALL be rejected

### Requirement: Dismissal suppression MUST bound its ancestry walk with its own named constant

Save-time candidate detection suppresses targets the new row's `replaces` ancestry already judged `not_conflict` (see "`memory.save` MUST surface candidate conflicts at save-time"). How far back that suppression reaches is a decision about how long an agent's dismissal stays honoured. It SHALL be governed by `DISMISSAL_ANCESTRY_CAP`, declared in the module that owns save-time detection, and SHALL NOT be governed by `PREDECESSOR_CAP` — whose value is a token budget for `memory.get`'s payload, an unrelated concern. Sharing one constant means a future decision to show 25 predecessors silently deepens suppression, and a decision to show 5 silently discards dismissals an agent already made.

`DISMISSAL_ANCESTRY_CAP` SHALL be introduced at the value `PREDECESSOR_CAP` held when the two were split, so the split itself changes no behaviour, and either SHALL be changeable thereafter without moving the other.

The walk SHALL be transitive over `replaces`, breadth-first from the new row's immediate predecessors, deduplicated on first encounter, and bounded by counting ancestor IDS — including the immediate predecessors it starts from. Breadth-first ordering is the contract, not an implementation accident: the bound discards the far end of the ancestry, so the ancestors retained SHALL be the nearest ones, whose dismissals are the most recent. Deduplication on first encounter SHALL make the walk terminate on a `replaces` graph containing a cycle rather than depend on the bound to stop it.

A save whose `replaces[]` is empty SHALL issue no ancestry query at all: with no ancestry there is nothing to suppress, and the walk SHALL NOT cost a statement to discover that.

#### Scenario: A dismissal two saves back is still suppressed

- **GIVEN** a target X judged `not_conflict` against M0, and M1 saved on the same `topic_key` superseding M0
- **WHEN** M2 is saved on that same `topic_key`, so its ancestry reaches M0 through M1, and X would otherwise clear the similarity thresholds
- **THEN** X SHALL NOT appear in M2's `candidates[]` and no pending `memory_relations` row SHALL be inserted for `(M2, X)`

#### Scenario: A dismissal beyond the bound is no longer suppressed

- **GIVEN** a `topic_key` chain longer than `DISMISSAL_ANCESTRY_CAP` whose oldest member dismissed X
- **WHEN** a new save on that chain runs detection and X clears the thresholds
- **THEN** X MAY surface again — the bound is a deliberate limit on suppression reach, not a best-effort attempt at completeness

#### Scenario: Changing the projection budget does not change suppression

- **WHEN** `PREDECESSOR_CAP` is raised or lowered
- **THEN** the set of targets suppressed by an identical save SHALL be unchanged

#### Scenario: A save with no predecessors runs no ancestry query

- **GIVEN** a save whose `replaces[]` is empty
- **WHEN** candidate detection runs
- **THEN** no ancestry traversal statement SHALL be executed

#### Scenario: A cycle in the ancestry terminates the walk

- **GIVEN** two memories whose `replaces` arrays reference each other
- **WHEN** the ancestry of either is walked
- **THEN** the walk SHALL return both ids once and terminate
