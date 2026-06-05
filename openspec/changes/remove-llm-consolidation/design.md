# Design — remove-llm-consolidation

## Context

The v0.5 consolidation rework (`2026-05-14-convergent-saves-and-synchronous-judgment`) deleted LLM corpus scanning and left the nightly consolidator with two jobs: deterministic decay and LLM-assisted orphan promotion of aged pending relations. That residual LLM path is now the only chat-LLM consumer in the whole process (`memory.suggest_topic_key` is heuristic; `memory.search` is FTS5; `memory.compare` is agent-driven), and the cron is the only scheduler. The fallback behavior when the LLM fails — mark the pending relation `orphaned` — already is the deterministic semantics this change promotes to the only behavior, with one improvement: before orphaning, give the agent a window to judge under fresh context.

Exploration findings this design relies on:

- `consolidation_ops`/`consolidation_runs` are shared infrastructure: maintenance purges journal there today, `add-data-protection-defaults` will journal `backup_snapshot` ops there. They are out of scope for removal.
- The session lifecycle is HTTP-first (plugin hooks POST `/api(/:slug)/sessions`); MCP `memory.session_start` is the secondary path. Both must trigger the sweep.
- `RelationsService` already has the needed primitives: `findPendingOlderThan(ms, batch)`, `orphan(judgmentId, reason)`, `judge(...)`.
- Doctor's `llm.reachable` is hardcoded `false` today — the block carries no information.

## Goals / Non-Goals

**Goals:**

- Zero LLM calls and zero schedulers in the server process.
- Pending relations keep converging: agent-first (fresh context), deterministic orphaning as terminal fallback.
- Journal + undo semantics byte-compatible with today for decay and orphan ops.
- Operator config shrinks; stale env vars never crash a boot.

**Non-Goals:**

- Embeddings/`memory_vec`/`EmbeddingWorker` — follow-up change `embed-embeddings-in-process`.
- Any schema migration (legacy `llm_*` columns stay).
- Redesigning the dashboard consolidation page beyond what the trigger rename forces.
- Backfilling judgments for already-orphaned relations.

## Decisions

### D1 — Sweep triggers on session start, throttled, never on the request's critical path

The sweep runs as a post-response side effect of session creation (`AgentSessionsService.ensure`/`start` callers), guarded by a per-scope throttle: skip if the latest `consolidation_runs` row for that scope is younger than `SWEEP_MIN_INTERVAL_MS` (internal constant, 6h). Failures log and never fail the session call.

- _Alternative — keep a deterministic cron_: rejected. A store nobody reads needs no grooming; hygiene only matters at read time, and read time implies traffic, which implies sweeps. Removing `croner` is part of the payoff.
- _Alternative — sweep on every `memory.save`_: rejected; save is the hottest path and decay/orphan windows are measured in days — session granularity is more than enough.
- _Alternative — opportunistic in `memory.context`_: rejected; context is a read tool and should stay side-effect-free.

### D2 — Pending lifecycle: re-expose, then deterministically orphan

```
pending ──(>24h, JUDGMENT_ORPHAN_AFTER_MS)──► included in memory.context pendingJudgments[] (cap 5, oldest first)
   │                                                  │ agent calls memory.judge ──► judged
   └──(>14d, JUDGMENT_ORPHAN_DEADLINE_MS)──► sweep marks orphaned (journaled op, undoable)
```

`pendingJudgments[]` entries carry `judgmentId`, both memory snippets, and ages — enough for the agent to judge without extra reads. Scope-filtered like everything else in context.

- _Alternative — orphan at 24h with no second chance (today's LLM-failure fallback)_: rejected; genuinely conflicting memories would both stay active with no verdict and no signal to anyone. The re-expose window costs nothing and matches the fresh-context invariant.
- _Alternative — block or nag in `memory.save` responses_: rejected; punishes the wrong session and bloats the hot path.

### D3 — Sweep keeps writing the same journal rows

Decay ops (`op_type='decay'`) and orphan ops keep today's shapes; `consolidation_runs` gains nothing and loses nothing — new rows simply write `llm_provider/llm_model = null` (columns already nullable; dashboard already renders `—`). `undoOp`/`undoRun` continue to work unmodified for both op types.

- _Alternative — new `sweep_runs` table or renamed op types_: rejected; would break undo, the dashboard, the maintenance allow-lists, and the in-flight backup change for zero benefit.

### D4 — Stale env vars warn, don't crash

`config.ts` drops the seven removed keys from the schema. A boot-time check lists any of the removed names still present in the environment and logs one warning line naming them — operators upgrading from ≤0.20 see what to clean, nothing breaks.

- _Alternative — hard fail on unknown REMBRIC-relevant vars_: rejected; punishes upgrades for vars that no longer matter.

### D5 — Resurrection guard extended

`removed-exports.test.ts` already pins the v0.1 detectors dead. Extend it: importing `judge`, `ConsolidationScheduler`, or referencing `croner` anywhere under `src/` (tests excluded) fails the suite. The invariant test for the migration runner and DELETE allow-lists is untouched.

## Risks / Trade-offs

- [Risk] Conflicting pendings whose agent never returns (one-off sessions) get orphaned without a verdict at 14d → Mitigation: both memories stay `active` and visible; `memory.compare` lets any future agent re-open the question; orphaning is journaled and undoable.
- [Risk] Sweep on session start adds latency where the plugin hook is latency-sensitive → Mitigation: throttle short-circuits to one indexed SELECT in the common case; the sweep itself runs after the response is sent; failures are swallowed and logged.
- [Risk] `filter-empty-sessions-from-context` (in flight) edits `handleContext` concurrently → Mitigation: land that change first; this change rebases trivially (additive block in the response).
- [Trade-off] Aged pendings now depend on agents actually reading `pendingJudgments[]` → Accepted because the 14d deterministic deadline bounds the worst case, and the previous LLM verdicts were context-free judgments of lower quality than a fresh-context agent or an explicit orphan.
- [Trade-off] Operators lose the "consolidate at 3am" knob → Accepted because the sweep is idempotent, cheap (two indexed scans), and the dashboard manual trigger remains for forcing a run.

## Migration Plan

1. Ship as a server minor (pre-1.0) with **BREAKING** markers in the changelog; no DB migration, no plugin release.
2. On first boot after upgrade: stale env warning (D4); first session start runs the sweep, which subsumes anything the cron would have done.
3. Rollback = redeploy previous image; journal rows written by the sweep are fully compatible with the old runner.

## Open Questions

(none — decisions were closed during the exploration session of 2026-06-05)
