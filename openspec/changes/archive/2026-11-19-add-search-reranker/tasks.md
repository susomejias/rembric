## 1. Prerequisites

- [x] 1.1 Confirm `swap-embedding-model` is merged; record in this file the commit that holds it
- [x] 1.2 Rebase the `memory` delta of this change if `prune-common-terms-from-search-match` archived first, so `pnpm run check:delta-freshness` passes — not needed: `prune-common-terms-from-search-match` is still unarchived, and `check:delta-freshness` passes

## 2. Reranker model and identity

- [x] 2.1 Add `packages/core/src/rerank/model-identity.json` (model id, revision, ONNX artifact) and `reranker.ts` exposing `loadReranker()` and `score(query, documents)` returning one logistic score per document, truncating each pair to `RERANK_MAX_TOKENS`; `pnpm vitest run packages/core/src/rerank/reranker.test.ts` passes with a relevant document scoring above an irrelevant one for an English and a Spanish query
- [x] 2.2 Declare `RERANK_WINDOW`, `RERANK_MAX_TOKENS` and `RERANK_DEADLINE_MS` once in the rerank module; add a test asserting none is read from the environment or reachable from an MCP input schema
- [x] 2.3 Extend `packages/core/scripts/fetch-model.mjs` and the `Dockerfile` to bake the reranker artifacts and tokenizer at the pinned revision; extend the Dockerfile bake-gate invariant in `apps/web/src/test/invariants.test.ts` to the derived reranker artifact path

## 3. Worker thread

- [x] 3.1 Add `rerank-worker.ts` (owns tokenizer and model, serves one request at a time) and `rerank-client.ts` (queue, per-call deadline, late-result discard, bounded restart)
- [x] 3.2 Test with a fake worker: a call past its deadline resolves to the fallback signal, and its late result changes nothing
- [x] 3.3 Test with a fake worker: a worker that exits is restarted, and restarts stop after the bound
- [x] 3.4 Wire the client in `apps/web/src/lib/services.ts`: start and warm the worker outside any request, with no setting that turns reranking off (owner decision, 2026-11-19)
- [x] 3.5 Prove the worker starts from the built Next.js standalone output: build, start the standalone server, run one eligible `memory.search`, and record the observed log line
- [x] 3.6 Calibrate from the boot timing of one full window: a window that misses the deadline stands the reranker down (worker exits, later calls fall back at once); otherwise a call that could not clear the in-flight queue within the deadline falls back without being queued. Test both with a fake worker, and that nothing is refused before calibration (owner decision, 2026-11-19: no hardware-picked window or token cap)
- [x] 3.7 While stood down, load and time a full window again every 15 minutes, keeping the reranker once a window fits; test that it re-times after the interval, keeps it, and stops when it can no longer start
- [x] 3.8 Restore `REMBRIC_RERANK=off` (owner decision, 2026-11-19, reversing 3.4 for hosts shared with other workloads): no reranker is created, `warmReranker` logs and returns; test the switch and that it is the only environment read reaching reranking

## 4. Search pipeline

- [x] 4.1 RED: add tests in `packages/core/src/services/hybrid-search.test.ts` for the reranked path with a fake scorer: window is the first `RERANK_WINDOW` fused rows; order is `rerankScore × boost`; relative filter not applied and `gateShortened` absent; floor and empty-pool verdicts unchanged and no scorer call when abstaining; non-zero `offset` or `limit > RERANK_WINDOW` served unreranked; fallback returns the same ids as the unreranked call
- [x] 4.2 Implement the rerank step in `hybridSearch` behind a `rerank` option of `HybridSearchOpts`, reusing the fused pool for the fallback so no second retrieval runs
- [x] 4.3 Add one test proving a call without the option returns exactly the ids it returned before this change, for every existing branch the change touches (text query with gates, entity branch, no-query listing)
- [x] 4.4 Mutation check each new condition with `node scripts/mutate.mjs` (eligibility on offset, eligibility on limit, gate split, fallback) and confirm the test naming it goes red
- [x] 4.5 Build the rerank window by interleaving the dense and lexical ranked lists instead of cutting the fused head, so a row only the dense retriever found reaches the model; test with a dense-only target crowded out of the fused head, and unit-test the interleaving (alternation, repeats, a short branch, the size bound)
- [x] 4.6 Reserve `RERANK_DENSE_SLOTS` (8) of the window for the dense list, the rest for the lexical list, after measuring 5/5, 6/4, 7/3, 8/2, 9/1 and 10/0 on a private production corpus; test a dense row ranked below an even split reaching the window, and unit-test `rerankCandidates`

## 5. Calling surfaces

- [x] 5.1 Pass the option from `memory.search` and from the ranked pass of `handleContext` in `packages/mcp/src/memory-tools.ts`
- [x] 5.2 Test that `POST /api/<slug>/memory/recall`, file recall and save-time candidate detection never invoke the scorer
- [x] 5.3 Count fallbacks per cause and reranked calls (`RerankClient.stats()`) and log each fallback's cause once per cause per minute

## 6. Evaluation and measurement

- [x] 6.1 Add long-memory corpus items whose answering text begins beyond `RERANK_MAX_TOKENS`, with queries for them
- [x] 6.2 Add a rank-sensitive metric (nDCG@k) to `scoring.ts` with tests
- [x] 6.6 Add cross-language queries (Spanish, French and German over English memories, English over a Spanish one) and Spanish-only memories to the evaluation corpus; rewrite the baselines with `--lower-floors`, since the unreranked retrievers do not answer three of them
- [x] 6.3 Add the `reranked` retriever to `retrievers/index.ts`, commit its baseline, and make `pnpm run eval` fail when a gated metric of it falls below the unreranked hybrid retriever's at the same `k`
- [x] 6.4 OPERATOR: on the published image for each architecture, record process RSS under a recorded workload, and end-to-end `memory.search` latency at 1, 4 and 8 simultaneous calls; adjust `RERANK_DEADLINE_MS` from those numbers and record them in this file — measured on the built image at `--cpus=1/2/3` (RSS idle and under load, `memory.search` p50 at 1/4/8 concurrent); figures in the README hardware section and in #532/#535/#539; the 300 ms deadline was kept
  - Measured on a locally built linux/arm64 image in a 3-vCPU, 4 GB Docker VM (amd64 not measured): reranking on — idle ~1.1 GB, under load ~1.3 GB, full re-embed peak 1318 MB, memory.search p50 178 / 380 / 431 ms at 1 / 4 / 8 concurrent, full window 150 ms; for reference, the same build with the reranker never started (a switch since removed) — idle 561 MB, under load 687 MB, search p50 20 / 45 / 79 ms. Deadline kept at 300 ms. At the stated minimum (`--cpus=2 --memory=2g`): full re-embed 461 s, peak 1452 MB with no OOM kill, CPU p50 83% of 200% during it, memory.search p50 229 / 387 / 449 ms at 1 / 4 / 8 concurrent, memory.save p50 54 ms; the previous image at the same limits: idle 1024 MB, search p50 27 / 64 / 108 ms, save p50 127 ms. The boot timing now waits for an empty embedding backlog, because during the re-embed it reported a miss on hardware that meets the deadline when idle. The standalone worker start was observed (`reranker ready in its worker thread`).
- [x] 6.5 If 6.4 shows total RSS above the 2.5 GB class with reranking on, stop and report before changing any constant — not triggered: peak RSS 1.45 GB with reranking on, below the 2.5 GB class

## 7. Docs

- [x] 7.1 Update `README.md` hardware section with the measured recommendation from 6.4
- [x] 7.2 Update `docs/embeddings.md` with the rerank flow, the worker, the deadline fallback and the switch

## 8. Verification

- [x] 8.1 `pnpm run typecheck`, `pnpm run lint`, `pnpm test` pass — CI green on #532, #535, #536 and #539 (typecheck, lint, every test project, retrieval eval)
- [x] 8.2 `openspec validate add-search-reranker --strict`, `pnpm run check:delta-freshness`, `pnpm run check:delta-sections`, `pnpm run check:spec-crossrefs` pass — green in those PRs and again before archiving
- [x] 8.3 Run the `rembric-smoke-tests` playbook against the local dev server: one reranked `memory.search`, one `memory.context` with `focus`, one recall call — run against the production server after each release (0.32.0–0.32.2) instead of the dev server: reranked `memory.search` (rows the unreranked path gates out reach the page), `memory.context` with `focus` (ranked pass, no abstention), and per-turn recall through the installed plugin hooks
- [x] 8.4 Restate the published over-widening requirement in `retrieval-evaluation` with a SHALL first line, body otherwise unchanged: `openspec archive` validates every requirement of a rebuilt spec and refused that one
