# embed-embeddings-in-process

## Why

Embeddings are the semantic half of save-time candidate detection — the only conflict-detection input the judge system has besides FTS5 and `topic_key` — yet today they hang off an optional external OpenAI-compatible provider that most operators never wire up (and whose "configurable model" is half-fiction: `memory_vec` hardcodes 768 dims). After `remove-llm-consolidation` (PR #97) the server is deterministic and LLM-free; this change completes the architecture decision recorded on 2026-06-05: embeddings are **core**, in-process, always on — the model ships inside the Docker image, and the operator story becomes "one secret and go" with semantic detection working out of the box, including cross-language (ES/EN) matching that the current default (`nomic-embed-text`, English-primary) never delivered.

## What Changes

- Embed `gte-multilingual-base` (Apache 2.0, 305M params, 768 dims — `memory_vec FLOAT[768]` unchanged) in the Docker image as ONNX q8 (`onnx-community/gte-multilingual-base`), run in-process via `@huggingface/transformers` + `onnxruntime-node`. No runtime downloads.
- Replace the HTTP `EmbeddingWorker` + `LlmClient` with an in-process embedder: lazy model load on first use (boot stays instant), `pooling: 'cls'`, `normalize: true`. `memory.save` embeds the new row inline when the model is warm (`embedNow`, ~15 ms) so vec candidate detection actually has a self-vector — previously `source: 'vec'` could never fire at save time (pre-existing flaw, see design D7).
- **BREAKING** Remove the entire `llm/` directory (`client.ts`, `embed.ts`, `errors.ts`) — no remaining consumers.
- **BREAKING** Remove env vars `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_EMBEDDING_MODEL`, `EMBEDDING_PROVIDER`, `EMBEDDING_ENABLED`, `CANDIDATE_VEC_THRESHOLD` — ignored with the existing stale-env boot warning. Rule: no env var configures the engine; vec threshold becomes an internal constant (~0.70, calibrated against real data during backfill — the 0.85 nomic-era default does not transfer between models).
- **BREAKING** `memory.doctor` `embeddings` block changes shape: `{ enabled }` is gone (always on); `{ model, backlog }` remain.
- Backfill: on first boot with the new model, existing `memory_vec` rows are stale (different model, same dims) — re-embed the corpus via the existing drain pattern, now in-process; report progress in logs and recalibrate the vec threshold from the observed similarity distribution.
- Recalibrate the FTS similarity proxy `1/(1+|bm25|)` (corpus-size sensitive, found during e2e of PR #97) alongside the vec threshold.
- README gains a **Hardware requirements** section: minimum 1 GB RAM, recommended 2 GB (measured ~730 MB RSS total with q8, 14 ms/embedding), argued as the trade-off for zero external services and zero API keys.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `memory`: embedding generation becomes in-process and always-on; `EMBEDDING_ENABLED` fallback semantics removed; backfill requirement for model migration.
- `mcp-api`: `memory.doctor` `embeddings` block shape change.
- `persistence`: `memory_vec` population contract moves from external worker to in-process embedder; model identity pinned (gte-multilingual-base, 768 dims, q8).
- `open-source-distribution`: Docker image bakes the model (+~300 MB); documented hardware requirements; supply-chain handling for `onnxruntime-node` (native dep) per repo policy.

## Impact

- **Deleted**: `apps/server/src/llm/` (entire dir), `apps/server/src/services/embedding-worker.ts` (replaced), embedding env vars from `apps/server/src/config.ts` (+ added to `REMOVED_ENV_VARS`).
- **Added**: `apps/server/src/embeddings/` (in-process embedder + lazy loader + backfill), `@huggingface/transformers` dependency (pulls `onnxruntime-node` — native: route through `.agents/skills/npm-security-best-practices/`, `pnpm-workspace.yaml::allowBuilds`), model files in the Docker image (`apps/server/Dockerfile`).
- **Reworked**: `apps/server/src/server/bootstrap.ts` (embedder wiring, 30s drain timer semantics), `apps/server/src/services/save-time-candidates.ts` (thresholds → internal constants), `apps/server/src/mcp/sessions-tools.ts` (doctor), `apps/server/src/test/` harnesses that set `EMBEDDING_ENABLED=false`.
- **Schema**: no migration — 768 dims match the existing `memory_vec` vtab. Backfill rewrites row contents, not structure (allowed: `memory_vec` is derived data, not append-only memory).
- **Docs**: README (hardware requirements, config table shrinks again), `.env.example`, `docs/{docker,troubleshooting}.md`.
- **Plugin**: no changes.
- **Known gotchas (pinned from the 2026-06-05 sandbox validation)**: transformers.js does not recognize the custom `NewModel` architecture and falls back to `EncoderOnly` — it works, but the dependency version MUST be pinned and covered by a pipeline smoke test; 16-pair battery showed clean separation (positives 0.73–0.97, negatives 0.43–0.68, zero ranking inversions).
- **Dependency**: builds on `remove-llm-consolidation` (PR #97). Apply only after that PR merges.
