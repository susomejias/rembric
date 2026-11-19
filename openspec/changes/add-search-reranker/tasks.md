## 1. Prerequisites

- [x] 1.1 Confirm `swap-embedding-model` is merged; record in this file the commit that holds it
- [ ] 1.2 Rebase the `memory` delta of this change if `prune-common-terms-from-search-match` archived first, so `pnpm run check:delta-freshness` passes

## 2. Reranker model and identity

- [x] 2.1 Add `packages/core/src/rerank/model-identity.json` (model id, revision, ONNX artifact) and `reranker.ts` exposing `loadReranker()` and `score(query, documents)` returning one logistic score per document, truncating each pair to `RERANK_MAX_TOKENS`; `pnpm vitest run packages/core/src/rerank/reranker.test.ts` passes with a relevant document scoring above an irrelevant one for an English and a Spanish query
- [x] 2.2 Declare `RERANK_WINDOW`, `RERANK_MAX_TOKENS` and `RERANK_DEADLINE_MS` once in the rerank module; add a test asserting none is read from the environment or reachable from an MCP input schema
- [x] 2.3 Extend `packages/core/scripts/fetch-model.mjs` and the `Dockerfile` to bake the reranker artifacts and tokenizer at the pinned revision; extend the Dockerfile bake-gate invariant in `apps/web/src/test/invariants.test.ts` to the derived reranker artifact path

## 3. Worker thread

- [x] 3.1 Add `rerank-worker.ts` (owns tokenizer and model, serves one request at a time) and `rerank-client.ts` (queue, per-call deadline, late-result discard, bounded restart)
- [x] 3.2 Test with a fake worker: a call past its deadline resolves to the fallback signal, and its late result changes nothing
- [x] 3.3 Test with a fake worker: a worker that exits is restarted, and restarts stop after the bound
- [x] 3.4 Wire the client in `apps/web/src/lib/services.ts`: start and warm the worker outside any request, honour `REMBRIC_RERANK=off` (no worker, no model), document the setting in `.env.example`
- [ ] 3.5 Prove the worker starts from the built Next.js standalone output: build, start the standalone server, run one eligible `memory.search`, and record the observed log line

## 4. Search pipeline

- [x] 4.1 RED: add tests in `packages/core/src/services/hybrid-search.test.ts` for the reranked path with a fake scorer: window is the first `RERANK_WINDOW` fused rows; order is `rerankScore × boost`; relative filter not applied and `gateShortened` absent; floor and empty-pool verdicts unchanged and no scorer call when abstaining; non-zero `offset` or `limit > RERANK_WINDOW` served unreranked; fallback returns the same ids as the unreranked call
- [x] 4.2 Implement the rerank step in `hybridSearch` behind a `rerank` option of `HybridSearchOpts`, reusing the fused pool for the fallback so no second retrieval runs
- [x] 4.3 Add one test proving a call without the option returns exactly the ids it returned before this change, for every existing branch the change touches (text query with gates, entity branch, no-query listing)
- [x] 4.4 Mutation check each new condition with `node scripts/mutate.mjs` (eligibility on offset, eligibility on limit, gate split, fallback) and confirm the test naming it goes red

## 5. Calling surfaces

- [x] 5.1 Pass the option from `memory.search` and from the ranked pass of `handleContext` in `packages/mcp/src/memory-tools.ts`
- [x] 5.2 Test that `POST /api/<slug>/memory/recall`, file recall and save-time candidate detection never invoke the scorer
- [x] 5.3 Count fallbacks per cause and reranked calls (`RerankClient.stats()`) and log each fallback's cause once per cause per minute

## 6. Evaluation and measurement

- [x] 6.1 Add long-memory corpus items whose answering text begins beyond `RERANK_MAX_TOKENS`, with queries for them
- [x] 6.2 Add a rank-sensitive metric (nDCG@k) to `scoring.ts` with tests
- [x] 6.3 Add the `reranked` retriever to `retrievers/index.ts`, commit its baseline, and make `pnpm run eval` fail when a gated metric of it falls below the unreranked hybrid retriever's at the same `k`
- [ ] 6.4 OPERATOR: on the published image for each architecture, record process RSS with reranking on and off under a recorded workload, and end-to-end `memory.search` latency at 1, 4 and 8 simultaneous calls; adjust `RERANK_DEADLINE_MS` from those numbers and record them in this file
- [ ] 6.5 If 6.4 shows total RSS above the 2.5 GB class with reranking on, stop and report before changing any constant

## 7. Docs

- [ ] 7.1 Update `README.md` hardware section with the measured minimum (reranking off) and recommendation (reranking on) from 6.4
- [x] 7.2 Update `docs/embeddings.md` with the rerank flow, the worker, the deadline fallback and the switch

## 8. Verification

- [ ] 8.1 `pnpm run typecheck`, `pnpm run lint`, `pnpm test` pass
- [ ] 8.2 `openspec validate add-search-reranker --strict`, `pnpm run check:delta-freshness`, `pnpm run check:delta-sections`, `pnpm run check:spec-crossrefs` pass
- [ ] 8.3 Run the `rembric-smoke-tests` playbook against the local dev server: one reranked `memory.search`, one `memory.context` with `focus`, one recall call
