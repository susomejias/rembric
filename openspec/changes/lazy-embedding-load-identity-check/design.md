## Context

The embeddings engine is in-process and part of the binary, but the model is not needed for an idle server: the drain only loads it when a row is pending, and the save/search path loads it on demand. That lazy design is already published for the `dashboard` capability ("The embedder SHALL remain lazily dynamically imported"), while the `memory` capability still publishes the opposite — an eager load "BEFORE the HTTP listener starts" that aborts the boot on failure. The gap also hid a defect: `ensureVectorModel`, the only thing that compares the recorded embedding identity against the compiled-in one, has no production caller, so a model or input-recipe change never wipes stale vectors and the `memory.doctor` warning never clears.

## Goals

- Make the `memory` contract describe the lazy load the code performs.
- Run the embedding-identity check exactly once, at the embedder's first load, without reintroducing an eager boot.
- Keep every frozen invariant: append-only memory, scope-at-service, `topic_key`, and the pinned embedding recipe.
- Give the model identity one source instead of three.

## Non-Goals

- No model change, no precision change, no dependency change, no sqlite-vec change.
- No eager boot, no warm-model guarantee, and no change to the degradation contract.
- No new MCP tool and no schema change.
- No redefinition of `EMBEDDING_INPUT_VERSION`, pooling, normalization, dtype or dims.

## Decisions

### D1 — `REMOVED` + `ADDED` for the renamed bootstrap requirement, not `MODIFIED`

`openspec archive` matches requirements and scenarios by header. The bootstrap requirement's header stated the eager load ("…loaded at boot") and one scenario stated it too ("The model cannot load at boot"); both must change, and a `MODIFIED` block cannot rename a scenario without archive refusing the drop. The repo already uses `REMOVED` + `ADDED` for exactly this rename (`archive/2026-08-09-name-every-client-on-every-surface`). The crash-safe-reset requirement carries the same false claim in its own scenario, so it is removed and re-added the same way. The re-embed requirement keeps its header and scenario titles, so it is a plain `MODIFIED` with only its trigger sentence changed.

**Alternative considered**: keep the old header and edit only the body. Rejected — it would publish a requirement titled "loaded at boot" whose body says "loaded on first use", and the stale scenario title would survive.

### D2 — The identity check runs once inside the memoized embedder load

`apps/web/src/lib/services.ts` already memoizes the loader (`embedderPromise ??= loadEmbedder()`). The check runs in that memoized `.then`, immediately after the pipeline resolves and before the returned embedder is handed to the worker or the search path. That is the only place that satisfies "once per embedder instance" without a second piece of state, and it is the call site the drain and the save path both funnel through.

**Alternative considered**: an eager call in `process.ts::startProcess`. Rejected — it reintroduces the warm-model boot the migration deliberately removed.

**Alternative considered**: make `loadEmbedder` take the repositories and data dir. Rejected — it couples the embeddings module to the DB and data-dir layout for no benefit; the service layer already owns both.

### D3 — A failed reset is deferred, never fatal

`ensureVectorModel` throws when its pre-wipe marker write fails, and that propagation is load-bearing (it is what stops the wipe). The load path wraps the call and degrades any failure to "leave the index as it is, re-check on the next load", logged with the marker path. A reset failure must not reject the embedder promise, or the server would lose embeddings permanently until a restart — the opposite of the lazy design's intent.

### D4 — One JSON identity module both runtimes can import

`packages/core/src/embeddings/model-identity.json` holds the model id, dtype, dims, revision and ONNX artifact. `embedder.ts` imports it with `resolveJsonModule` and re-exports the four constants plus the derived artifact path; `fetch-model.mjs` imports it with an import attribute. TypeScript emits imported JSON into `dist`, so the runtime resolves the same file. The Dockerfile copies that one file before the model-bake step, which runs before the package source is copied.

**Alternative considered**: a `.mjs` module with a hand-written declaration. Rejected — `tsc` does not emit `.mjs` sources (no `allowJs`), so the runtime `dist` import would break, and changing the package build script was out of scope.

### D5 — The Dockerfile gate is pinned by a test, not derived

The Dockerfile cannot import JavaScript, so its literal `/models/<model-id>/onnx/model_quantized.onnx` existence gate is pinned by a structural invariant test that compares it against `embeddingOnnxArtifactPath('/models')`. That test — not a generation step — is what keeps the Dockerfile from drifting.

### D6 — A model that cannot load degrades instead of aborting

The old contract made a load failure fatal. Under lazy loading there is no boot-time load to fail, and the search branch already catches an embed failure and falls back to lexical (`hybrid-search.ts`). The new contract states that explicitly: the operation degrades, the drain retries, the boot does not abort.

**Alternative considered**: abort the process on first-load failure. Rejected — it would make the first save that triggers a load a DoS on the whole server, and it contradicts the published `dashboard` lazy-load requirement.

## Risks / Trade-offs

- [Risk] The `memory.save` candidate contract cites the old requirement title at `openspec/specs/memory/spec.md:743`, so after archive that citation resolves to nothing. → `check-spec-crossrefs` reports it as an advisory, not a failure (its projected pass exists exactly for this); the citation is updated in a follow-up change rather than by hand-editing the published spec, which `check-spec-provenance` forbids.
- [Risk] A stale `packages/core/dist` makes `@rembric/core` resolve the new exports to nothing for editors. → `pnpm run typecheck` builds dependency packages first (`turbo.json` `typecheck` depends on `^build`), refreshing `dist`.
- [Risk] The CI model-prefetch cache key does not reference `model-identity.json`, so an identity-only edit could reuse a stale cached bake. → Out of this change's edit surface (`.github/workflows/ci.yml`); reported as a follow-up because the phase-3 validation still compares the shipped artifact against the identity.
- [Trade-off] The reset now fires on the first load rather than at boot, so an idle server with stale vectors keeps them until the first save/search or the hourly forced drain. → Accepted; the `memory.doctor` warning keeps the owed reset visible in the meantime, and the first load is guaranteed within the forced-drain window.

## Migration and rollback

No database migration, no data change, no operator action. Rollback reverts the code and the change folder; the marker file and vectors are untouched by rollback.
