# De-manualize embeddings (no model change)

## Decision context

Exploration (mud72nhp-11-sjzw) at 6a1cb013 found the real "manualidad" is NOT the model wrapper (~35 lines in `packages/core/src/embeddings/embedder.ts`); it is (1) triple duplication of the model identity constants and (2) product glue that no embedding library replaces (worker, state marker, sqlite-vec storage, offline bake). Adopted recommendation: keep `@huggingface/transformers@4.2.0` + gte-multilingual-base q8 768 — any model change (even same-dims) invalidates every vector and forces a full reindex (~3.3h/10k rows, code-derived). AI SDK v5 would ADD an `EmbeddingModelV2` wrapper, not remove glue.

## Confirmed defect to fix (spec↔code divergence)

`ensureVectorModel` (`packages/core/src/embeddings/state.ts:106`) has NO production caller: `apps/web/src/lib/process.ts:248-276` loads the embedder lazily and never runs the identity check/reset. `docs/embeddings.md` flow 2, `embedder.ts:11-13`, `embedding-worker.ts:9-11`, and `openspec/specs/memory/spec.md:169` ("SHALL be loaded during bootstrap, BEFORE the HTTP listener starts… abort the boot") describe the old eager boot. The doctor's persistent "reset owed" warning is symptomatic: nobody ever settles the reset. Lazy loading is the DELIBERATE migration design (idle boot skips the model); the spec text and the missing reset wiring are the outdated halves.

## Tasks (sequenced AFTER the comment-hygiene sweep — same files)

- [ ] E1 Single source of model identity: share constants (`EMBEDDING_MODEL_ID`, `EMBEDDING_DTYPE`, `EMBEDDING_DIMS`, `EMBEDDING_MODEL_REVISION`) between `embedder.ts:22-24,60` and `packages/core/scripts/fetch-model.mjs:14-17`; derive the Dockerfile `onnx-community/.../model_quantized.onnx` path from the same source (Dockerfile:210). No behavior change.
- [ ] E2 Replace `as unknown as FeaturePipeline` (`embedder.ts:72-77`) with the real `FeatureExtractionPipeline` type from transformers.js.
- [ ] E3 Wire the identity check at the embedder's actual load point (first lazy load in `lib/process.ts` / `services.ts`), so an identity mismatch triggers `ensureVectorModel`'s reset exactly once per load. Do NOT reintroduce eager boot.
- [ ] E4 Spec delta: update `openspec/specs/memory/spec.md` bootstrap requirement (and `docs/embeddings.md` + stale docstrings `embedder.ts:11-13`, `embedding-worker.ts:9-11`) to the lazy-load reality with the identity check at load time. OpenSpec change dir under `openspec/changes/`.
- [ ] E5 Verify: focused embeddings/worker tests, typecheck, doctor warning behavior after a synthetic identity change (reset triggers, warning clears); mutation-proof the E3 guard.

## Constraints

`EMBEDDING_INPUT_VERSION` (`embedder.ts:33`), pooling (`cls`), normalize, dtype q8, dims 768, revision — all FROZEN (touching any invalidates vectors). sqlite-vec stays. No dependency changes.
