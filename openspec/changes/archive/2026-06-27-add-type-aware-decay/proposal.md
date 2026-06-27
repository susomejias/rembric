# add-type-aware-decay

## Why

Decay applies one global 90-day threshold to every memory type. `DEFAULT_DECAY` in `apps/server/src/consolidation/decay.ts:20-23` carries a single `thresholdMs = 90 * 24 * 60 * 60 * 1000`, and `findDecayCandidateIds` in `apps/server/src/db/repositories/memory-repository.ts:476-499` takes one scalar `cutoff` for all rows — the decay query is type-blind. Yet the orthogonal review axis already encodes per-type shelf life: `REVIEW_TTL_MS` in `apps/server/src/services/review.ts:31-39` keeps a once-stated `user` preference for 12 months, `feedback` for 6, `project` for 3, and `reference` indefinitely. The result is a mismatch: a durable `user` preference nobody happens to re-read is archived on the same 90-day clock as a throwaway `reference`. Decay should respect that types have different shelf lives, while staying deterministic (no LLM, no cron) and keeping the decay and review axes orthogonal.

## What Changes

- Replace the single `thresholdMs` in `DEFAULT_DECAY` with a static per-type threshold map mirroring the shape of `REVIEW_TTL_MS` (a `Partial<Record<MemoryType, number>>`) plus a `defaultThresholdMs` fallback for any type without an explicit entry. **BREAKING** to the internal `DecayThresholds` shape (`thresholdMs: number` → per-type map + default); no MCP tool, HTTP route, or plugin manifest changes, so no plugin-manifest churn.
- Teach the decay candidate query to filter per-type. `findDecayCandidateIds` gains a `thresholdByType` ladder parameter (the same `ReadonlyArray<readonly [MemoryType, number]>` shape `findNeedsReview` already accepts) plus a `defaultThresholdMs`, and selects rows where `last_seen_at < (now - per-type threshold)` using a `CASE WHEN type = ? THEN ms ... ELSE defaultMs END` expression — exactly the `CASE` ladder pattern already proven in `runNeedsReview` (`apps/server/src/db/repositories/memory-repository.ts:563-592`).
- Keep the decay axis keyed on `last_seen_at` + confidence floor as today; only the threshold becomes type-varying. The review axis (keyed on `created_at` + confirmation baseline + `REVIEW_TTL_MS`) is untouched: the two axes stay orthogonal and independently keyed.
- Update the runner decay step (`apps/server/src/consolidation/runner.ts:109-123`) to pass the per-type map and emit a deterministic reasoning string that no longer hard-codes a single `thresholdMs`.
- `reference` keeps a long (or effectively never) decay threshold so reference rows are not archived on a short clock, matching its review intent of "no TTL"; `confidenceFloor` semantics are unchanged.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `consolidation`: the deterministic decay pass selects candidates by a static per-type `last_seen_at` threshold (with a default fallback) instead of one global 90-day threshold; still no LLM, still keyed on `last_seen_at` + confidence, still orthogonal to the review axis.

## Impact

- `apps/server/src/consolidation/decay.ts` — `DecayThresholds` shape, `DEFAULT_DECAY` (per-type map + default), `findDecayCandidates` signature, cutoff computation.
- `apps/server/src/db/repositories/memory-repository.ts` — `findDecayCandidateIds` gains the per-type threshold ladder + default fallback (the `CASE` expression mirrors `runNeedsReview`).
- `apps/server/src/consolidation/runner.ts` — `runScope` decay step passes the per-type map; deterministic reasoning string updated.
- `apps/server/src/consolidation/index.ts` — re-exported `DecayThresholds` / `DEFAULT_DECAY` shape changes ride along (barrel only).
- `apps/server/src/consolidation/operations.test.ts`, `apps/server/src/consolidation/runner.test.ts`, `apps/server/src/db/repositories/memory-repository.test.ts` — decay coverage extended for per-type thresholds and the default fallback.
- `openspec/specs/consolidation/spec.md` — decay requirement made type-aware (synced from this change at archive).
