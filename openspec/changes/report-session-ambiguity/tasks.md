## 1. Contract

- [x] 1.1 Reproduce #548 at the MCP handler with a control (one active session versus two)
- [x] 1.2 Write the `mcp-api` MODIFIED and `sessions` ADDED deltas

## 2. Tests first

- [x] 2.1 `session-tools.test.ts`: two fresh rows and two idle rows refuse as `session_ambiguous` with the exact message and no row change, for both tools; one fresh plus one idle row resolves to the fresh one; no row and one idle row keep `session_not_found`; an explicit `sessionId` still writes. Observed RED on the four ambiguity cases.
- [x] 2.2 The pinned resume test now expects `session_ambiguous` for an unnamed write beside a second active session
- [x] 2.3 `mcp-tool-surface.test.ts`: the `memory.session_end` description names `session_ambiguous`. Observed RED.

## 3. Implementation

- [x] 3.1 `findActiveCandidates` in the repository; both lookups delegate to it
- [x] 3.2 `resolveForTransport` in the service
- [x] 3.3 `resolveLifecycleTarget` in `session-tools.ts`
- [x] 3.4 `memory.session_end` description

## 4. Verification

- [x] 4.1 Mutation checks with `scripts/mutate.mjs`: the window-free ambiguity branch (forced off, forced on), the sole branch and the explicit-id branch are each caught. A separate fresh-rows ambiguity branch survived as redundant and was removed.
- [ ] 4.2 `pnpm run lint`, `pnpm run typecheck`, `pnpm test`
- [ ] 4.3 JSON-RPC probe against a local dev server: control and treatment
