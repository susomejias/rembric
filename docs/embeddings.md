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
   │     ├─ FTS5 pass BM25 lexical                 (top-poolSize by rank; reported
   │     │                                          similarity = token containment)
   │     └─ dedupe by target, higher score wins, cap CANDIDATES_PER_SAVE_MAX
   │
   └─ response: candidates[] → the agent closes each with memory.judge
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

| Constant            | Value                                                  | Lives in                                             |
| ------------------- | ------------------------------------------------------ | ---------------------------------------------------- |
| Model + revision    | `onnx-community/gte-multilingual-base@2edbf5e`         | `packages/core/src/embeddings/model-identity.json`   |
| Quantization / dims | q8 / 768 (matches `memory_vec FLOAT[768]`)             | `packages/core/src/embeddings/model-identity.json`   |
| `VEC_THRESHOLD`     | 0.70 (calibrated 2026-06-05; telemetry on every drain) | `packages/core/src/services/save-time-candidates.ts` |

The lexical pass has no equivalent absolute threshold: bm25 is unbounded and
corpus-size dependent, so no fixed floor over it is stable. Admission is by
rank position within the pool instead (the `ORDER BY rank LIMIT poolSize`
SQL query already computes this); the reported `similarity` is a separate,
bounded (`0..1`) token-containment measure — see `fix-retrieval-ranking-math`.

Changing any of these is an architectural change (OpenSpec), not tuning.
