## Why

Operators want a visual, shareable recap of Rembric usage without exposing private memories. The approved OpenPencil design provides the direction; real aggregates, accessible motion and native social sharing will make it usable in the dashboard.

## What Changes

- Add a December/January UTC overview entry and year-round admin `/dashboard/wrapped` with a calendar-year selector; January defaults to the previous year. `REMBRIC_WRAPPED_FORCE=true` forces the entry outside the season.
- Show eight automatically advancing story screens with pause and lateral taps: introduction, totals, agent mix, memory categories, judgments, activity rhythm, monthly saves and share. Surface six core counts on the introduction, with a separate breakdown of retained judgments by decision type.
- Use only aggregate counts across the authenticated operator's instance, with explicit UTC/year-to-date semantics.
- Share the exact displayed PNG through the native device share sheet at Story (1080×1920) or Square (1080×1080) dimensions, with download only as a compatibility fallback.
- Preserve the existing logo, colors and fonts; support reduced motion, keyboard navigation and sparse/empty activity.

## Capabilities

### New Capabilities

- `dashboard-wrapped`: Privacy-safe yearly usage recap, navigation, animations and image export.

### Modified Capabilities

None.

## Impact

- `packages/db/src/repositories/wrapped-repository.ts` and `repositories/index.ts`: read-only bounded aggregates; SQL stays in the DB package.
- `apps/web/src/app/dashboard/wrapped/`: authenticated server page and pure derivation/export helpers.
- `apps/web/src/components/dashboard/wrapped.tsx`: interactive recap and client-side PNG export.
- `apps/web/src/app/dashboard/page.tsx`: overview entry; `globals.css`: scoped visuals without changing design tokens.
- Co-located repository and recap tests, plus local browser verification.
- No new project dependency, schema migration, MCP tool, public sharing endpoint or persistence. Append-only memory and service-layer scope rules remain unchanged; these are dashboard-only admin reads, not MCP reads.
