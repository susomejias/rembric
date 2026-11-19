## Why

The embedding model is the largest resident cost of the server and the slowest step of every save: measured on a private corpus, `onnx-community/gte-multilingual-base` peaked at about 2.1 GB resident and took 42 ms at the median and 349 ms at p95 to embed one memory. `hindsight-ai/hs-embed-1` (384 dimensions) peaked at about 1.27 GB and took 10 ms / 78 ms on the same memories, with retrieval quality that was not lower (nDCG@8 0.67 vs 0.63, 95% CI of the difference −0.006 to +0.091). The saving is what makes room for a reranker within the same host class.

## What Changes

- **BREAKING** (persisted derived data): replace the compiled-in embedding model with `hindsight-ai/hs-embed-1` (384 dims, mean pooling, no query/document prefix). A migration recreates `memory_vec` at `FLOAT[384]` without copying vectors; the existing identity reset and background drain re-embed every non-archived memory. No `memory` row is touched.
- Re-derive every constant calibrated against cosine similarity on the new model, from committed runs: the save-time dense admission threshold, the confidence band boundaries, and the enabled relative-level ratio.
- Regenerate the retrieval evaluation baselines on the new model; floors may not drop.
- Bake the new model into the Docker image in place of the old one.

Invariants: append-only memory holds (`memory_vec` is derived data and is rebuilt, never the source rows). Scope-at-service, `topic_key` convergence and fresh-context judgment are untouched; save-time candidates stay agent-judged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `memory`: the embedding model identity and dimension change; a model change must rebuild the vector index at the new dimension and re-derive every cosine-calibrated constant.
- `persistence`: `memory_vec` is `FLOAT[384]` and the embedder named in the sync requirement changes.
- `open-source-distribution`: the image bundles the new embedding model.

## Impact

- **Changed**: `packages/core/src/embeddings/model-identity.json` (id, revision, dims, artifact, dtype), `packages/core/src/embeddings/embedder.ts` (pooling `mean`, dtype, dimension comment), `packages/db/src/schema/` and a new migration under `packages/db/src/migrations/` (recreate `memory_vec`), `packages/core/src/services/save-time-candidates.ts` (`VEC_THRESHOLD`, band constants), `packages/core/src/services/hybrid-search.ts` (`RELATIVE_LEVEL_RATIO`), `packages/core/scripts/fetch-model.mjs`, `Dockerfile`, `apps/web/src/test/invariants.test.ts`, test embedders and fixtures that assume 768 dims (`packages/core/src/test-support/embedder.ts`, `apps/web/src/test/embedder.ts`), `packages/core/src/test-support/retrieval/baselines/*.json`.
- **Docs**: `docs/embeddings.md`, `README.md`.
- **Operators**: the first boot after upgrade re-embeds the corpus in the background (roughly 35 memories per second in measurement); search degrades to lexical for rows not yet re-embedded. Rolling back to the previous image re-embeds again.
- **Prerequisite**: `lazy-embedding-load-identity-check` must be archived first. It replaces the requirement that names the model literal, so this change adds its delta for that requirement only once the new header is published.
