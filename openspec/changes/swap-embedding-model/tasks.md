## 1. Prerequisites

- [ ] 1.1 Archive `lazy-embedding-load-identity-check`, so "Embeddings MUST be computed in-process by a model loaded on first use" is the published requirement
- [ ] 1.2 Add to this change's `memory` delta a MODIFIED copy of that requirement (full block, every scenario) with the model literal changed to `hs-embed-1, ONNX int8, 384 dims, pooling: 'mean', normalize: true`; `pnpm run check:delta-freshness` passes

## 2. Model identity and loader

- [ ] 2.1 RED: update `packages/core/src/embeddings/embedder.test.ts` to expect 384-dim normalized vectors and a cross-lingual pair scoring above an unrelated pair
- [ ] 2.2 Update `model-identity.json` (model id, pinned revision, dims 384, artifact `onnx/model.onnx`, dtype) and `embedder.ts` (mean pooling); the test from 2.1 passes
- [ ] 2.3 Make fake embedders and fixtures read the dimension from the identity (`packages/core/src/test-support/embedder.ts`, `apps/web/src/test/embedder.ts`, any test hard-coding 768)
- [ ] 2.4 Update `packages/core/scripts/fetch-model.mjs` and the `Dockerfile` bake step; the Dockerfile bake-gate invariant in `apps/web/src/test/invariants.test.ts` passes against the new derived artifact path

## 3. Vector index migration

- [ ] 3.1 RED: add a migration test that starts from a database holding 768-dim vectors and asserts, after migrating, that every `memory` row is unchanged, `memory_vec` accepts a 384-dim vector, rejects a 768-dim one, and holds no old vector
- [ ] 3.2 Add the migration recreating `memory_vec` at `FLOAT[384]` with the same columns and partition key; update the schema declaration; 3.1 passes and the migration-runner FK-safety invariant still passes
- [ ] 3.3 Test the upgrade path end to end on a temporary data directory: old identity marker plus old vectors, boot, drain, and a text query returning a memory through the dense branch

## 4. Recalibration

- [ ] 4.1 Run `pnpm run eval` on the new model, regenerate `baselines/*.json`, and confirm no floor is lower than the committed one at any `k`; commit the report
- [ ] 4.2 Re-run the abstention gate sweep and set `RELATIVE_LEVEL_RATIO` to a value inside an admissible plateau at least 0.10 wide; commit the sweep output
- [ ] 4.3 Run `pnpm run eval:save-time` and set `VEC_THRESHOLD`, `CANDIDATE_LOW_BAND_CEILING` and `CANDIDATE_HIGH_BAND_FLOOR` from its plateau; if it reports no admissible plateau, stop and report instead of choosing a value
- [ ] 4.4 Mutation check each re-derived constant with `node scripts/mutate.mjs` and confirm a test goes red for each

## 5. Operator path

- [ ] 5.1 OPERATOR: upgrade a copy of a real data directory with the built image; record re-embed duration, process RSS at idle and during the drain, and one dense-branch search result
- [ ] 5.2 OPERATOR: run the previous image against that upgraded copy and record what happens; write the rollback instructions from the observed behaviour
- [ ] 5.3 Update `docs/embeddings.md` (model, dimension, upgrade and rollback) and the model description in `README.md`

## 6. Verification

- [ ] 6.1 `pnpm run typecheck`, `pnpm run lint`, `pnpm test` pass
- [ ] 6.2 `openspec validate swap-embedding-model --strict`, `pnpm run check:delta-freshness`, `pnpm run check:delta-sections`, `pnpm run check:spec-crossrefs` pass
- [ ] 6.3 Run the `rembric-smoke-tests` playbook against the local dev server: save, search, and a `memory.context` with `focus`
