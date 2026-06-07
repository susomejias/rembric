## 1. Implementation

- [x] 1.1 In `apps/server/src/mcp/sessions-tools.ts`, add a module-level constant `CONTEXT_SNIPPET_CHARS = 350` above `handleContext`.
- [x] 1.2 Route `recentSessions[].summary` through the bound: `summary: s.summary ? snippet(s.summary, CONTEXT_SNIPPET_CHARS) : null` (was emitted verbatim).
- [x] 1.3 Route `recentPrompts[].content` through the bound: `content: snippet(p.content, CONTEXT_SNIPPET_CHARS)` (was emitted verbatim).
- [x] 1.4 Switch `recentMemories[].snippet` and `pendingJudgments[].sourceSnippet`/`targetSnippet` from the literal `200` to `CONTEXT_SNIPPET_CHARS` (no per-field literal remains in `handleContext`).

## 2. Tests

- [x] 2.1 In `apps/server/src/test/mcp-integration.test.ts`, add a test asserting that when a content-bearing session has a stored `summary` longer than 350 chars, the `memory.context` response's `recentSessions[].summary` is ≤ 350 chars AND ends with `…`.
- [x] 2.2 Add a test asserting a stored `summary` of ≤ 350 chars is returned verbatim in `recentSessions[].summary` with NO trailing `…`.
- [x] 2.3 Add a test asserting a session with `summary IS NULL` (content-bearing via an anchored memory) yields `recentSessions[].summary === null`.
- [x] 2.4 Add a test asserting storage is unaffected: after the session appears truncated in `memory.context`, reading the same row directly (agent-sessions service `getById`) returns the full, untruncated stored `summary`.

## 3. Verification

- [x] 3.1 `pnpm vitest run apps/server/src/test/mcp-integration.test.ts` passes, with the new cases green. (20/20)
- [x] 3.2 `pnpm run typecheck` and `pnpm run lint` are clean (no `any`, no floating promises, import ordering intact).
- [x] 3.3 `pnpm test` (full suite, pre-push parity) passes — server 660 passed / 1 skipped, Hermes 31 OK; no existing `memory.context` assertion regressed.
- [x] 3.4 `openspec validate snippet-context-session-summaries --strict` passes.
