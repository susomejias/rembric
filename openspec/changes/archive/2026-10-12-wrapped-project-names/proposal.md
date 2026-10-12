## Why

The owner cannot identify projects from anonymous ranks in the authenticated Wrapped viewer. The owner explicitly requested real project names; shared PNGs must remain anonymous.

## What Changes

- Show each ranked project's display name, falling back to its slug, in the private viewer.
- **BREAKING**: internal Wrapped project rankings carry names with counts instead of bare counts.
- Keep PNGs limited to aggregate project totals, without project names or distribution labels.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `dashboard-wrapped`: allow project names in authenticated recap data, not exported images.

## Impact

`packages/db/src/repositories/wrapped-repository.ts`, `apps/web/src/components/dashboard/wrapped.tsx`, their repository/page/image tests and the browser check. No migrations, new dependencies, MCP changes, or changes to append-only storage and scope enforcement.
