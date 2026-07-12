## 1. Implementation

- [x] 1.1 `apps/server/src/db/repositories/agent-sessions-repository.ts`: `findActiveForTransport` fetches up to 2 candidate rows (`limit(2)`) instead of 1, and returns `undefined` unless exactly one row came back.

## 2. Tests

- [x] 2.1 Rewrote `agent-sessions.test.ts`'s `"findActiveForTransport returns the most recent active session for the pair"` test (now `"findActiveForTransport returns the sole active session for the pair"`, single-session case) and added a new test asserting two active sessions resolve to `null`.
- [x] 2.2 Rewrote `memory-tools.test.ts`'s `"attaches to the MOST recent active session when multiple exist"` test (now `"saves with session_id=null (never guesses) when two active sessions exist..."`) to assert `session_id: null` instead of picking the newer one.
- [x] 2.3 Added `apps/server/src/mcp/session-tools.test.ts` (new file — no prior test coverage existed for `memory.session_start`'s reuse logic) covering both the single-session reuse case and the two-session mint-fresh case.

## 3. Verification

- [x] 3.1 `pnpm run typecheck` and `pnpm run lint` clean.
- [x] 3.2 Full suite: `pnpm vitest run` — 84 files, 1137 passed, 1 skipped (pre-existing, unrelated).
- [x] 3.3 `openspec validate fix-cross-session-misattribution` clean.
