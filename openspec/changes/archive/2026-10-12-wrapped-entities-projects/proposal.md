## Why

Wrapped should show the breadth of technical references and the distribution of work across projects without revealing private identifiers. The user approved two additional scenes and a compact entity summary in the shared PNG.

## What Changes

- Add aggregate entity totals, fixed type distribution, recurrence and indexing coverage for memories saved in the selected year.
- Add anonymous top-four project memory counts plus Other, preserving the existing active-project definition.
- Add two story scenes and entity statistics to both PNG formats; keep all project names and entity values server-side.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `dashboard-wrapped`: entity and anonymous project aggregates, ten-screen story and expanded export.

## Impact

- `packages/db/src/repositories/wrapped-repository.ts` and its tests.
- `apps/web/src/components/dashboard/wrapped.tsx`, `wrapped-image.ts` and tests.
- `apps/web/src/app/globals.css`, Wrapped page boundary tests and `scripts/check-wrapped-browser.mjs`.
- Read-only admin aggregation; no migrations, dependencies, MCP tools or changes to append-only memory, scope-at-service, topic convergence or judgments.
