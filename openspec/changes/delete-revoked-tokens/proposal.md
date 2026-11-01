## Why

Revoked tokens remain in the dashboard indefinitely with no cleanup action. Operators need to remove unused credentials from the list without destroying the sessions and memories attributed to them.

## What Changes

- Add a confirmed Delete action for revoked tokens only. Active and expired-but-not-revoked tokens must first be revoked.
- Soft-delete credentials by immutable token ID; keep their names reserved and retain their historical associations.
- Exclude deleted credentials from the dashboard list and refuse their dashboard sessions. Bearer access remains revoked.
- No bulk delete, restore, physical purge, MCP tool or OAuth grant cascade.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `dashboard`: confirmed, administrator-only deletion of revoked tokens.
- `auth`: token tombstones preserve revocation and bootstrap semantics; deleted credentials cannot authorize dashboard sessions.
- `persistence`: nullable token deletion timestamp and retained provenance.

## Impact

- `packages/db/src/schema/tokens.ts` and generated migrations/snapshots.
- `packages/db/src/repositories/tokens-repository.ts` and `dashboard-sessions-repository.ts`.
- `packages/core/src/services/tokens.ts` and service tests.
- `apps/web/src/app/dashboard/tokens/page.tsx`, `apps/web/src/components/dashboard/tokens-table.tsx` and focused dashboard tests.
- `apps/web/Dockerfile` and `.github/workflows/ci.yml`: advance the exact migration inventory from 38 to 39; keep missing/extra-file rejection.
- Existing append-only memory and session history remain untouched. No dependency or plugin changes.
