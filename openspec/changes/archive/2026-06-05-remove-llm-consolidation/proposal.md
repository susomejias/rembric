# remove-llm-consolidation

## Why

The nightly consolidator is the only consumer of the chat LLM and the only cron in the process, yet everything it does with that machinery is either deterministic already (decay) or better handled by the agent that owns the context (judging pending relations). Save-time candidates + `memory.judge` made batch LLM judgment redundant in v0.5; this change completes that arc: the server stops reasoning entirely — intelligence lives in the connected agents, the server stays a deterministic SQLite + HTTP process. Operators lose three external requirements (LLM provider, API key, cron tuning) and the open-source story becomes "one secret and go".

## What Changes

- **BREAKING** Remove the chat LLM layer: `llm/generate.ts`, `consolidation/judge.ts`, and the `LlmClient` chat wiring in bootstrap. No LLM verdicts are produced server-side anymore.
- **BREAKING** Remove the consolidation cron: `consolidation/scheduler.ts` and the `croner` dependency. Decay + pending-relation orphaning become a deterministic **lazy sweep** triggered on session start (HTTP `POST /api(/:slug)/sessions` and MCP `memory.session_start`, both funneling through one service method), throttled to at most one run per scope per interval. The manual dashboard trigger remains.
- **BREAKING** Remove env vars `LLM_PROVIDER`, `OPENAI_MODEL`, `CONSOLIDATION_ENABLED`, `CONSOLIDATION_CRON`, `CONSOLIDATION_BATCH_SIZE`. Stale values are ignored with a startup warning, never a crash. (`OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_EMBEDDING_MODEL` / `EMBEDDING_*` remain — they configure the embedding client, out of scope until `embed-embeddings-in-process`. The cross-field validation that hard-required `OPENAI_API_KEY` is deleted: boot never fails on missing keys anymore.)
- **BREAKING** `memory.doctor` report drops the `llm` block.
- Aged pending relations (>24h, existing `JUDGMENT_ORPHAN_AFTER_MS`) are re-exposed in `memory.context` as `pendingJudgments[]` (cap 5) so the agent closes them with `memory.judge` under fresh context — consistent with the fresh-context judgment invariant.
- Pendings still unjudged after a deadline (default 14 days, new env `JUDGMENT_ORPHAN_DEADLINE_MS`) are marked `orphaned` by the sweep — deterministic, journaled, same `consolidation_ops` mechanics as today.
- Unchanged: `consolidation_ops`/`consolidation_runs` journal and undo (maintenance purges and the upcoming backup change depend on them), append-only memory invariant, decay semantics (90d unseen + zero confirmations → archived), dashboard consolidation history page, embeddings/`memory_vec`/`EmbeddingWorker` (follow-up change `embed-embeddings-in-process`).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `consolidation`: trigger model changes from nightly cron to throttled lazy sweep on session start; orphan promotion loses its LLM judge — aged pendings are surfaced to agents via `memory.context` and deterministically orphaned after the deadline; decay requirements unchanged in substance, re-anchored to the sweep.
- `mcp-api`: `memory.context` response gains `pendingJudgments[]`; `memory.doctor` report loses the `llm` block.

## Impact

- **Deleted**: `apps/server/src/llm/generate.ts`, `apps/server/src/consolidation/judge.ts`, `apps/server/src/consolidation/judge.test.ts`, `apps/server/src/consolidation/scheduler.ts`, `croner` from `apps/server/package.json`.
- **Reworked**: `apps/server/src/consolidation/runner.ts` (shrinks to deterministic sweep), `apps/server/src/consolidation/orphan-promotion.test.ts`, `apps/server/src/server/bootstrap.ts` (chat `LlmClient`, scheduler wiring, `triggerConsolidation`, doctor builder), `apps/server/src/config.ts` (env schema + cross-field validation), `apps/server/src/mcp/sessions-tools.ts` (`DoctorReport`, `handleContext`, `handleSessionStart`), `apps/server/src/server/api-router.ts` (sweep hook on session ensure).
- **Touched**: `apps/server/src/dashboard/consolidation.ts` (manual trigger calls the sweep; runs table keeps rendering legacy `llm_model` rows as `—`), `apps/server/src/services/relations.ts` (reuse `findPendingOlderThan`/`orphan`), `apps/server/src/consolidation/removed-exports.test.ts` (extend resurrection guard to `judge`/`scheduler` exports), `apps/server/src/test/invariants.test.ts`.
- **Schema**: no migration. `consolidation_runs.llm_provider/llm_model` columns remain (append-only history); new rows write null.
- **Docs**: `README.md` config table, `.env.example` — LLM/consolidation sections removed.
- **Plugin**: no changes (verified: `apps/plugin/` does not parse doctor/llm fields). MCP instructions text updated server-side only.
- **Invariants**: strengthens fresh-context judgment (agent becomes the only judge); append-only, scope-at-service, topic_key untouched. The journal's reversibility contract is preserved for the `add-data-protection-defaults` change in flight.
- **Coordination**: `filter-empty-sessions-from-context` (in progress) also edits `handleContext` — land that change first or rebase this one over it.
