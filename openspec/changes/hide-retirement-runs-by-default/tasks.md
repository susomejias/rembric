## 1. Contract

- [x] 1.1 Write the proposal, design and the `dashboard` MODIFIED delta so that `openspec validate hide-retirement-runs-by-default --strict` passes.

## 2. Repository read

- [x] 2.1 Add failing tests in `packages/db/src/repositories/consolidation-repository.test.ts` for the hidden kind in `adminListRuns` and `adminCountRuns`, plus a control that other `maintenance` kinds, non-JSON summaries and the unfiltered call are unchanged; observe RED.
- [x] 2.2 Implement the optional hidden kind and export `RETIREMENT_RUN_KIND` from `@rembric/core`; observe GREEN.

## 3. Dashboard

- [x] 3.1 Add failing tests in `apps/web/src/test/dashboard/consolidation.test.tsx` for the default hide, the `show-maintenance` toggle, the pager keeping it, and other `maintenance` runs staying listed; observe RED.
- [x] 3.2 Implement the toggle and filtered listing in `apps/web/src/app/dashboard/consolidation/page.tsx`; observe GREEN.

## 4. Verification

- [x] 4.1 Mutation-check the filter condition with `node scripts/mutate.mjs` and confirm the naming test goes red.
- [x] 4.2 Run `pnpm run typecheck`, `pnpm run lint`, `pnpm test`, `pnpm run check:delta-freshness`, `pnpm run check:delta-sections` and `pnpm run check:spec-crossrefs`.
