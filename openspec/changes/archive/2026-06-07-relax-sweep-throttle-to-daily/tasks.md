# Tasks: relax-sweep-throttle-to-daily

## 1. Implementation

- [x] 1.1 `apps/server/src/consolidation/runner.ts`: `DEFAULT_MIN_INTERVAL_MS` 6h → 24h
- [x] 1.2 `apps/server/src/test/dashboard-e2e.test.ts`: home copy assertion `THROTTLED 6H / SCOPE` → `THROTTLED 24H / SCOPE`
- [x] 1.3 `apps/server/src/scripts/seed-dev.ts`: fictional summary "per 6h" → daily cadence wording
- [x] 1.4 Grep gate: `git grep -n "6 \* 3_600_000\|6H / SCOPE" apps/server/src` returns nothing

## 2. Gates

- [x] 2.1 `pnpm run typecheck`, `pnpm run lint`, `pnpm test` pass
