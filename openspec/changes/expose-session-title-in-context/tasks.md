## 1. Implementation

- [x] 1.1 In `apps/server/src/mcp/sessions-tools.ts`, add `title: s.title` to the `recentSessions` mapping in `handleContext` (next to `summary`), verbatim and untruncated. No repository change — `recentForContext` already returns the full row.

## 2. Tests

- [x] 2.1 In `apps/server/src/test/mcp-integration.test.ts`, assert a session summarized with a title (`memory.session_summary({ summary, title })`) exposes that exact `title` verbatim in `recentSessions[]` (full, including a title longer than would be snippet-truncated if it were treated as long-form — it must NOT be truncated).
- [x] 2.2 Assert a content-bearing session never summarized with a title still exposes its (placeholder) `title` as a non-null string (no hiding/nulling).

## 3. Verification

- [x] 3.1 `pnpm vitest run apps/server/src/test/mcp-integration.test.ts` passes with the new cases.
- [x] 3.2 `pnpm run typecheck` and `pnpm run lint` clean.
- [x] 3.3 `pnpm test` (full suite) green; `pnpm run build` succeeds.
- [x] 3.4 `openspec validate expose-session-title-in-context --strict` passes.
