# Embeddings architecture

The semantic engine is in-process and part of the binary: `gte-multilingual-base` (Apache 2.0), ONNX q8, 768 dims, cls pooling, normalized output, pinned revision. No external services, no API keys, no runtime downloads, no configuration — the engine is code. Four flows cover everything.

## 1. Image build (once, at `docker build`)

The only place that ever touches the network for model artifacts.

```
Dockerfile (builder / dev stage)
   │
   ▼
scripts/fetch-model.mjs
   │
   ├─ phase 1  download @ pinned revision into a throwaway cache
   ├─ phase 2  flatten to the local-model layout transformers.js
   │           resolves offline:
   │           /models/onnx-community/gte-multilingual-base/{config,tokenizer,onnx/…}
   └─ phase 3  fresh process, networking DISABLED:
               load the flattened files + embed a fixed trio
               → assert dims + similarity bounds
               ✗ drift/corruption → the IMAGE BUILD FAILS
               ✓ → COPY /models → /app/models
```

Why phase 3 runs in a fresh process: it exercises exactly the resolution path the runtime uses, so "builds green" implies "boots green".

## 2. Boot (every start)

```
bootstrap.ts
   │
   ├─ await loadEmbedder()                  ← embeddings/embedder.ts
   │     /app/models present (image) → offline, ~1.1 s
   │     absent (bare-metal dev)     → one-time pinned download
   │     ✗ load fails → BOOT ABORTS (fail fast — no degraded mode;
   │                     a listening server ALWAYS has a warm model)
   │
   ├─ ensureVectorModel(db, dataDir)        ← embeddings/state.ts
   │     reads embedding-state.json (model-identity marker)
   │     ├─ matches the compiled-in model → no-op
   │     └─ differs/absent → wipe memory_vec (derived data)
   │                          + write new marker
   │        «a pre-upgrade DB self-migrates; flow 3 refills it»
   │
   ├─ new EmbeddingWorker({ db, embedder })
   └─ setInterval(drain tick, 30 s)
```

## 3. Background drain (every 30 s)

Fills vectors for rows that don't have one — backfills after a marker
wipe, and retries rows whose inline embedding failed.

```
worker.processBatch()                       ← services/embedding-worker.ts
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
memory.save (MCP)                            ← mcp/tools.ts
   │
   ├─ insert the memory row (append-only, unchanged)
   │
   ├─ embedNow(id, content)                  ← worker, ~15 ms
   │     embeds inline so the NEW row has a vector BEFORE detection —
   │     without this, vec candidates can never fire (a brand-new row
   │     otherwise has no embedding until the next drain tick).
   │     ✗ inference error → logged, save proceeds, drain retries
   │
   ├─ findSaveTimeCandidates()               ← services/save-time-candidates.ts
   │     ├─ vec pass  cosine kNN over memory_vec   (≥ VEC_THRESHOLD 0.70)
   │     ├─ FTS5 pass BM25 lexical                 (≥ FTS_THRESHOLD 0.4)
   │     └─ dedupe by target, higher score wins, cap CANDIDATES_PER_SAVE_MAX
   │
   └─ response: candidates[] → the agent closes each with memory.judge
```

The two passes are complementary by design: FTS5 anchors on stable
identifiers (paths, function names, commands); vec catches paraphrase and
cross-language matches (an ES save finds its EN duplicates with zero
lexical overlap). A pair missed by one is routinely caught by the other.

## Failure modes, summarized

| Failure                         | Behavior                                                       |
| ------------------------------- | -------------------------------------------------------------- |
| Model missing/corrupt at boot   | Boot aborts, non-zero exit, healthcheck never goes green       |
| Single inference error at save  | Save succeeds, FTS-only detection for that save, drain retries |
| Single inference error in drain | Row skipped, retried next tick                                 |
| Model artifact drift at build   | Image build fails (phase-3 validation)                         |
| Model changed between versions  | Marker mismatch → vectors wiped once → drain re-embeds         |

## Engine constants (not configuration)

| Constant            | Value                                                    | Lives in                           |
| ------------------- | -------------------------------------------------------- | ---------------------------------- |
| Model + revision    | `onnx-community/gte-multilingual-base@2edbf5e`           | `embeddings/embedder.ts`           |
| Quantization / dims | q8 / 768 (matches `memory_vec FLOAT[768]`)               | `embeddings/embedder.ts`           |
| `VEC_THRESHOLD`     | 0.70 (calibrated 2026-06-05; telemetry on every drain)   | `services/save-time-candidates.ts` |
| `FTS_THRESHOLD`     | 0.4 (BM25 proxy `1/(1+\|rank\|)`, corpus-size sensitive) | `services/save-time-candidates.ts` |

Changing any of these is an architectural change (OpenSpec), not tuning.
