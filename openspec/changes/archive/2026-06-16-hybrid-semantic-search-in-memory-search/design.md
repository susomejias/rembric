## Context

`memory.search` runs one of two SQL branches today (`memory-repository.ts::searchMemoryIds`): with a `query`, an FTS5 `MATCH` ordered by BM25 `rank`; without one, a plain listing ordered by `created_at`. The lexical branch cannot bridge languages or paraphrase — the motivating bug is a Spanish query failing to surface an English memory.

The pieces for semantic retrieval already exist but are wired only into save-time candidate detection:

- `Embedder.embed(text)` — `gte-multilingual-base`, 768-dim, normalized, loaded eagerly at boot, always warm (~15ms/call). It can embed arbitrary text.
- `memory_vec` — today a `vec0(memory_id, embedding FLOAT[768])` virtual table; every active memory gets a vector inline at save (`embedNow`) with a background drain backfilling gaps.
- `VectorsRepository.knnByCosine` — kNN, but only for neighbors of an **existing** memory row (self-join on `v_self.memory_id = :memoryId`). It cannot take an arbitrary query vector, and it filters scope but not `type`/`tag`.

The `0002_vec_setup.sql` migration explicitly scoped vectors to "consolidation only; not on the agent retrieval hot path." This change reverses that decision deliberately and records why.

### Industry pattern: standard hybrid retrieval, expressed in the repo's idiom

This is the mainstream hybrid-search pattern — a lexical retriever (FTS5/BM25) and a dense retriever (sqlite-vec kNN) over a bounded rank window, fused by Reciprocal Rank Fusion — not a bespoke Rembric ranking system:

```text
text query → [lexical: FTS5/BM25 ids] + [dense: sqlite-vec kNN ids] → RRF (rank window + constant) → hydrate/touch
```

The same pattern is documented by Elasticsearch (RRF retriever with `rank_window_size`/`rank_constant`), Azure AI Search (full-text + vector merged by RRF), and Qdrant (prefetch retrievers + `FusionQuery`); sqlite-vec supplies the local building blocks (partition keys for scope sharding, metadata columns for status/type prefilters). References:

- https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion
- https://learn.microsoft.com/en-us/azure/search/hybrid-search-overview
- https://qdrant.tech/documentation/search/hybrid-queries/
- https://alexgarcia.xyz/sqlite-vec/features/vec0.html

Adopt the **algorithm and vocabulary** of this pattern, not a big engine's object model. The repo already implements this exact dense+lexical+merge shape as a single module-level function (`services/save-time-candidates.ts::findSaveTimeCandidates`); the hybrid search path mirrors it (orchestrator + module helper + pure fusion function), not a class hierarchy. Use the industry terms (RRF, rank window, lexical/dense retriever, rank constant) **in prose and comments**; in code follow the repo idiom — camelCase identifiers (`rankConstant`, `rankWindowSize`) and a SCREAMING_SNAKE constant (`RANK_WINDOW_CEILING`), never snake_case.

Performance was validated empirically (sqlite-vec 0.1.9, better-sqlite3, 768-dim, in-memory, top-20). **Two distinct cost models, established after an adversarial review corrected an early mislabeled benchmark:**

| query path                                                            | cost driver                       | measured                                                                |
| --------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------- |
| naive `vec_distance_cosine(col, qvec)` + JOIN (today's `knnByCosine`) | total in-scope rows, full scan    | ~1ms / 100 rows (10k=98ms, 50k=543ms, 100k=1147ms) — **does not scale** |
| `MATCH ... AND k=? AND partition_key=?` (proposed)                    | rows **in the matched partition** | see single-partition table below                                        |

Single-partition kNN (the honest worst case — the **global scope is one partition** and does not shard), p50:

| in-partition rows | vec kNN | + ~15ms embed = total text-query search |
| ----------------- | ------- | --------------------------------------- |
| 10k               | 1.3ms   | ~16ms                                   |
| 50k               | 6.8ms   | ~22ms                                   |
| 100k              | 14.2ms  | ~29ms                                   |
| 250k              | 36.2ms  | ~51ms                                   |
| 500k              | 71.8ms  | ~87ms                                   |

The partition key shards **across** scopes/projects (a 100k corpus spread over many projects searches its 10k-row project partition in ~1.4ms), but **within** a single large partition the kNN is still brute-force, ~1.4ms per 10k rows. The naive `knnByCosine` path is what save-time candidate detection uses today, so save-time already pays the worse (unpartitioned) O(n) cost at scale.

## Goals / Non-Goals

**Goals:**

- Cross-lingual and paraphrase recall in `memory.search` for the text-query branch.
- Preserve exact-token strength (proper nouns, identifiers) by keeping FTS in the mix — not replacing it.
- Scale acceptably for a realistic large personal corpus: single-digit-ms vec latency up to ~50k in-partition, low-tens-of-ms up to ~100k, dominated by the unavoidable ~15ms query embed until the corpus is large.
- Zero new runtime dependencies; reuse the model and index already in the image.
- No regression on the no-query listing branch (offset/limit semantics, latency).

**Non-Goals:**

- Cross-encoder reranker. Rembric is deliberately single-model-in-process; a second model adds boot, RAM, and a pinned dependency for diminishing returns at this corpus size. Documented as a possible future escalation.
- ANN index (e.g. HNSW/IVF) **in this change**. Brute-force in-partition kNN is acceptable for the realistic personal-corpus envelope (≤~100k in a partition → ≤~30ms total). Reopened as a documented future escalation if a single partition grows past the low hundreds of thousands (the global scope is the at-risk partition; ~250k → ~51ms, ~500k → ~87ms).
- **Sub-partitioning the global scope to keep it fast.** Partitioning only accelerates kNN when the query is confined to a single partition — that is why partitioning by _scope_ is optimal (a scoped search scans one shard). The global scope, however, _is_ the search space: an unfiltered semantic query needs the nearest neighbors across all of it, so any sub-partition (by type, hash, cluster) must either be scanned in full and merged (no speedup) or skipped (broken recall — true neighbors live in other buckets). The only mechanism that accelerates kNN _within_ one space is an ANN index (approximate recall), which sqlite-vec 0.1.x lacks; adopting one means a different vector store and abandoning the single-SQLite-file invariant. Hence: partition by scope (free, exact), brute-force within a partition, ANN only if a single partition ever gets huge.
- Semantic search over non-`active` memories by default. The default active filter is preserved. `superseded` rows are vector-recoverable when explicitly requested because they remain in the non-archived re-embed set; `archived` rows remain lexical-searchable but are outside the semantic-search guarantee after model changes.
- Operator-tunable fusion/threshold knobs. RRF's constant is an engine constant like the existing similarity floors.

## Decisions

### D1 — Hybrid only on the text-query branch; listing branch untouched

`memory.search` already forks on presence of `query`. The hybrid path applies **only** when a text query is present: embed the query, run vec kNN + FTS BM25, fuse. The no-query branch stays pure SQL with real `OFFSET`/`LIMIT` and zero added latency.

- _Alternative considered:_ unify both branches behind the vector path. Rejected — listing has no query to embed, and forcing an embed wastes ~15ms for a pure chronological list.

### D2 — RRF fusion with industry-style rank window and rank constant

Fuse the two child retriever ranked lists by `score(id) = Σ 1/(rankConstant + rank_branch(id))`, sort desc, slice. Keep this in a tiny pure `fuseRRF(rankedLists, rankConstant)` helper (~6 lines: a `Map` + a loop), not embedded in `MemoryService.search` — exactly the shape of the merge step already inside `findSaveTimeCandidates`, which is a plain function, not a class. Start with `rankConstant = 60`, matching the common RRF default documented by search engines (`rank_constant` in Elastic terms).

- _Rank window / over-fetch (closes review finding F8):_ each branch is queried for `rank_window_size = min(limit + offset + margin, RANK_WINDOW_CEILING)` (default margin ~30; `RANK_WINDOW_CEILING` a fixed cap set **strictly above the maximum `limit`**, e.g. 400 since `limit` is capped at 200 — NOT equal to the limit max, or `offset` would be inert at `limit = 200`, Round-3 review), NOT `k = limit`. This is the same concept Elastic calls `rank_window_size`: each child retriever returns a bounded window, fusion happens over that window, and the final result is pruned to `limit`. With `k = limit`, a doc at vec-rank `limit+1` that FTS misses would never enter the fused pool, capping recall tighter than either branch alone. Over-fetching keeps the fused pool deep enough that the top-`limit` (after best-effort `offset`) is stable. The ceiling clamp is required because `offset` is validated only as `min(0)` with no upper bound (`tools.ts:65`); an unclamped `limit + offset` would let `offset: 1_000_000` force a near-full partition scan and a huge allocation on every text query (Round-2 review).
- _Why over weighted interpolation `α·vec + (1-α)·fts`:_ BM25 `rank` and cosine distance live on incomparable scales; interpolation needs a fragile normalization and a per-corpus `α`. There is no single good `α` across the personal↔proper-noun spectrum (a preference paraphrase wants high vec weight; "Botín" wants high FTS weight) and we cannot know the query's type a priori. RRF is rank-based, sidesteps normalization, and rewards cross-branch consensus. It is the de-facto default in Elasticsearch/Azure/Qdrant-style hybrid retrieval; Weaviate/Pinecone also expose hybrid fusion/alpha patterns, but alpha-style score interpolation is less attractive here because BM25 and cosine score ranges are not comparable without calibration.
- _Why hand-written:_ importing a library for 6 lines adds supply-chain surface (`minimumReleaseAge`, `ignore-scripts`) for negative benefit.
- _Why not vector-only (simpler):_ vector-only pays the SAME ~15ms query embed (semantic search requires embedding the query) and only saves the ~<1ms FTS query, while **regressing** exact-token lookups (proper nouns, IDs, file paths) that BM25 nails and embeddings smear. Hybrid is ~1ms more than vector-only for strictly better recall.

### D3 — No similarity thresholds on the search vector branch

Search is recall-oriented (find _something_ useful); save-time candidate detection is precision-oriented (don't nag the agent with false duplicates). The save-time floors (`VEC_THRESHOLD=0.7`, `FTS_THRESHOLD=0.4`) are **not** reused here. RRF orders; it does not filter. A weak cross-lingual match (e.g. cosine ~0.6) that save-time would discard is exactly what search should still surface.

- _Alternative considered:_ apply a low floor to the vec branch. Rejected — any floor risks dropping the borderline cross-lingual matches that are the whole point.

### D4 — New scoped `knnByQueryVector`; leave `knnByCosine` as-is

Add a method taking an arbitrary `queryVector: Float32Array`, a partition token, requested `status`, optional `type`, and `rankWindowSize`/`k`. Do **not** model JSON `tag` as vector metadata in this change; see D7. It is **scoped** (takes the partition token / Scope as a parameter) — therefore NOT an `admin*`/`unsafe*` method, consistent with the data-access invariants (closes review finding F11). The save-time `knnByCosine` (existing-row neighbors) is untouched so candidate detection is unaffected; the review verified it filters scope via the joined `memory` row and is forward-compatible with the rebuilt table. The new method uses the fast `MATCH ... AND k=? AND partition_key=? AND status=?` form, plus `type=?` when requested. The service passes `status='active'` by default and may pass `status='superseded'` for explicit historical search; `status='archived'` is lexical-only because archived vectors are outside the post-model-change semantic guarantee (D9).

- _Alternative considered:_ generalize `knnByCosine` to accept either a memory id or a vector. Rejected — overloading a load-bearing save-time method muddies it; a separate, independently-testable method is clearer.

### D5 — Rebuild `memory_vec` with scope partition key + `status`/`type` metadata — vec0-specific recipe

Rebuild as `vec0(memory_id TEXT PRIMARY KEY, partition_key TEXT partition key, status TEXT, type TEXT, embedding FLOAT[768])`. `partition_key` is derived from scope: `project_id` for project scope, the sentinel `'__global__'` for global scope (`project_id IS NULL`). The review verified `'__global__'` cannot collide with a real `project_id` (a ULID) and that partition+status/type MATCH isolates scope, lifecycle status, and memory type with zero leakage.

**The migration MUST NOT use the generic table-rebuild dance (closes review finding F1).** It was verified empirically that on a `vec0` virtual table: `ALTER TABLE … RENAME` does NOT rename the shadow tables (`*_chunks`, `*_rowids`, `*_vector_chunks00`, …) — the rename appears to succeed but every later query fails with `no such table: …_chunks`; and `INSERT … SELECT *` fails on a column-count mismatch. The required recipe (verified working inside a transaction):

1. Create a temp normal table; `INSERT` into it `memory_id, partition_key, status, type, embedding` by selecting from the old `memory_vec` joined to `memory` (deriving `partition_key`/`status`/`type` from the memory row). **No re-embedding** — embeddings are copied as blobs.
2. `DROP TABLE memory_vec` (drops the vtable + its shadow tables cleanly).
3. `CREATE VIRTUAL TABLE memory_vec USING vec0(...)` at the **final** name (never a `_new` name + rename).
4. `INSERT INTO memory_vec (memory_id, partition_key, status, type, embedding) SELECT ... FROM <temp>` with explicit columns.
5. Drop the temp table.

The FK-safe runner (`migrate.ts`) still wraps the migration; the review confirmed `vec0` shadow tables carry no FKs, so `PRAGMA foreign_key_check` returns clean and `DROP TABLE` succeeds inside the wrapper.

- _Alternative considered (A):_ keep the naive `vec_distance_cosine`+JOIN path, no schema change (~40 lines, no migration). Rejected — does not scale (10k in-scope = ~98ms, 50k = ~543ms).
- _Bonus:_ the same fast path can later replace the O(n) self-join in save-time candidate detection.

### D6 — Keep vectors for the full lifecycle; filter `status` inside the kNN (do NOT delete on supersede/archive)

`memory_vec` is a **derived index**, not primary data: an embedding is a deterministic function of `memory.content` (which append-only preserves) and is recomputable. The index therefore is NOT bound by the append-only invariant of the `memory` table; it MAY be updated to track the lifecycle, mirroring the existing `memory_fts` trigger-driven sync. An earlier draft deleted vec rows on leaving `active`; rejected because it forfeits semantic recall over superseded/archived history and only bought index size — which the benchmark proves irrelevant. So we keep retained vectors and carry `status` as a metadata column, filtering `status='active'` inside the kNN by default. The semantic-search guarantee covers `active` by default and `superseded` when explicitly requested; archived rows are retained/purged according to lifecycle rules but are **not** part of the guaranteed semantic-search corpus after model changes because the backfill intentionally targets non-archived rows (D9).

**Sync mechanism (corrected per review findings F4/F5 + Round-2):**

- `partition_key`, `status`, and `type` are set **at insert time by application code** (`insertEmbedding`), NOT by an `AFTER INSERT` trigger — the review verified `vec0` forbids triggers _on_ the vtable, and rejects NULL on an auxiliary TEXT metadata column (`status`; a NULL `partition_key` is accepted but a NULL `status` throws), so a 2-column insert + later trigger-fill is impossible. `insertEmbedding` gains `partitionKey` + `status` + `type` params.
- Two insert paths must both supply them: (a) the **drain** (`findMissingEmbeddings` is extended to project `project_id`/`scope`/`status`/`type` so the worker can derive them); (b) the **inline save-time path** — `embedNow(memoryId, content)` does NOT do a DB lookup (it is called at `mcp/tools.ts:384` as `deps.embedNow(m.id, m.content)` with the just-saved `Memory` in scope), so its signature and the `ToolDeps.embedNow` type in BOTH `mcp/tools.ts:164` and `mcp/server.ts:90` must be widened to thread `scope`/`projectId`/`status`/`type` (status is always `active` at save) — this is a signature change across three surfaces, not a "lookup."
- `status` is kept in sync by a trigger on the **base `memory` table** (`AFTER UPDATE OF status ON memory` → `UPDATE memory_vec SET status = new.status WHERE memory_id = new.id`), exactly the pattern `memory_fts` already uses. The review verified this works on 0.1.9. `partition_key` is never updated (scope/`project_id` is immutable per memory; the review confirmed vec0 rejects partition-key UPDATE, which is fine).

### D7 — Structured filters follow the search-engine pattern: prefilter what sqlite-vec can index, bound what it cannot

Today the FTS path applies `type`/`tag`/`status`; the vec path (`knnByCosine`) applies only scope. The hybrid path should mirror production hybrid-search engines: push structured filters into the child retrievers when the underlying index can enforce them, and be explicit when a filter is only a post-filter over a bounded rank window.

- `status`: pre-filtered in `memory_vec` metadata for `active`/`superseded`; `archived` search is lexical-only because archived rows are not re-embedded after model changes (D9). FTS applies the same requested status in SQL.
- `type`: pre-filtered in `memory_vec` metadata and in the FTS SQL. This avoids the sparse-type failure mode where a type-specific semantic hit sits outside a generic vector top-K.
- `tag`: exact in the FTS SQL. For the dense branch, do **not** duplicate the JSON `tags` array into `memory_vec` in this change (sqlite-vec metadata is scalar; exploding tags would require a separate tag-vector side index or multi-row vector table). Instead, post-filter hydrated dense candidates by tag inside the over-fetched `rank_window_size`. This guarantees no wrong-tag rows are returned, but dense+tag recall is bounded by the rank window. If tag-specific semantic recall becomes important, add a follow-up design for a dedicated tag prefilter strategy rather than quietly pretending the scalar vector index solved it.

### D8 — FTS branch must not crash on natural-language queries; fault-isolated; whole-token-preserving + operator-neutralizing sanitizer

The review found the motivating query itself breaks FTS5: the raw `query` is passed verbatim to `memory_fts MATCH`, and `"¿cómo toma el café?"` throws `fts5: syntax error near "?"` (also `C++`, unbalanced quotes, dangling operators). Since `handleSearch` surfaces that as an MCP error, the hybrid search would throw _before_ the vec branch could rescue the cross-lingual query — defeating the whole change (closes review finding F3). Two complementary defenses, both required:

1. **Sanitize the query for the FTS branch with a token-preserving, operator-neutralizing helper** (a new, search-specific helper — NOT a reuse of `save-time-candidates.ts::escapeFts`). Round-3 review corrected the mechanism: `memory_fts` is created bare in `0001_fts5_setup.sql`, so it uses `unicode61` with the default `remove_diacritics=1` — the tokenizer **folds diacritics on both sides** (`"botin"` and `"botín"` both match stored `Botín`). So accent _preservation_ is not what makes the match work. `escapeFts` is the wrong tool for two concrete reasons instead: (a) it `split`s on `/[^a-z0-9]+/`, which **truncates a token at the first non-ASCII letter** (`"Botín" → "bot"`) and then emits it as a _quoted exact term_, which matches nothing (FTS5 quoted terms are exact-token, not prefix — `bot ≠ botin`); and (b) it **drops tokens that are entirely non-ASCII** (a CJK or accented-only query → empty MATCH). The search sanitizer MUST therefore: keep whole Unicode word tokens (letters/marks/digits across scripts — do not split mid-token, do not drop non-ASCII tokens); strip FTS5 metacharacters (`" * ( ) : ^ - .` and column-filter syntax); **neutralize FTS5 bareword operators** (`AND`, `OR`, `NOT`, `NEAR`) and leading `*`/`+` so a natural-language "coffee OR tea" isn't parsed as a boolean expression; and balance quotes. Quoting each surviving token as a phrase is the simplest defense that covers metacharacters AND barewords at once.
2. **Fault-isolate the FTS branch**: a sanitized-but-still-empty or failed FTS query degrades to an empty lexical list, and the vec branch alone still fuses and returns. The vec branch is likewise isolated.

### D9 — Embedding coverage gaps degrade gracefully; do NOT narrow the re-embed set

Memories without a vector (inline embed failed, drain lag, mid-backfill after a model change) simply don't appear in the vec branch; FTS still finds them. Search is correct without 100% coverage and improves as coverage rises.

**Corrected per review finding F4:** an earlier draft retargeted the drain (`findMissingEmbeddings`) from `status != 'archived'` to `status = 'active'`. That is **dropped** — it would, after a model change (which wipes all vectors via `ensureVectorModel`), leave the retained superseded memories permanently un-re-embedded, breaking D6's recoverability promise and contradicting the existing "re-embed all non-archived" requirement. The drain keeps targeting `status != 'archived'`, so active **and** superseded vectors are regenerated after a model change, and the index never mixes embedding spaces for the searchable (active) set once backfill completes. Archived memories remain outside the semantic guarantee (matching today's non-archived backfill behavior and the `purgeDisconnectedArchived` path). They remain reachable lexically while present; after a model change, they may have no vector because `ensureVectorModel` wipes stale vectors and the drain deliberately re-embeds only non-archived rows.

### D10 — `MemoryService.search` becomes async; hybrid ranking lives in a module-level helper (flat, mirroring `findSaveTimeCandidates`)

Today `MemoryService.search(input, scope): Memory[]` is **synchronous** and the service constructor takes only `repos` + `tx` — the embedder is a standalone dependency wired solely into `EmbeddingWorker`/`embedNow`, never into `MemoryService`. The hybrid branch needs `embedder.embed(query)` (async), but the ranking machinery should not be inlined into the already load-bearing `MemoryService.search`. Mirror the repo's existing precedent — `findSaveTimeCandidates`, which already runs dense kNN + FTS BM25 + merge as a single module-level function — with one module-level `hybridSearch(...)` helper (sanitize → lexical ids + dense ids → `fuseRRF` → hydrate ids) plus the pure `fuseRRF`. The "lexical retriever" and "dense retriever" are the two existing scoped repo calls (`searchMemoryIds`/the BM25 reader and `knnByQueryVector`), labelled with the industry concepts in comments — NOT new classes (the repo has no retriever/strategy class pattern; `ConsolidationRunner`, its most complex orchestrator, delegates to plain functions). `MemoryService.search` stays the orchestrator that forks listing-branch vs text-query-branch. This forces two ripples the tasks MUST cover:

1. **Dependency injection (corrected per Round-4 review):** the `MemoryService` repos `Pick` is currently `Pick<Repositories, 'memory' | 'consolidation'>` (`memory.ts:97`) — it does NOT include `vectors`, so the hybrid branch's `repos.vectors.knnByQueryVector(...)` will not typecheck until `'vectors'` is added to that Pick. Two wiring changes are needed: (a) widen the repos Pick to `'memory' | 'consolidation' | 'vectors'`; (b) add a narrow lazy `embedQuery(text): Promise<Float32Array>` callback. Make `embedQuery` **optional** with a default that yields no vector — so the ~18 existing `new MemoryService(...)` construction sites (bootstrap, `seed-dev.ts`, and many tests) compile unchanged, and a service constructed without it simply degrades the text-query search to FTS-only (consistent with D9's graceful degradation). The lazy-callback form is preferred because `MemoryService` is constructed (`bootstrap.ts:86`) before `loadEmbedder()` resolves (`bootstrap.ts:149`); pass a closure over a forward-declared mutable `let embedder` (assigned after load) so it resolves at call time without reordering bootstrap.
2. **Async propagation:** `search` returns a `Promise<Memory[]>`. The MCP call site `tools.ts:455` (`const memories = deps.memory.search(...)`, currently NOT awaited) must `await`, and the synchronous `memory.test.ts` search assertions must be updated. The no-query listing branch can early-return (still effectively sync) but the method signature is uniformly async.

- _Alternative considered:_ embed the query in the MCP handler (`handleSearch`) and pass the vector into the service. Rejected — scope resolution and the two-branch fusion belong in the service layer (data-access + scope-at-service invariants); the handler should stay a thin adapter.
- _Alternative considered:_ a 4-class retriever framework (`HybridMemoryRetriever`/`LexicalRetriever`/`DenseRetriever`/`RrfFusion`) modelled on big search engines. Rejected — it has zero precedent in this repo, which keeps fusion-shaped work flat (the direct analog `findSaveTimeCandidates` is one function; `ConsolidationRunner` delegates to functions, not pass-classes). Keep the industry vocabulary in comments/docs; express it as a module function + pure `fuseRRF`.

## Risks / Trade-offs

- [Risk] Large single partition (the global scope) is brute-force: ~36ms at 250k, ~72ms at 500k in-partition → Mitigation: accepted for the realistic personal envelope (≤~100k → ≤~30ms total, dominated by the embed); ANN reopened as a documented future escalation past the low hundreds of thousands (Non-Goals). The spec guarantee is stated as the measured envelope, not a flat sub-10ms.
- [Risk] vec0 migration is bespoke (no RENAME, explicit-column inserts, base-table triggers only) → Mitigation: the exact recipe is pinned in D5/Migration Plan and was verified empirically; a kept integration test asserts post-migration kNN works and status-sync fires.
- [Risk] `similaritySample` calibration self-join is unscoped and would sample retained non-active/stale-space vectors after D6 → Mitigation: scope it to `status='active'` (task added) so the `VEC_THRESHOLD` telemetry stays representative (closes review finding F7).
- [Trade-off] `offset` is no longer exact on the hybrid branch, and beyond the over-fetched fused pool yields empty → Accepted; agents don't paginate semantic results, the listing branch keeps exact pagination, and over-fetch (D2) makes the first page stable. Documented + clamped.
- [Trade-off] Index may store superseded/archived vectors (larger than active-only) → Accepted with a narrower guarantee: superseded vectors preserve semantic recoverability of replaced history; archived rows are lexical-searchable but not guaranteed semantically after model changes. The `status` filter prunes the scan (verified, Round-4 review), so retained non-active vectors do not add meaningful in-partition cost to the active search; pruning `archived` vectors remains an available future lever if a single global partition ever grows pathologically.

**Measured degradation envelope (post-implementation, single global partition = worst case; cost scales with _active_ in-partition rows, not corpus; sharded multi-project stays ~snappy at any total):**

| active in global partition | decent host (Apple M3, RAM-resident)             | budget VPS (slow shared vCPU, 2–3 GB, RAM-starved) |
| -------------------------- | ------------------------------------------------ | -------------------------------------------------- |
| 10k                        | ~16ms total — snappy                             | ~60ms — fine                                       |
| 50k                        | ~22ms — snappy                                   | ~170ms — noticeable                                |
| 100k                       | ~33ms (warm) / ~60ms (constrained) — snappy/fine | ~360ms — sluggish                                  |
| 200k                       | ~78–107ms — fine/noticeable                      | ~560–810ms — sluggish                              |

Embed floor per text query: ~15ms (M3) / ~31ms (slow vCPU), constant in N. **Operational triggers for the `archived`-pruning lever (then ANN):** on a decent host, comfortable to ~100k active-in-global; on a budget VPS, comfortable to ~25–50k. Pull the pruning lever (delete the vec row on archive — cheap, only forfeits semantic recall of _archived_ history) when telemetry (`similaritySample`) or the operator latency spot-check shows the active global partition approaching those thresholds. Decay/supersede keep the active set bounded, so a single-user personal corpus is unlikely to reach them for years; left as a documented lever, not implemented.

- [Risk] Reversing "not on the retrieval hot path" adds ~15ms embed per text query → Mitigation: only on the text-query branch; negligible against LLM round-trips. Listing branch unchanged.
- [Risk] `tag` on dense retrieval is only a bounded post-filter over `rank_window_size` → Mitigation: document the guarantee honestly (no wrong-tag rows; recall bounded by rank window), keep exact tag filtering in FTS, and defer a tag-vector side index until evidence shows it is needed.
- [Risk] Existing tests (`memory.test.ts` raw 2-column `memory_vec` insert; `schema-drift.test.ts` `memory_vec` column snapshot) break after the rebuild → Mitigation: tasks added to update both (closes review finding F9).

## Migration Plan

1. Gate: keep a small **integration test** (not a throwaway) proving on sqlite-vec 0.1.9 that (a) a base-table `AFTER UPDATE OF status ON memory` trigger updates `memory_vec.status`, and (b) the partition + status + type MATCH kNN isolates scope, status, and type with zero leakage. If either fails, revisit D6 before proceeding (closes review finding F12).
2. New migration: rebuild `memory_vec` using the **vec0-specific recipe in D5** (stash → drop → create-at-final-name → explicit-column reinsert; no RENAME, no `SELECT *`). Backfill derives `partition_key` + `status` + `type` from the joined `memory` row; no re-embedding. Define the base-table `status`-sync trigger. Add a corrective header comment in this NEW migration documenting the reversal of the `0002_vec_setup.sql` "consolidation only" note (0002 is immutable — do not edit it) (closes review finding F10).
3. Change `insertEmbedding(memoryId, embedding, partitionKey, status, type)`; extend `findMissingEmbeddings`/`embedNow` to project + supply `partition_key`/`status`/`type`; keep the drain target at `status != 'archived'` (D9). Update the raw `memory_vec` inserts in `memory.test.ts` and the `schema-drift.test.ts` column snapshot.
4. Add `knnByQueryVector` (scoped) + the scoped BM25 ranked-id reader + `fuseRRF` (with over-fetch); wire the hybrid branch through a module-level `hybridSearch` helper (mirroring `findSaveTimeCandidates`); sanitize + fault-isolate the FTS branch (D8); apply `status`/`type` as vector metadata prefilters and `tag` as an exact FTS filter plus bounded dense post-filter; scope `similaritySample` to `status='active'`.
5. Update `openspec/specs/memory/spec.md`: ADD the hybrid-search and vector-index requirements; MODIFY "Embeddings MUST be computed in-process" (vectors now also back search; `memory_vec` carries partition key + status + type) and "Stale vectors MUST be re-embedded after a model change" (explicitly covers active + superseded vectors, while archived remains lexical-only for search after model changes) so the canonical spec holds no stale lexical-only / candidate-detection-only framing (closes review finding F6).
6. **Rollback:** additive at the query layer — reverting the service to the FTS-only branch restores prior behavior without a data migration. The rebuilt `memory_vec` is backward-compatible with the old `knnByCosine` self-join (verified), so a code-only rollback is safe; a full schema rollback would rebuild `memory_vec` back to the 2-column form via the same vec0 recipe.

## Open Questions

- Exact rank-window margin and ceiling for the hybrid branch — start at `rank_window_size = min(limit + offset + 30, 400)`, revisit if recall telemetry suggests otherwise.
- ~~Does the vec0 `status` metadata filter reduce the in-partition _scan_ or only filter results post-scan?~~ **Answered (Round-4 review, empirical on 0.1.9): it PRUNES the scan** — a partition with few active rows is measurably faster than the unfiltered partition, so retained superseded/archived vectors do NOT add meaningful scan cost to the active scoped search. D6's "size irrelevant for the active scoped search" therefore holds; pruning `archived` vectors stays a documented _future_ lever, not a required one.
- Should the fast `MATCH` path also replace `knnByCosine` in save-time candidate detection within this change, or a follow-up? Leaning follow-up to keep this change focused; it's cheap and removes the latent save-time O(n).
- RRF constant: start at `rank_constant = 60` (common RRF default); revisit only if calibration telemetry suggests otherwise.
- If dense+tag recall matters in practice, design a tag prefilter side index or tag-expanded vector table as a separate OpenSpec change instead of widening this change silently.
