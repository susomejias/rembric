# Embeddings architecture

The semantic engine is in-process and part of the binary: `gte-multilingual-base` (Apache 2.0), ONNX q8, 768 dims, cls pooling, normalized output, pinned revision. No external services, no API keys, no runtime downloads, no configuration — the engine is code. Four flows cover everything.

## 1. Image build (once, at `docker build`)

The only place that ever touches the network for model artifacts.

```
Dockerfile (builder / dev stage)
   │
   ▼
packages/core/scripts/fetch-model.mjs
   │
   ├─ phase 1  download @ pinned revision into a throwaway cache
   │           (transient 429/5xx retried with backoff; the optional
   │           hf_token build secret authenticates on rate-limited CI)
   ├─ phase 2  flatten to the local-model layout transformers.js
   │           resolves offline:
   │           /models/onnx-community/gte-multilingual-base/{config,tokenizer,onnx/…}
   └─ phase 3  fresh process, networking DISABLED:
               load the flattened files + embed a fixed trio
               → assert dims + similarity bounds
               ✗ drift/corruption → the IMAGE BUILD FAILS
               ✓ → COPY /models → /app/models
```

CI prefetches the same artifact with a cache keyed on `packages/core/scripts/fetch-model.mjs` + `packages/core/src/embeddings/embedder.ts`, and runs the script from `packages/core` in both the `test` and `retrieval-eval` jobs — the script lives with the package that owns its `@huggingface/transformers` dependency.

Why phase 3 runs in a fresh process: it exercises exactly the resolution path the runtime uses, so "builds green" implies "boots green".

## 2. Boot (every start) — the model loads lazily, on first use

```
apps/web/src/instrumentation.ts (register() → lib/process.ts)
   │
   ├─ assertDataLossGuard, counts banner, state-marker refresh
   ├─ bootstrapAdminToken, session reaper
   ├─ startEmbeddingDrain        ← no model load; skips while no row is pending
   └─ startEntityBackfill        ← unrelated, owns its own identity marker
```

The embedder is load-on-first-use (`apps/web/src/lib/services.ts::getEmbedder`).
An idle boot that needs no embedding never loads it; the first caller that needs
a vector — a save, a search query, or a drain tick with a pending row — triggers:

```
loadEmbedder()                                ← packages/core/src/embeddings/embedder.ts
   /app/models present (image) → offline, ~1.1 s
   absent (bare-metal dev)     → one-time pinned download
   ✗ load fails → the caller degrades (save/search fall back to FTS5), the
                  drain retries on a later tick; the boot does NOT abort
   │
   └─ resetVectorModelOnLoad(repos, dataDir)  ← apps/web/src/lib/services.ts
        runs ONCE after the first load resolves, before the first vector
        ensureVectorModel(repos, dataDir)     ← packages/core/src/embeddings/state.ts
          reads embedding-state.json (model-identity marker)
          ├─ matches the compiled-in model, settled → no-op
          └─ differs/absent/pending → mark pending
                                      → wipe memory_vec (derived data)
                                      → settle the marker
             «marker trouble never blocks the server. Fails before the
              wipe → index untouched. Fails after → index already
              emptied; either way the reset is re-checked on the next load»
             «a pre-upgrade DB self-migrates; flow 3 refills it»
```

## 3. Background drain (every 30 s)

Fills vectors for rows that don't have one — backfills after a marker
wipe, and retries rows whose inline embedding failed.

```
worker.processBatch()                       ← packages/core/src/services/embedding-worker.ts
   │
   ├─ SELECT memories without a vector (LIMIT 25)
   │     ├─ none → if the queue JUST drained → onDrained()
   │     │           └─ logSimilarityDistribution()
   │     │              «nearest-neighbor p50/p90/max telemetry —
   │     │               sanity-checks VEC_THRESHOLD against real data»
   │     └─ rows → embedder.embed(content) → INSERT INTO memory_vec
   │
   └─ a failing row is skipped and retried next tick
        «resumable by construction: the SELECT always finds what's left»
```

## 4. Save path (the hot path)

```
memory.save (MCP)                            ← packages/mcp/src/memory-tools.ts
   │
   ├─ insert the memory row (append-only, unchanged)
   │
   ├─ embedNow(id, content)                  ← worker, ~15 ms
   │     embeds inline so the NEW row has a vector BEFORE detection —
   │     without this, vec candidates can never fire (a brand-new row
   │     otherwise has no embedding until the next drain tick).
   │     ✗ inference error → logged, save proceeds, drain retries
   │
   ├─ findSaveTimeCandidates()               ← packages/core/src/services/save-time-candidates.ts
   │     ├─ vec pass  cosine kNN over memory_vec   (≥ VEC_THRESHOLD 0.70)
   │     ├─ FTS5 pass BM25 lexical                 (the saving project's own index; first 16
   │     │                                          tokens, minus any token found in
   │     │                                          ≥ COMMON_TERM_DOCUMENT_RATIO 0.5 of the
   │     │                                          project's rows;
   │     │                                          top-poolSize by rank, then kept only if
   │     │                                          token containment ≥ LEXICAL_CANDIDATE_FLOOR
   │     │                                          0.60; reported similarity = that containment)
   │     ├─ entity pass shared rare identifier     (rarity-gated; no text-overlap floor)
   │     ├─ dedupe by target, rank (entity first, then similarity)
   │     ├─ cosine by id for merged targets the vec pass did not return
   │     │                                         (only when the vec pass returned rows)
   │     ├─ classifyCandidateBand() per pair       low / middle / high, see below
   │     └─ cap CANDIDATES_PER_SAVE_MAX on middle+high; low capped separately
   │
   └─ response: candidates[] (middle+high, pending) → memory.judge_batch
                convergeWith[] (high: judgmentIds, advisory) → memory.merge or supersedes
                related[] (low: no row, no judgmentId) → context only
```

The two passes are complementary by design: FTS5 anchors on stable
identifiers (paths, function names, commands); vec catches paraphrase and
cross-language matches (an ES save finds its EN duplicates with zero
lexical overlap). A pair missed by one is routinely caught by the other.

## Failure modes, summarized

| Failure                            | Behavior                                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| Model missing/corrupt on first use | The calling operation degrades to FTS5, the drain retries the load; the boot never aborts |
| Single inference error at save     | Save succeeds, FTS-only detection for that save, drain retries                            |
| Single inference error in drain    | Row skipped, retried next tick                                                            |
| Model artifact drift at build      | Image build fails (phase-3 validation)                                                    |
| HF rate limit (429) at build       | Retried with backoff; `hf_token` build secret authenticates                               |
| Model changed between versions     | Marker mismatch at first load → vectors wiped → drain re-embeds                           |
| Data dir unwritable at reset       | Boot proceeds, index untouched, reset retried next boot                                   |
| Reset interrupted after wipe       | Marker stays `pending`, index empty, drain refills; next boot may re-wipe                 |
| Reset owed but not done            | `memory.doctor` warns; dense results unreliable until a load settles it                   |

## Engine constants (not configuration)

| Constant                     | Value                                                           | Lives in                                             |
| ---------------------------- | --------------------------------------------------------------- | ---------------------------------------------------- |
| Model + revision             | `onnx-community/gte-multilingual-base@2edbf5e`                  | `packages/core/src/embeddings/model-identity.json`   |
| Quantization / dims          | q8 / 768 (matches `memory_vec FLOAT[768]`)                      | `packages/core/src/embeddings/model-identity.json`   |
| `VEC_THRESHOLD`              | 0.70 (calibrated 2026-06-05; telemetry on every drain)          | `packages/core/src/services/save-time-candidates.ts` |
| `LEXICAL_CANDIDATE_FLOOR`    | 0.60 (save-time sweep, `pnpm run eval:save-time`)               | `packages/core/src/services/save-time-candidates.ts` |
| `COMMON_TERM_DOCUMENT_RATIO` | 0.5 (where FTS5's bm25 stops weighting a term; save and search) | `packages/core/src/services/save-time-candidates.ts` |
| `CANDIDATE_LOW_BAND_CEILING` | 0.75 (per-band verdict rates, issue #467)                       | `packages/core/src/services/save-time-candidates.ts` |
| `CANDIDATE_HIGH_BAND_FLOOR`  | 0.85 (per-band verdict rates, issue #467)                       | `packages/core/src/services/save-time-candidates.ts` |

The lexical pass never thresholds raw bm25: bm25 is unbounded and depends on
corpus size, so no fixed floor over it is stable. bm25 only orders the pool
(`ORDER BY bm25(…) LIMIT poolSize`). Admission then takes a floor,
`LEXICAL_CANDIDATE_FLOOR`, over the reported `similarity`: the share of the
saved text's distinct terms that the candidate also contains. That measure is
unweighted and corpus-independent, so a value calibrated on the committed
save-time fixture holds in every deployment. Below it, a lexical match takes no
slot and writes no pending judgment. Without it, one shared common word was
enough to fill the per-save cap. The entity pass has no such floor on purpose:
it exists for contradictions that share an identifier but little wording.

The lexical pass reads a per-project index, `memory_fts_p_<hex project id>`.
That is an FTS5 table holding only the saving project's memories. Interactive
search keeps using the global `memory_fts`. Each project's index is maintained
by three triggers routed by `WHEN project_id = …`, created when the project is
created. At boot, a reconciler builds any that are missing, rebuilds any whose
DDL drifted, and drops those of deleted projects. So neither the statement nor
its statistics read touches another project's postings. bm25's inverse
document frequencies are computed over the saving project alone.

Before ranking, the lexical pass drops each of its 16 tokens that appears in at
least half of the project's memories (`COMMON_TERM_DOCUMENT_RATIO`), using the
index's own vocabulary and the project's row count. FTS5 already weights such a
term at a constant `1e-6`, so dropping it barely moves the order, but keeping
it made FTS5 rank every row that holds it. A token FTS5 matches as a phrase
(`two-space`, a file path) is never dropped. When no remaining token could match
another memory, nothing is dropped at all.

Interactive `memory.search` (and `/api/<slug>/memory/recall`) applies the same
rule to its lexical branch, against the global `memory_fts` it scans: a query
token found in at least half of all memories leaves the `MATCH`, and when no
remaining token matches any memory the whole query is kept. Because the counts
cover every project while the search is scoped and filtered, a shortened `MATCH`
that finds nothing is run again in full, so the lexical branch never comes back
empty where the whole query would have matched. The counts come from
the same read the relevance gate already makes, now carrying each token as well
as the whole query, so a search reads term statistics once. The dashboard's
memory search is unchanged.

### Cost and supported scale of the per-project index

Measured at 50 000 memories, generator / realistic corpus. The files are under
`openspec/changes/scope-save-time-lexical-index-per-project/measurements/`.

- **Save:** with the saving project at 2% of the rows, the save-time statement
  stays under 0.1 ms / 0.3 ms from 1 000 to 50 000 rows (`options.txt`). End to
  end, without the embedder, the `memory.save` p50 went from 21.13 to 8.92 ms and
  from 7.46 to 1.54 ms (`save-latency-impl.txt`).
- **Storage:** the per-project indexes together are about as large as
  `memory_fts`, +32.8 MB / +10.6 MB, so the lexical index storage roughly
  doubles.
- **Upgrade:** the first boot after upgrading builds every project's index
  before serving, 0.80 s / 0.23 s, and grows the WAL by 34.5 MB / 10.7 MB.
  The boot log reports it as `project lexical indexes: built N, dropped M (T ms)`.
- **Writes and number of projects:** there is no cap. Each project adds nine
  schema objects and one `WHEN` check per insert (`write-cost.txt`):

  | projects              | insert (in a transaction) | connection open |
  | --------------------- | ------------------------- | --------------- |
  | 0 (before this index) | 0.031 / 0.015 ms          | 0.22 ms         |
  | 6                     | 0.077 / 0.042 ms          | 0.36 ms         |
  | 200                   | 0.102 / 0.073 ms          | 4.15 ms         |
  | 1 000                 | 0.325 / 0.272 ms          | 42.63 ms        |

- **Rollback to a release without this index:** the triggers keep maintaining
  tables nothing reads. This is harmless, but it costs writes. To remove them,
  with the server stopped, drop every `memory_fts_p_%` object, triggers first:

  ```sql
  SELECT 'DROP TRIGGER ' || name || ';' FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'memory_fts_p_%';
  SELECT 'DROP TABLE '   || name || ';' FROM sqlite_master WHERE type = 'table'   AND name GLOB 'memory_fts_p_[0-9a-f]*' AND name NOT GLOB '*_data' AND name NOT GLOB '*_idx' AND name NOT GLOB '*_docsize' AND name NOT GLOB '*_config';
  SELECT 'DROP VIEW '    || name || ';' FROM sqlite_master WHERE type = 'view'    AND name LIKE 'memory_fts_p_%';
  ```

  Run the statements these queries print.

Every admitted pair then gets a confidence band from `classifyCandidateBand`,
which uses the pair's exact cosine and the channels that admitted it:

- **High:** cosine ≥ `CANDIDATE_HIGH_BAND_FLOOR`. The pair is still a pending
  candidate; `convergeWith[]` also lists its `judgmentId` as an advisory steer,
  because the two memories likely state the same fact.
- **Low:** admitted only by the vec pass with cosine below
  `CANDIDATE_LOW_BAND_CEILING`, or only by a shared entity with a known cosine
  below `VEC_THRESHOLD`. No pending row; the pair is returned in `related[]` and
  takes no candidate slot.
- **Middle:** everything else, including a lexically admitted pair and an
  entity-only pair whose cosine is unknown because a vector is missing.

The thresholds come from per-band verdict rates on one real installation: 72%
of judged pairs at cosine ≥ 0.85 were `supersedes` or `conflicts_with`, against
3% at 0.70–0.75 and 1% for shared-entity-only pairs below 0.70. The committed
sweep's band section shows the effect on the synthetic fixture; it does not
calibrate the values.

Changing any of these is an architectural change (OpenSpec), not tuning.
