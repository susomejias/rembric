# Design: relax-sweep-throttle-to-daily

## Context

The throttle is a minimum separation between sweeps of the same scope, not a schedule — sweeps only fire on session start. With daily usage, 6h yields 1–4 sweeps/scope/day; the conditions enforced (decay > 90d, orphan > 14d) cannot change meaningfully between same-day sweeps.

## Goals / Non-Goals

**Goals:** at most one sweep per scope per day under normal usage; less no-op journal noise.

**Non-Goals:** no env var for the interval (engine tuning, not deployment config — per the `embed-embeddings-in-process` rule); no change to sweep semantics, manual bypass, or lazy trigger model.

## Decisions

### D1 — 24h, not 12h

Both are safe; 12h still doubles the row count for zero behavioral difference against 90d/14d thresholds. Pending-judgment re-exposure (>24h) is computed at `memory.context` read time, not by the sweep, so it is unaffected by sweep cadence.

- _Alternative — make the interval an env var_: rejected; a knob nobody should turn. The removed-env-vars rule ("a var survives only if it configures the deployment, never the engine") applies.

## Risks / Trade-offs

- [Trade-off] Orphaning can now lag up to ~25h past the 14-day deadline instead of ~6h → Accepted; the deadline itself is two orders of magnitude larger than the lag.

## Migration Plan

Constant change; ships in a normal release. No data impact.

## Open Questions

None.
