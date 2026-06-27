# Design — add-type-aware-decay

## Context

The deterministic consolidation sweep runs two passes per scope (decay + deadline orphaning) with no LLM and no cron (`apps/server/src/consolidation/runner.ts:11-26`). The decay pass archives `status='active'` rows whose `last_seen_at` is older than a threshold and whose confirmation count is below a floor (`apps/server/src/consolidation/decay.ts:5-7`).

Today that threshold is a single global constant: `DEFAULT_DECAY.thresholdMs = 90 days` (`decay.ts:20-23`). `findDecayCandidates` subtracts it from `now` to get one `cutoff` Date and hands that scalar to `findDecayCandidateIds`, which compares every active row's `last_seen_at` against the same cutoff regardless of `type` (`memory-repository.ts:476-499`).

The codebase already models per-type shelf life on the _review_ axis. `REVIEW_TTL_MS` (`apps/server/src/services/review.ts:31-39`) is a `Partial<Record<MemoryType, number>>` with `project: 3mo`, `feedback: 6mo`, `user: 12mo`, and `reference` deliberately absent (no TTL). The review query `runNeedsReview` (`memory-repository.ts:563-592`) turns that map into a SQL `CASE WHEN ${memory.type} = ${t} THEN ${ms} ... ELSE NULL END` ladder, fed in as `ttlByType: ReadonlyArray<readonly [MemoryType, number]>` so the constant lives in exactly one place. Services build that array by filtering `REVIEW_TTL_MS` entries (`services/memory.ts:267-269`, `dashboard/memories.ts:65-66`).

This change brings the same per-type shape to decay. It is intentionally a _threshold-only_ change: decay stays keyed on `last_seen_at` + confidence; review stays keyed on `created_at` + confirmation baseline + `REVIEW_TTL_MS`. The two axes remain orthogonal — we are not coupling them, only giving decay a per-type threshold the way review already has a per-type TTL.

## Goals / Non-Goals

Goals:

- Decay selects candidates using a static per-type `last_seen_at` threshold, with a sensible default for any type lacking an explicit entry.
- Reuse the proven `CASE` ladder pattern (`runNeedsReview`) so the per-type numbers live in exactly one place and the query stays index-friendly.
- Keep decay deterministic (no LLM, no new cron, no new mutation verb) and keep the decay/review axes orthogonal.
- `reference` rows get a long-or-never decay threshold, matching their "no review TTL" intent.

Non-Goals:

- No coupling of the decay and review axes (decay does NOT start reading `REVIEW_TTL_MS`, `created_at`, or confirmation baselines).
- No operator-configurable / env-driven decay thresholds — the map stays a static in-code constant, like `REVIEW_TTL_MS`.
- No new MCP tool, HTTP route, dashboard verb, or plugin-manifest change.
- No change to `confidenceFloor` semantics or to the orphaning pass.
- No schema/migration change (no new column; decay state stays derived from `last_seen_at`).

## Decisions

### Decision 1: Per-type threshold map + scalar default, not one global threshold

`DEFAULT_DECAY` becomes `{ thresholdByType: Partial<Record<MemoryType, number>>, defaultThresholdMs: number, confidenceFloor: number }`. A type present in `thresholdByType` uses its entry; a type absent falls back to `defaultThresholdMs` (the current 90 days is the natural default).

Alternatives considered:

- _Keep one global `thresholdMs`._ Rejected — that is exactly the problem: a durable `user` preference decays on the same clock as a throwaway `reference`.
- _Require every type to have an explicit entry (no default)._ Rejected — fragile against future `MemoryType` additions; a missing entry would silently exempt or over-archive a type. A default fallback degrades gracefully, mirroring how `runNeedsReview`'s `CASE` has an `ELSE` branch.
- _Reuse `REVIEW_TTL_MS` directly as the decay map._ Rejected — that couples the two axes (a review-TTL tweak would silently move the decay clock) and breaks orthogonality. The decay map is a _separate_ static constant that merely shares the _shape_ of `REVIEW_TTL_MS`.

### Decision 2: Push the per-type comparison into SQL via a `CASE` ladder, reusing the `runNeedsReview` pattern

`findDecayCandidateIds` gains `thresholdByType: ReadonlyArray<readonly [MemoryType, number]>` and `defaultThresholdMs: number`, and replaces the scalar `last_seen_at < cutoff` predicate with `last_seen_at < (now - CASE WHEN type = ? THEN ms ... ELSE defaultMs END)`. `findDecayCandidates` passes `now` (ms) instead of a pre-computed `cutoff`, since the cutoff is now per-row.

Alternatives considered:

- _Compute one cutoff per type in TS and issue N queries (one per type), unioning ids._ Rejected — more round-trips and more code than the single `CASE` query the repo already demonstrates in `runNeedsReview`; loses the single-statement atomicity the current decay query has.
- _Fetch all active rows and filter per-type in TS._ Rejected — violates the data-access confinement intent (predicate belongs in SQL, like every other scoped query) and scans rows the index could exclude. The existing query already filters in SQL via the `statusLastSeenIdx` index (`schema/memory.ts:85`); keep that.

### Decision 3: Extend the existing `findDecayCandidates` / `findDecayCandidateIds` in place — do NOT add a new function or MCP tool

The decay path is internal (consolidation runner → repository); it is not an MCP tool or HTTP route. Extending the existing function signatures is backward-compatible at the _behavioral_ surface (same sweep, same journaled `decay` op) and touches zero plugin manifests.

Alternatives considered:

- _Add a new `findDecayCandidateIdsTyped` alongside the old one._ Rejected — leaves two decay code paths and a dead type-blind one, inviting drift; the old one has no remaining caller. The internal `DecayThresholds` shape change is acceptable because it is not a public contract (no MCP tool, no manifest), and is grep-confined to `consolidation/` + the repo. Documented as the preferred path precisely because it avoids the plugin-manifest churn a new tool/verb would force.
- _Introduce a new MCP tool or HTTP knob to expose per-type thresholds._ Rejected — out of scope and would force a unified plugin version bump across all four clients for a purely internal threshold change. The map stays a static in-code constant (Non-Goal).

### Decision 4: Deterministic reasoning string no longer hard-codes a single `thresholdMs`

`runScope` currently writes `` `last_seen_at older than ${thresholdMs}ms with low confidence` `` (`runner.ts:120`). With per-type thresholds there is no single number. The reasoning becomes a deterministic, type-agnostic string (e.g. `last_seen_at older than per-type decay threshold with low confidence`) so the journaled `decay` op stays deterministic and idempotent.

Alternatives considered:

- _Embed the full per-type map in the reasoning string._ Rejected — noisy in the dashboard and still deterministic only if the map never changes; the requirement is just that the op be deterministic and journaled, not that it restate the config.

## Risks / Trade-offs

- [Trade-off] The internal `DecayThresholds` shape changes (`thresholdMs: number` removed). → Accepted because it is not a public contract — no MCP tool, HTTP route, or plugin manifest references it; usage is grep-confined to `consolidation/` and the repository, and all call sites are updated in this change.
- [Risk] A future `MemoryType` added without a `thresholdByType` entry silently uses `defaultThresholdMs`. → Mitigation: the default is the safe, current 90-day behavior (no regression vs. today's global threshold), and the `CASE … ELSE defaultMs` branch makes the fallback explicit and tested.
- [Risk] Lengthening `reference` (or any type) decay could let stale rows linger longer than today. → Mitigation: the confidence floor is unchanged, the review axis still surfaces shelf-life nudges independently, and an operator can still force-archive via the dashboard; decay never deletes (append-only — status flip only).
- [Risk] Per-row `CASE` in the `WHERE` could in principle reduce index selectivity vs. the scalar cutoff. → Mitigation: the same `CASE`-in-`WHERE` shape already ships in `runNeedsReview` without an index problem; the `status` + `last_seen_at` predicates still bind to `memory_status_last_seen_idx` (`schema/memory.ts:85`), and corpora are small (single-SQLite-file scale).
- [Trade-off] Decay and review now both express per-type lifetimes, which could read as "two TTLs for the same thing". → Accepted because they remain orthogonal by construction: different keys (`last_seen_at`+confidence vs. `created_at`+confirmation), different outcomes (archive vs. `needs_review` hint), and two _separate_ constants. The load-bearing invariant in `CLAUDE.md` ("two orthogonal staleness axes") is preserved.

## Migration Plan

- No DB migration: decay remains derived from `last_seen_at`; no new column.
- Code-only change. Update `decay.ts`, `findDecayCandidateIds`, the runner decay step, and the barrel re-export type. Update the three decay-touching tests.
- No operator action, no env var, no plugin update. A running server picks up the new thresholds on the next sweep; behavior for any type without an explicit entry is identical to today (default = 90 days).
- Rollout is a single server release (`server-v*`); plugin tracks are untouched.

## Open Questions

- Final per-type decay numbers: should the decay map exactly equal `REVIEW_TTL_MS` (project 3mo / feedback 6mo / user 12mo) or be deliberately _longer_ than review TTLs (decay = hard archive, review = soft nudge, so decay should be the more forgiving of the two)? The leaning is decay ≥ review per type, with `reference` long-or-effectively-never and `defaultThresholdMs = 90d`; the exact constants are finalized in implementation (`/opsx:apply`) and asserted by the unit tests rather than fixed in the spec.
