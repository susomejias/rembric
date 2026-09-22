## Why

The embedding spec still mandates an eager model load during bootstrap: `openspec/specs/memory/spec.md` requires the model to be loaded "during bootstrap, BEFORE the HTTP listener starts" and the boot to "abort with a non-zero exit" when it cannot load, and it places a "a model that cannot load still fails the boot" scenario inside the crash-safe-reset requirement. The implementation deliberately loads the model lazily — the `dashboard` capability already requires "The embedder SHALL remain lazily dynamically imported" — so the memory spec now describes a boot that never happens. The same divergence hid a real defect: the embedding-identity check (`ensureVectorModel`) has no production caller, so after a model or input-recipe change the stale vectors are never wiped and the `memory.doctor` "reset owed" warning never clears. This change aligns the memory contract with the lazy-load reality and wires the identity check at the model's first load.

## What Changes

- **BREAKING** (spec contract, not runtime): replace the "loaded at boot, abort on failure" bootstrap requirement with "loaded on first use, degrade on failure" via `REMOVED` + `ADDED` (archive matches on header and scenario titles).
- Add the identity check at the model's first load: the memoized embedder loader runs `ensureVectorModel` exactly once, so a recorded-identity mismatch wipes the stale vectors and settles the marker before the embedder serves its first vector; a reset failure is logged and deferred, never blocking the listener or the embedder.
- Update the crash-safe-reset requirement to the load-path framing and replace its "a model that cannot load still fails the boot" scenario with "a model that cannot load does not abort the server".
- Update the re-embed requirement's trigger from "when the server starts" to "when the embedder first loads".
- Single-source the frozen model identity (`EMBEDDING_MODEL_ID`, `EMBEDDING_DTYPE`, `EMBEDDING_DIMS`, `EMBEDDING_MODEL_REVISION`, and the ONNX artifact path) in `packages/core/src/embeddings/model-identity.json`, consumed by both `embedder.ts` and `packages/core/scripts/fetch-model.mjs`; a structural invariant test pins the Dockerfile model-bake gate to the derived artifact path.
- Remove the `as unknown as FeaturePipeline` cast on the transformers.js pipeline.
- Update `docs/embeddings.md` flows 2/3 and its failure-mode table to lazy load and the load-time identity check.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `memory`: the embedding model loads lazily on first use; the embedding-identity check runs exactly once at that first load; a model that cannot load degrades the affected operation to lexical search and is retried rather than aborting the boot.

## Impact

- `packages/core/src/embeddings/model-identity.json` (new): the single source of the frozen identity (model id, dtype, dims, revision, ONNX artifact).
- `packages/core/src/embeddings/embedder.ts`: derives its exported constants from the shared identity; drops the double cast on the transformers.js pipeline.
- `packages/core/scripts/fetch-model.mjs`: consumes the shared identity instead of redefining it.
- `packages/core/src/embeddings/state.ts`: unchanged behaviour; `ensureVectorModel` is now called from the embedder load path.
- `apps/web/src/lib/services.ts`: the memoized embedder loader runs the identity check once after the first load resolves.
- `apps/web/Dockerfile`: copies the identity module before the model-bake step so the bake imports the same source.
- `apps/web/src/test/embedding-identity.test.ts` (new): pins the identity single source and the Dockerfile gate, and proves the reset-on-first-load and deferred-failure behaviour.
- `docs/embeddings.md`: flow 2 (boot) becomes lazy load, flow 3 notes the load-time reset, and the failure table moves model-load failure from "boot aborts" to "operation degrades and retries".
- Invariants touched: none. Append-only memory, scope-at-service and `topic_key` are unchanged; the reset removes derived `memory_vec` rows only (never `memory` rows) and the marker is a data-dir file. The frozen recipe (`EMBEDDING_INPUT_VERSION`, `pooling: 'cls'`, `normalize`, dtype `q8`, 768 dims, pinned revision) is unchanged, so no vector is invalidated by this change.
