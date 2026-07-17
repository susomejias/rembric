## Why

Two hardening fixes to the shared HTTP/MCP surface, both already implemented and tested: unexpected (non-domain) errors on the `/api` and `/admin` HTTP routes leaked the raw `err.message` to the caller (the MCP tool surface already withheld this via `errToMcp`); and the `/api/<slug>/sessions/:id/{summary,end}` routes resolved a session by `(token_id, id)` only, never checking that the session belongs to the connected project — letting a token bypass an archived-project write-freeze by presenting a session through an unrelated, non-archived slug.

## What Changes

- **Shared internal-error contract (#255).** Extracted `errToMcp`'s existing "generic message + correlatable errorId, real error logged server-side only" logic into `apps/server/src/server/error-response.ts` (`logInternalError` / `httpInternalError`). `errToMcp` now delegates to it (no behavior change there — it was already correct). `api-router.ts`'s `domainErr`, `http.ts`'s `respondInternal`, and the `/admin/consolidation/run` handler now delegate to the same helper instead of echoing `err.message`.
- **Session-route project-match + write-authz (#256).** `POST /:slug/sessions/:id/summary` and `.../end` now call `isAuthorized(ctx.scope, 'write', {scope:'project', projectId})` (mirroring the sibling `POST /:slug/sessions` and `/:slug/memory/recall` routes in the same file), and `rejectIfDeleted` now also rejects when the loaded session's `projectId` doesn't match the connected project — surfaced as `session_not_found` (identical to the existing token-mismatch behavior), so the response never confirms whether a session exists under a different project.

No breaking changes for well-formed same-project requests. No invariant changes.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `mcp-api`: ADD a requirement that unexpected (non-domain) errors on any HTTP-exposed surface — MCP tool calls, `/api` session routes, and `/admin` routes — return a generic message plus a correlatable `errorId`, with the real error and stack logged server-side only. Documents `errToMcp`'s existing behavior for the first time, and extends the same guarantee to the HTTP surfaces that previously lacked it.
- `http-api`: MODIFY the `POST /api/<slug>/sessions/:id/summary` and `.../end` requirements — the session resolution key changes from `(token_id, id)` to `(token_id, project_id, id)`; a project mismatch (same as a token mismatch) surfaces as `session_not_found`.

## Impact

- `apps/server/src/server/error-response.ts` — new shared module (`logInternalError`, `httpInternalError`).
- `apps/server/src/mcp/errors.ts` — `errToMcp` delegates to the shared helper.
- `apps/server/src/server/api-router.ts` — `domainErr` delegates to the shared helper; `rejectIfDeleted` gains a `projectId` parameter and check; both session-mutation routes gain the `isAuthorized` write check.
- `apps/server/src/server/http.ts` — `respondInternal` and the `/admin/consolidation/run` catch delegate to the shared helper.
- Issues: #255, #256.
