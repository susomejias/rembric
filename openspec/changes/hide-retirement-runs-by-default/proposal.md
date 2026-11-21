## Why

Retiring a memory that has pending judgments orphans them in the same transaction. A `topic_key` revision, a judged `supersedes` and a merge undo journal those orphanings in a new `maintenance` run of kind `retirement_orphan`. `topic_key` revisions are the recommended, frequent workflow, so these runs land in `/dashboard/consolidation` several times a day and push the runs an operator actually inspects (the decay sweep, the stale-pending drain, the deadline step) off the first page.

## What Changes

- The runs listing at `/dashboard/consolidation` hides `maintenance` runs of kind `retirement_orphan` by default.
- A "Show maintenance runs" toggle keeps the choice in the `show-maintenance` URL query parameter, so the view stays shareable; pagination links keep it.
- Nothing is removed or merged: the runs stay journaled and undoable, the run detail and each op's undo are unchanged, and every other run (including operator purge and archive `maintenance` runs) stays listed. The toggle only filters the list.
- No schema change, no migration, no new MCP tool. The append-only journal is untouched.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `dashboard`: the consolidation runs listing hides retirement runs by default behind a URL-kept toggle.

## Impact

- `packages/db/src/repositories/consolidation-repository.ts`: `adminListRuns` and `adminCountRuns` accept an optional run kind to leave out of the `maintenance` scope.
- `packages/core/src/consolidation/operations.ts` and `packages/core/src/consolidation/index.ts`: the `retirement_orphan` kind becomes the exported `RETIREMENT_RUN_KIND` constant.
- `apps/web/src/app/dashboard/consolidation/page.tsx`: the toggle and the filtered listing.
- `packages/db/src/repositories/consolidation-repository.test.ts` and `apps/web/src/test/dashboard/consolidation.test.tsx`: behaviour tests.
