# Design — embed-embeddings-in-process

## Context

`remove-llm-consolidation` left embeddings as the last external dependency: an optional OpenAI-compatible provider feeding `memory_vec` through a polling `EmbeddingWorker`. The 2026-06-05 exploration closed the architecture question — embeddings are core, not optional — and validated the chosen model empirically in a Node sandbox (16-pair battery over rembric-domain content, ES/EN): clean separation, zero ranking inversions, contradictions score high (they must — they feed the judge), shared-identifier hard negatives stay low.

Model selection record (do not re-open): **EmbeddingGemma-300M was rejected on license** — Gemma Terms of Use require flowing restrictions down to every recipient of a redistributed model, unacceptable for an MIT project baking the model into its public image. `gte-multilingual-base` is Apache 2.0, same quality class, same 768 dims.

## Goals / Non-Goals

**Goals:**

- Semantic candidate detection always on, zero external services, zero API keys, zero runtime downloads.
- Engine knobs (model, thresholds, pooling) are code, not configuration.
- Existing corpora migrate themselves: stale vectors re-embedded automatically, threshold calibrated from real data.
- Fail fast: a broken model turns the deploy red at boot, never a silently degraded server.

**Non-Goals:**

- Model choice as an operator feature (fork if you want a different engine).
- GPU support, quantization options, or Matryoshka dimension reduction — q8/CPU/768 is the contract.
- Touching FTS5 indexing or `memory.search` (stays lexical).
- Multi-model or re-ranking pipelines.

## Decisions

### D1 — Model pinned as a constant: gte-multilingual-base, ONNX q8, 768 dims

`onnx-community/gte-multilingual-base` with `dtype: 'q8'`, `pooling: 'cls'`, `normalize: true`. 768 dims keep `memory_vec FLOAT[768]` byte-compatible — no schema migration. q8 over q4: +70 MB RSS buys 14 ms vs 26 ms per embedding (sandbox-measured).

- _Alternative — EmbeddingGemma-300M (QAT, <200 MB)_: rejected; Gemma ToU flow-down obligations are incompatible with MIT redistribution in a public image.
- _Alternative — multilingual-e5-small (MIT, 118 M)_: rejected; 384 dims force a vtab migration and quality drops; also requires query/passage prefixes (a footgun gte doesn't have).
- _Alternative — keep model configurable_: rejected; the configurability was already fake (768 hardcoded in the vtab) and every model swap silently invalidates thresholds. Engine = code.

### D2 — In-process via @huggingface/transformers, loaded eagerly at boot (revised during apply)

One embedder module (`src/embeddings/`). Bootstrap awaits the model load BEFORE starting the HTTP listener; a load failure aborts the boot. Once listening, the model is always warm — the cold/warm dimension does not exist in a running server, which deletes a whole branch of degradation logic (`isReady`, lazy singleton, cold-save scenarios).

Rationale shift: the original lazy-load decision assumed an ~18 s load (sandbox download). The baked image measures **1.1 s** — cheap enough to buy fail-fast semantics and the complexity reduction outright (owner decision, 2026-06-05). Healthcheck `start-period` (10 s) absorbs it. The one cost: a bare-metal dev boot without a cached model blocks on a one-time ~300 MB download; the dev container bakes the model, so this only affects contributors running outside Docker, once.

- _Alternative — lazy load on first use_: rejected on second pass; keeps the cold branch everywhere (save path, drain, tests, spec) for a window that fail-fast eliminates entirely.
- _Alternative — non-blocking warmup at boot_: rejected; shrinks the cold window to ~1 s but keeps all the branches — the complexity was the problem, not the window.
- _Alternative — child process / sidecar_: rejected; rembric's whole identity is one process, one file. onnxruntime releases the JS thread during inference (async), so the event loop is not blocked.

Known quirk (pinned): transformers.js maps the custom `NewModel` architecture to its `EncoderOnly` fallback with a console warning. The sandbox battery validated output correctness through this path. The dependency version MUST be exact-pinned and a smoke test MUST embed a fixed pair and assert similarity bounds, so an upgrade that breaks the fallback fails CI instead of production.

### D3 — Model baked into the image, fetched at build time

Dockerfile build stage downloads the ONNX artifacts (pinned revision + checksum) into the image; `HF_HUB_OFFLINE=1` at runtime. Image grows ~300 MB — accepted; rembric ships exclusively as a Docker image, so "bundle" has no npm-size cost.

- _Alternative — download on first run_: rejected; breaks air-gapped/LAN deployments, adds a runtime failure mode, and makes container startup time unpredictable.
- _Alternative — separate model volume_: rejected; one more operator step, against the "one secret and go" goal.

### D4 — Backfill + threshold calibration on first boot with stale vectors

A `model` marker (stored alongside the data dir state) detects vectors produced by a different model. On mismatch: drain-pattern re-embed of all non-archived memories (in-process, batched, resumable — the existing worker loop semantics), logging progress. After backfill, log the observed similarity distribution percentiles; the shipped constant (~0.70, sandbox-calibrated) is adjusted in a patch release if real-world distributions disagree. The FTS proxy `1/(1+|bm25|)` threshold is re-examined with the same data (it is corpus-size sensitive — finding from PR #97's e2e).

- _Alternative — keep old vectors until rows are touched_: rejected; mixed-model vectors make cosine scores meaningless pairwise.
- _Alternative — threshold as env var_: rejected; violates the engine-not-config rule and breaks the calibration story.

### D5 — Env surface shrinks to zero embedding vars

`OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_EMBEDDING_MODEL`, `EMBEDDING_PROVIDER`, `EMBEDDING_ENABLED`, `CANDIDATE_VEC_THRESHOLD` join `REMOVED_ENV_VARS` (boot warning, never a crash — same contract as PR #97). `llm/` directory is deleted whole; doctor's `embeddings` block becomes `{ model, backlog }`.

- _Alternative — keep `EMBEDDING_ENABLED` as an off switch_: rejected; the decision is that embeddings are core. Operators below the hardware floor are addressed by documentation (D6), not by a degraded mode that silently halves detection quality.

### D6 — Hardware requirements documented, with the argument

README section: **minimum 1 GB RAM, recommended 2 GB** (measured: ~730 MB total RSS with q8 under load; 14 ms/embedding CPU). Framed explicitly: the requirement exists _because_ the server embeds its semantic engine — in exchange there are no external services, no API keys, no network calls. Pinned constraint for the future: the model class is ≤350M params / ≤800 MB total RSS; upgrading to a larger model is a breaking architectural change, not a tuning decision.

### D7 — Inline save-time embedding (embedNow) — added during apply

The e2e exposed a pre-existing structural flaw: the vec pass requires the just-saved row's own vector (`v_self`), but vectors only ever arrived asynchronously (30s drain) — so `source: 'vec'` could never fire at save time, in any prior version. Fix: `EmbeddingWorker.embedNow(id, content)` embeds the new row inline before candidate detection WHEN the model is already warm (~15 ms measured in-container); cold model → skip, FTS-only for that save (the documented degradation). Save latency impact is ms-scale and only on the warm path.

Validated in-container (2026-06-05 e2e): cross-language ES→EN paraphrase saves surface `source: 'vec'` candidates at 0.754–0.774; a loose same-language paraphrase measured 0.657 (below the 0.70 floor — caught by FTS instead, the intended complementarity). Drain telemetry over the seed corpus: p50=0.681 p90=0.861 max=0.946 — 0.70 confirmed as a sane precision/recall point. With D2 revised to eager loading, embedNow is warm by construction; its only failure mode is a per-inference error (logged, FTS fallback, drain retry).

### D8 — Removed-var list also includes CANDIDATE_FTS_THRESHOLD — widened during apply

The spec delta says thresholds (plural) are engine constants; leaving `CANDIDATE_FTS_THRESHOLD` configurable contradicted it. Both thresholds are now compile-time constants; seven embedding-era vars are removed in total.

### D9 — Baked model ships in local-model layout, offline-validated — corrected during apply

The original cache-layout bake failed at runtime: transformers.js resolves tokenizer files without the revision-qualified cache key when offline, yielding a constructed-but-broken pipeline (`this.tokenizer is not a function`). The bake now flattens to the local-model layout (`<root>/<model-id>/<files>`) and phase 3 of `fetch-model.mjs` re-validates the pipeline in a fresh process with networking disabled — the exact runtime resolution path. Measured in-container: cold-start load 1.1 s from baked files, 15 ms/embedding.

## Risks / Trade-offs

- [Risk] `onnxruntime-node` is a native dependency with platform binaries → Mitigation: route through the npm-security skill, add to `allowBuilds` explicitly, verify both `linux/amd64` and `linux/arm64` image builds in CI before release.
- [Risk] transformers.js `NewModel→EncoderOnly` fallback breaks in a future version → Mitigation: exact version pin + similarity-bounds smoke test in CI (D2).
- [Risk] Backfill on a large corpus delays semantic detection after upgrade → Mitigation: backfill is incremental and resumable; FTS detection works throughout; progress logged.
- [Risk] ~730 MB RSS evicts rembric from 512 MB containers that worked before → Accepted and documented (D6); this is the cost of the core-architecture decision, taken knowingly by the owner.
- [Trade-off] Operators lose the ability to point at their own embedding endpoint → Accepted because the configurability was already broken (768 hardcoded) and unused paths are unowned paths.
- [Trade-off] Image +~300 MB → Accepted; Docker-only distribution, disk is the cheapest resource involved.

## Migration Plan

1. Apply only after PR #97 (`remove-llm-consolidation`) merges.
2. Ship as a server minor (pre-1.0) with **BREAKING** markers. Upgrade remains zero-step: stale env vars warn; first boot detects stale vectors and backfills in background; FTS covers detection during backfill.
3. Rollback = previous image; old code ignores the model marker and resumes external-provider behavior against its own config.

## Open Questions

(none — decisions closed in the 2026-06-05 exploration; calibration values intentionally deferred to backfill data by design)
