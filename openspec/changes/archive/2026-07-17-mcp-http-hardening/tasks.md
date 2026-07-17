## 1. Shared internal-error contract (#255)

- [x] 1.1 Add `apps/server/src/server/error-response.ts` (`logInternalError`, `httpInternalError`).
- [x] 1.2 `apps/server/src/mcp/errors.ts`: `errToMcp` delegates to `logInternalError` instead of inlining the errorId/logging logic.
- [x] 1.3 `apps/server/src/server/api-router.ts`: `domainErr`'s unexpected-error branch delegates to `httpInternalError`.
- [x] 1.4 `apps/server/src/server/http.ts`: `respondInternal` and the `/admin/consolidation/run` catch block delegate to `httpInternalError`.
- [x] 1.5 Add a unit test for `logInternalError`/`httpInternalError`: never returns the raw message/stack, logs server-side with the same `errorId` returned to the caller, handles a non-Error throw.
- [x] 1.6 Confirm the pre-existing `mcp/errors.test.ts` suite passes unmodified (proves `errToMcp`'s observable behavior didn't change).

## 2. Session-route project-match + write-authz (#256)

- [x] 2.1 `rejectIfDeleted` gains a `projectId` parameter; rejects with `session_not_found` when the loaded row's `projectId` doesn't match, identically to the existing token-mismatch branch.
- [x] 2.2 `POST /:slug/sessions/:id/summary`: add the `isAuthorized(ctx.scope, 'write', ...)` check (mirroring `POST /:slug/sessions`); pass `ctx.project.id` into `rejectIfDeleted`.
- [x] 2.3 `POST /:slug/sessions/:id/end`: same two changes.
- [x] 2.4 Add a regression test per route reproducing the exact archived-project bypass: create a session under project A, archive A, then POST to `/summary` (and separately `/end`) via a different, non-archived project B's slug with the same token — assert `404 session_not_found` and that the row was not mutated.
- [x] 2.5 Add a regression test per route: a project-scoped token whose scope doesn't cover the connected slug gets `403 forbidden`.

## 3. Validation

- [x] 3.1 `pnpm run typecheck` and `pnpm run lint` clean.
- [x] 3.2 `pnpm test` full suite green.
- [x] 3.3 `openspec validate mcp-http-hardening --strict` passes.
- [x] 3.4 Update issues #255, #256 with the outcome after merge.
