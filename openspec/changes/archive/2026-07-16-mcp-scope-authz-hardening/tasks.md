## 1. Reclassify `memory.compare` as a write

- [x] 1.1 `apps/server/src/mcp/relations-tools.ts` (`handleCompare`, ~:269): change `requireScope(deps, 'read')` → `requireScope(deps, 'write')`. Leave the scope-target validation (`compareInScope` against the effective scope, `not_found` masking) untouched.
- [x] 1.2 Verify the `IDEMPOTENT_WRITE` behavioral annotation for `memory.compare` in `apps/server/src/mcp/server.ts` still matches (it already declares a write).
- [x] 1.3 Grep for any other read-classified handler that reaches a write in its service call (spot-check `relations-tools.ts` and `memory-tools.ts` read handlers) to confirm compare was the only misclassification.

## 2. Validate an explicit `sessionId` on the write-attaching tools

- [x] 2.1 Add a shared validator (one place) that, given an explicit `sessionId`, the request context token id, and the effective `projectId`, loads the row via `AgentSessionsService.getById` and enforces: owned by token, `project_id === effectiveProjectId` (both null for global), `deleted_at IS NULL`. Return a discriminated result → map to `session_not_found` (owner/project fail) or `session_deleted` (soft-deleted).
- [x] 2.2 `apps/server/src/mcp/memory-tools.ts` (`resolveActiveSessionId`, ~:421): when `explicit` is passed, run the validator before returning it; on failure throw the mapped `DomainError`. Applies to `memory.save`.
- [x] 2.3 `apps/server/src/mcp/_shared.ts` (`resolveSessionId`, ~:118): same validation on the `explicit` branch. Applies to `memory.save_prompt`, `memory.capture_passive` (and confirms parity for `session_summary`/`session_end`, which also route explicit ids here or through their service cross-token check).
- [x] 2.4 Confirm both resolvers have `agentSessions` + token context available at the call site (they do — `deps.agentSessions`, `getRequestContext()`); thread `projectId` (already a parameter).
- [x] 2.5 Confirm `memory.session_summary`/`memory.session_end` are not double-penalized: their service layer already rejects foreign/soft-deleted ids; ensure the resolver-level check returns the same codes so behavior is consistent, not conflicting.

## 3. Scope-filter `memory.timeline` neighbors

- [x] 3.1 `apps/server/src/db/repositories/memory-repository.ts` (`sessionNeighbors`, ~:132): add a `scope: MemoryScope` field to the opts and AND the `(scope, project_id)` predicate onto the `where`, mirroring `windowNeighbors`.
- [x] 3.2 `apps/server/src/services/memory.ts` (timeline method): thread the already-resolved effective scope into the `sessionNeighbors` call. No new resolver call.
- [x] 3.3 Confirm the `before[]`/`after[]` ordering, limit clamping (combined ≤50), and `title` exposure are unchanged.

## 4. Tests

- [x] 4.1 Authorization: extend `apps/server/src/mcp/**/authorization.test.ts` (or the nearest authz test) with a `read:*` token calling `memory.compare` → `forbidden`, no relation row, no status flip; and a `*`/`write` token → succeeds.
- [x] 4.2 sessionId validation: for `memory.save`, `memory.save_prompt`, `memory.capture_passive`, cover (a) foreign-token id → `session_not_found`, (b) cross-project id → `session_not_found`, (c) own soft-deleted id → `session_deleted`, (d) own valid in-scope id → attaches. Add near `session-scope-resolution.test.ts`.
- [x] 4.3 timeline scope: target in project A with a same-`session_id` memory in global/project B → that memory is NOT in `before`/`after`; in-scope same-session neighbors still returned.
- [x] 4.4 Regression: existing MCP/authz/session tests stay green; `pnpm run typecheck` + `pnpm run lint`.

## 5. Spec delta

- [x] 5.1 Confirm `specs/mcp-api/spec.md` MODIFIED requirements move `memory.compare` to the write list and add the explicit-`sessionId` validation clause + rejection scenarios, and the ADDED requirement covers timeline scope filtering. (Done in this change dir.)

## 6. e2e + ship

- [x] 6.1 Local e2e against `pnpm run dev:docker:up` (per `rembric-smoke-tests`): drive `memory.compare` with a read-only token (rejected), a forged `sessionId` on `memory.save` (rejected), and a `memory.timeline` that must not cross scope.
- [x] 6.2 Full `pnpm test` green (pre-push). Do NOT bypass hooks.
- [x] 6.3 Conventional commits, one per concern where practical: `fix(mcp): classify memory.compare as a write`, `fix(mcp): validate explicit sessionId ownership/project/soft-delete`, `fix(mcp): scope-filter memory.timeline session neighbors`. Open a PR (title + body in English).
