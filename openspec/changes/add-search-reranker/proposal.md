## Why

`memory.search` and the relevance channel of `memory.context` order results by fused rank position and a term-coverage level; nothing reads the query against a candidate's text, so the memory that answers the question often sits behind memories that only share its vocabulary. Measured on a private corpus that is not committed, with blind relevance grading, a small cross-encoder reading the top 10 candidates raised nDCG@8 from 0.63 to 0.78–0.80 and put a useful memory first noticeably more often.

## What Changes

- Add a cross-encoder reranking step to the text-query branch: the first 10 rows of the fused pool, each read as `title + content` truncated to 192 tokens, are scored by `hindsight-ai/hs-rerank-1` and ordered by `rerankScore × boost`. The existing recency/confirmation/type boost stays.
- Reranking is requested per calling surface: `memory.search` and the ranked pass of `memory.context` request it; the per-turn recall endpoint, file-anchored recall and save-time candidate detection do not.
- On the reranked path the relative-level filter no longer thins the rerank window and `gateShortened` is not reported; the abstention floor and the empty-pool verdict are unchanged and run before any inference. The cross-encoder score is not used as an abstention gate.
- Run reranker inference, tokenization included, in one dedicated worker thread, with a per-call deadline that falls back to the unreranked response. No worker pool.
- One operator setting disables reranking for the whole server (no model loaded).
- Bake the reranker model into the Docker image with a pinned identity, and restate the documented hardware requirements from measurement. **BREAKING** (documented contract): the hardware floor rises for servers that keep reranking enabled, and the README's "≤800 MB total process RSS" class is replaced by a measured budget.
- **BREAKING** (HTTP contract wording): `POST /api/<slug>/memory/recall` no longer promises an order identical to `memory.search`; it returns the unreranked order.
- Add a reranked retriever to the retrieval evaluation harness, gated against the unreranked one.

Invariants: append-only memory, scope-at-service, `topic_key` convergence and fresh-context judgment are untouched. Reranking reorders rows the scoped search already returned and never widens them; the server still makes no relation or lifecycle decision from a model's output.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `memory`: the text-query branch gains an optional cross-encoder rerank of the fused pool's head; the post-fusion multiplier's left operand becomes the rerank score on that path; the relative filter is not applied to the rerank window; reranker inference runs in a worker thread under a deadline.
- `http-api`: the per-turn recall endpoint returns the unreranked order and never runs the reranker.
- `open-source-distribution`: the image bundles the reranker model; the README hardware requirement is restated from measurement with a reranking-disabled minimum.
- `retrieval-evaluation`: the harness evaluates the reranked path as its own retriever with a rank-sensitive metric and a latency series.

## Impact

- **New**: `packages/core/src/rerank/` (`reranker.ts` loader and identity, `rerank-worker.ts` worker entry, `rerank-client.ts` queue + deadline + fallback, `model-identity.json`), their co-located tests.
- **Changed**: `packages/core/src/services/hybrid-search.ts` (rerank window, score operand, gate split), `packages/core/src/services/memory.ts` (`searchWithAbstention` option), `packages/mcp/src/memory-tools.ts` (`memory.search`, `handleContext` request reranking), `apps/web/src/lib/services.ts` (worker lifecycle, warm-up, env switch), `packages/core/scripts/fetch-model.mjs` and `Dockerfile` (bake the second model), `apps/web/src/test/invariants.test.ts` (Dockerfile bake gate for the new artifact), `packages/core/src/test-support/retrieval/` (reranked retriever, long-memory corpus items, rank-sensitive metric, baseline).
- **Docs**: `README.md` hardware section, `docs/embeddings.md`, `.env.example`.
- **Dependencies**: none added; `@huggingface/transformers` already ships the sequence-classification path. Next.js must bundle or externalize the worker entry.
- **Ordering**: lands after `swap-embedding-model`. With the current embedding model the two models together peaked near 2.9 GB resident in measurement; with the replacement they peaked near 1.8 GB.
- **Overlap**: `prune-common-terms-from-search-match` also modifies "Recall MUST be able to return nothing"; whichever archives second rebases its delta.
