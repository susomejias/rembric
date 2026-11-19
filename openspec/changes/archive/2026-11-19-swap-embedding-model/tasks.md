## 1. Prerequisites

- [x] 1.1 Archive `lazy-embedding-load-identity-check`, so "Embeddings MUST be computed in-process by a model loaded on first use" is the published requirement
- [x] 1.2 Add to this change's `memory` delta a MODIFIED copy of that requirement (full block, every scenario) with the model literal changed to `hs-embed-1, ONNX int8, 384 dims, pooling: 'mean', normalize: true`; `pnpm run check:delta-freshness` passes

## 2. Model identity and loader

- [x] 2.1 RED: update `packages/core/src/embeddings/embedder.test.ts` to expect 384-dim normalized vectors and a cross-lingual pair scoring above an unrelated pair
- [x] 2.2 Update `model-identity.json` (model id, pinned revision, dims 384, artifact `onnx/model.onnx`, dtype) and `embedder.ts` (mean pooling); the test from 2.1 passes
- [x] 2.3 Make fake embedders and fixtures read the dimension from the identity (`packages/core/src/test-support/embedder.ts`, `apps/web/src/test/embedder.ts`, any test hard-coding 768)
- [x] 2.4 Update `packages/core/scripts/fetch-model.mjs` and the `Dockerfile` bake step; the Dockerfile bake-gate invariant in `apps/web/src/test/invariants.test.ts` passes against the new derived artifact path

## 3. Vector index migration

- [x] 3.1 RED: add a migration test that starts from a database holding 768-dim vectors and asserts, after migrating, that every `memory` row is unchanged, `memory_vec` accepts a 384-dim vector, rejects a 768-dim one, and holds no old vector
- [x] 3.2 Add the migration recreating `memory_vec` at `FLOAT[384]` with the same columns and partition key; update the schema declaration; 3.1 passes and the migration-runner FK-safety invariant still passes
- [x] 3.3 Test the upgrade path end to end on a temporary data directory: old identity marker plus old vectors, boot, drain, and a text query returning a memory through the dense branch

## 4. Recalibration

- [x] 4.1 Run `pnpm run eval` on the new model, regenerate `baselines/*.json`, and confirm no floor is lower than the committed one at any `k`; commit the report
- [x] 4.2 Re-run the abstention gate sweep and set `RELATIVE_LEVEL_RATIO` to a value inside an admissible plateau at least 0.10 wide; commit the sweep output
- [x] 4.3 Run `pnpm run eval:save-time` and set `VEC_THRESHOLD`, `CANDIDATE_LOW_BAND_CEILING` and `CANDIDATE_HIGH_BAND_FLOOR` from its plateau; if it reports no admissible plateau, stop and report instead of choosing a value
- [x] 4.4 Mutation check each re-derived constant with `node scripts/mutate.mjs` and confirm a test goes red for each

## 5. Operator path

- [x] 5.1 OPERATOR: upgrade a copy of a real data directory with the built image; record re-embed duration, process RSS at idle and during the drain, and one dense-branch search result — upgraded a copy of a real data directory with the built image at `--cpus=2 --memory=2g`: re-embed 461 s, peak RSS 1452 MB, no OOM, dense search served after the drain; the production upgrade to 0.32.0 re-embedded and reported `backlog: 0`
- [x] 5.2 OPERATOR: run the previous image against that upgraded copy and record what happens; write the rollback instructions from the observed behaviour — observed with the previous code (not the image): it opens the upgraded data dir, wipes the 384-dim vectors, and every re-embed then fails on the dimension, so search stays lexical-only; rollback = restore the pre-upgrade backup (docs/embeddings.md)
- [x] 5.3 Update `docs/embeddings.md` (model, dimension, upgrade and rollback) and the model description in `README.md`

## 6. Verification

- [x] 6.1 `pnpm run typecheck`, `pnpm run lint`, `pnpm test` pass — CI green on #532
- [x] 6.2 `openspec validate swap-embedding-model --strict`, `pnpm run check:delta-freshness`, `pnpm run check:delta-sections`, `pnpm run check:spec-crossrefs` pass — green in #532 and again before archiving
- [x] 6.3 Run the `rembric-smoke-tests` playbook against the local dev server: save, search, and a `memory.context` with `focus` — run against the production server after 0.32.0: `memory.doctor` reports no embedding backlog after the day's saves, `memory.search` returns cross-language hits, `memory.context` with `focus` ranks

## 7. Added during implementation

- [x] 7.1 Cap embedder input at `EMBEDDING_MAX_TOKENS` (1024): uncapped, re-embedding long memories held the process above 8 GB; capped, near 1 GB with retrieval quality unchanged. The cap is part of `EMBEDDING_INPUT_VERSION`.
- [x] 7.2 Move the shared title + content recipe to `services/memory-text.ts`, so search code reaches no `embeddings/` module (drain import-graph invariant).
