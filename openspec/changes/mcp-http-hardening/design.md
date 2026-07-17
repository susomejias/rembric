## Context

Two independent hardening fixes on the shared HTTP/MCP request-handling surface, grouped because both are small, already-implemented, low-risk changes to `apps/server/src/server/{api-router,http}.ts` discovered in the same review pass.

## Goals / Non-Goals

**Goals:**

- Make every HTTP-exposed surface (MCP tools, `/api`, `/admin`) follow the same "generic message + errorId, no leak" contract `errToMcp` already implemented correctly.
- Close the archived-project write-freeze bypass: a session-mutation route must reject when the session's own project doesn't match the connected project, not just when the token doesn't match.

**Non-Goals:**

- Not changing `DomainError` behavior — recognized errors keep their own code/message verbatim; only the unexpected-error path changes.
- Not adding a `projectId` field to the service-layer `WriteSummaryInput`/`EndSessionInput` — the project-match check is enforced at the router (matching how the sibling `POST /:slug/sessions` and `/:slug/memory/recall` routes in the same file enforce authz at the router, not the service).

## Decisions

### D1. One shared helper, not a duplicated pattern per surface

`mcp/errors.ts::errToMcp` already generates an `errorId`, logs the stack server-side, and returns a generic message — exactly the contract the HTTP surfaces lacked. Rather than re-implementing that logic three more times (`domainErr`, `respondInternal`, `/admin/consolidation/run`), extracted it into `apps/server/src/server/error-response.ts`:

- `logInternalError(err, context): string` — the shared log-and-correlate step, returns the `errorId`.
- `httpInternalError(err, context): InternalErrorBody` — wraps it in the JSON body shape the HTTP surfaces return.

`errToMcp` now calls `logInternalError` too (its own behavior is unchanged — same errorId generation, same log call shape — verified by the pre-existing `errors.test.ts` suite passing unmodified). This means the "no leak" contract can no longer drift between the MCP and HTTP surfaces independently, which is exactly how it drifted in the first place.

**Where the helper lives:** `server/` — `mcp/` already imports from `server/` elsewhere (e.g. `request-context.js`, `session-router.js`), so `mcp/errors.ts` importing `server/error-response.js` doesn't introduce a new dependency direction or a circular import.

### D2. Project-match check lives in `rejectIfDeleted`, alongside the existing token-match check

`rejectIfDeleted` already loads the session row to check `row.tokenId !== callerTokenId`; adding `row.projectId !== projectId` to the same condition, returning the same `session_not_found` response, is the minimal fix and — deliberately — mirrors the existing precedent of NOT distinguishing "wrong token" from "not found" in the response. A project mismatch gets the identical treatment for the identical reason: a `404` reveals nothing about whether a session with that id exists under a different project, whereas a distinct error code would.

### D3. `isAuthorized` check added at the router, mirroring the sibling routes verbatim

`POST /:slug/sessions` and `POST /:slug/memory/recall` (same file) both call `isAuthorized(ctx.scope, 'write'|'read', {scope:'project', projectId: ctx.project.id})` before doing any work. `/summary` and `/end` now do the identical check. This is belt-and-suspenders relative to D2 for the common case (a project-scoped token can only ever own sessions under its own project, so token-ownership alone usually already implies authorization) — but it closes the gap for any token whose scope doesn't simply equal its session-ownership history (an admin token, a future scope model), and — more importantly — it makes all four mutating/reading routes in this file consistent, so a future contributor copying one route as a template can't accidentally omit the check on a fifth.

## Risks / Trade-offs

- **[A legitimate cross-project write pattern existed and now breaks]** → traced: no code path ever created a session under one project and then wrote to it via a different project's slug. The plugin hooks always POST to `/api/<slug>/sessions/:id/summary` using the SAME slug they created the session with. This is confirmed by the full existing test suite passing unmodified.
- **[The shared error helper changes `errToMcp`'s log call slightly]** → verified: `logInternalError`'s `logger.error(context, {errorId, message, stack})` call is byte-for-byte the same shape `errToMcp` used inline before; the pre-existing `errors.test.ts` (which asserts on `console.error` call content) passes without modification.

## Migration Plan

No migration — code-only, no schema change. Rollback is a plain revert.
