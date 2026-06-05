# Tasks — embed-embeddings-in-process

> Apply ONLY after PR #97 (`remove-llm-consolidation`) is merged; this change deletes code that PR touches.

## 1. Dependency and supply chain

- [x] 1.1 Consult `.agents/skills/npm-security-best-practices/` BEFORE adding anything; add `@huggingface/transformers` (exact pin) to `apps/server/package.json`; add `onnxruntime-node` to `pnpm-workspace.yaml::allowBuilds`; lockfile reviewed (expect native platform packages)
- [x] 1.2 Verify `pnpm install` + `pnpm test` pass on the dev machine with default-deny lifecycle scripts; document any required `allowBuilds` additions in the commit body

## 2. In-process embedder

- [x] 2.1 Create `apps/server/src/embeddings/embedder.ts`: lazy singleton pipeline (`onnx-community/gte-multilingual-base`, `dtype: 'q8'`, `pooling: 'cls'`, `normalize: true`); model path resolution prefers image-local dir (env-agnostic constant) with `HF_HUB_OFFLINE`; embed(text) → Float32Array(768)
- [x] 2.2 Pipeline smoke test: embed a fixed pair, assert cosine within recorded bounds — guards the transformers.js `NewModel→EncoderOnly` fallback against dependency upgrades (version MUST stay exact-pinned)
- [x] 2.3 Rework `apps/server/src/services/embedding-worker.ts` → in-process drain (same batch/queue semantics, no HTTP client); keep the 30s timer wiring in bootstrap
- [x] 2.4 Delete `apps/server/src/llm/` entirely; remove all imports; extend `removed-exports` guard with `LlmClient`

## 3. Backfill and calibration

- [x] 3.1 Model-identity marker in the data dir state (reuse `.rembric-state.json` mechanics); mismatch → resumable batched re-embed of non-archived memories with progress logs
- [x] 3.2 After backfill, log similarity-distribution percentiles over the surfaced candidate pool; set `VEC_THRESHOLD` internal constant (start ~0.70) and re-derive `FTS_THRESHOLD` (the `1/(1+|bm25|)` proxy is corpus-size sensitive); record final values + rationale in design.md addendum
- [x] 3.3 Tests: mismatch triggers backfill; resume after interrupt; candidates work mid-backfill (FTS-only)

## 4. Config purge

- [x] 4.1 Remove `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_EMBEDDING_MODEL`, `EMBEDDING_PROVIDER`, `EMBEDDING_ENABLED`, `CANDIDATE_VEC_THRESHOLD` from `config.ts`; append all six to `REMOVED_ENV_VARS`; `Config.embedding` shrinks or disappears; redactConfig updated
- [x] 4.2 Config tests: boot succeeds with all removed vars set; `findStaleEnvVars` lists them; thresholds no longer configurable
- [x] 4.3 Doctor: `embeddings` block → `{ model, backlog }`; update `DoctorReport`, builder, integration test

## 5. Candidates and tests

- [x] 5.1 `save-time-candidates.ts`: thresholds from internal constants; remove `CandidateOptions.{vecThreshold,ftsThreshold}` plumbing from bootstrap/mcp
- [x] 5.2 Update test harnesses that set `EMBEDDING_ENABLED=false` / `OPENAI_API_KEY` (mcp-integration, smoke, dashboard-e2e); embedding-dependent tests use the real in-process model where feasible or a seeded `memory_vec` fixture where not
- [x] 5.3 Full gate: `pnpm run typecheck && pnpm run lint && pnpm test` green

## 6. Docker image

- [x] 6.1 `apps/server/Dockerfile`: build stage downloads pinned model revision with checksum verification into the image; runtime stage sets offline env; image builds for `linux/amd64` and `linux/arm64`
- [x] 6.2 Measure image size delta and cold-start model load time inside the container; record in PR body

## 7. Docs

- [x] 7.1 README: new **Hardware requirements** section (1 GB min / 2 GB recommended, measured RSS, the zero-external-deps argument); config table loses the embeddings section; quickstart loses the Ollama mention
- [x] 7.2 `.env.example`: remove embedding block; `docs/docker.md`: remove `host.docker.internal`/Ollama section; `docs/troubleshooting.md`: embedding endpoint section → model load/backfill troubleshooting; sweep for `OPENAI_`/`EMBEDDING_`/`nomic`/`Ollama` leftovers across README/docs/CLAUDE.md

## 8. E2E smoke (dev stack)

- [x] 8.1 Per `.agents/skills/rembric-smoke-tests/` against `pnpm run dev:docker:up`: boot with stale `EMBEDDING_ENABLED`/`OPENAI_API_KEY` → warning, healthy; save two paraphrased memories (ES/EN pair) → vec candidate surfaces with `source: 'vec'`; doctor shows `{ model, backlog }`; backfill triggers on a pre-existing seeded DB and completes; RSS of the container measured ≤ 800 MB after embedding activity
