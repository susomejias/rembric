# Tasks

## 1. Single source of model identity

- [x] 1.1 Add `packages/core/src/embeddings/model-identity.json` holding `modelId`, `dtype`, `dims`, `revision` and `onnxArtifact`, and derive the four exported constants plus `embeddingOnnxArtifactPath` from it in `embedder.ts`.
- [x] 1.2 Consume the same module from `packages/core/scripts/fetch-model.mjs` (import attribute) so the bake and the runtime cannot disagree.
- [x] 1.3 `COPY` the identity module into the Dockerfile before the model-bake `RUN`, which runs before the package source is copied.
- [x] 1.4 Pin the Dockerfile model-bake gate literal to `embeddingOnnxArtifactPath('/models')` with a structural invariant test in `apps/web/src/test/embedding-identity.test.ts`, and assert the script no longer redefines the identity.

## 2. Real pipeline type

- [x] 2.1 Remove the `as unknown as FeaturePipeline` cast from `embedder.ts`; `pipeline('feature-extraction', …)` already returns `FeatureExtractionPipeline` and the `Tensor.data` union is accepted by `Float32Array.from`. No replacement cast is needed.

## 3. Identity check at the load point

- [x] 3.1 Add `resetVectorModelOnLoad(repos, dataDir)` to `apps/web/src/lib/services.ts`, wrapping `ensureVectorModel`, logging the wipe, and deferring (never throwing) on failure.
- [x] 3.2 Call it inside the memoized `getEmbedder()` `.then`, after `loadEmbedder()` resolves and before the embedder is returned.
- [x] 3.3 Add the focused tests to `apps/web/src/test/embedding-identity.test.ts`: mismatch wipes and settles, matching is a no-op, and a failing reset is deferred. RED observed before the wiring (helper absent), GREEN after.
- [x] 3.4 Mutation-proof the guard: invert the check so it only resets when the identity already matches and confirm the mismatch and deferred tests go red, then restore byte-identically.

## 4. Spec delta and docs

- [x] 4.1 Create the change folder `openspec/changes/lazy-embedding-load-identity-check/` with `proposal.md`, `design.md`, `tasks.md` and `specs/memory/spec.md`.
- [x] 4.2 Delta: `REMOVED` + `ADDED` for the bootstrap and crash-safe-reset requirements (their headers and scenarios change), and `MODIFIED` for the re-embed requirement's trigger sentence.
- [x] 4.3 Update `docs/embeddings.md` flow 2 to the lazy load and flow 3 to the load-time reset, and move the model-load row of the failure table from "boot aborts" to "operation degrades and retries".

## 5. Verification

- [x] 5.1 `pnpm --filter @rembric/core exec vitest run src/`.
- [x] 5.2 `pnpm --filter @rembric/web exec vitest run src/test/` (invariants included).
- [x] 5.3 `pnpm run typecheck` and `pnpm run lint`.
- [x] 5.4 `git diff --check`.
- [x] 5.5 `openspec validate lazy-embedding-load-identity-check --strict` plus the repo delta gates (`check:delta-sections`, `check:delta-freshness`, `check:spec-crossrefs`).
