# Proposal: relax-sweep-throttle-to-daily

## Why

The lazy sweep's per-scope throttle is 6h, so an actively used server journals up to 4 `consolidation_runs` rows per scope per day — almost all no-op, since the conditions the sweep enforces are coarse (decay at 90 days unseen, orphaning at 14 days pending). Sub-daily cadence buys nothing and accumulates journal noise (the prod database once needed 201 no-op LLM-era runs purged manually).

## What Changes

- Raise `DEFAULT_MIN_INTERVAL_MS` (`apps/server/src/consolidation/runner.ts`) from 6h to 24h: at most one sweep per scope per day, triggered by the first session start outside the window. Manual trigger still bypasses.
- Dashboard home trigger cell updates automatically (it renders the exported constant) to `THROTTLED 24H / SCOPE`.
- Seed text mentioning the 6h cadence updated.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `consolidation`: the throttle requirement's internal minimum interval changes from 6h to 24h.

## Impact

- `apps/server/src/consolidation/runner.ts` — constant.
- `apps/server/src/test/dashboard-e2e.test.ts` — home copy literal (`THROTTLED 6H / SCOPE` → `24H`).
- `apps/server/src/scripts/seed-dev.ts` — fictional session summary citing "per 6h".
- No migration, no API change, no new env var (the interval stays internal by design — engine tuning, not deployment config).
