## 1. Implementation

- [x] 1.1 In `apps/server/src/mcp/server.ts`, update `SEARCH_DESCRIPTION`: keep the recall trigger; replace the stale "FTS5 keyword search" with hybrid semantic + keyword ranking wording; add the small-default-page (8) / widen-via-`limit`-(up to 200)-or-`offset` affordance.
- [x] 1.2 In `apps/server/src/mcp/tools.ts`, add `.describe()` to the `limit` and `offset` fields of `memorySearchSchema`.

## 2. Tests

- [x] 2.1 Locate the test asserting the `memory.search` description trigger (search `apps/server/src/mcp/*.test.ts` for the recall-trigger / "Call this" assertion). (None existed; the right home is `apps/server/src/test/mcp-integration.test.ts`, which lists tools via a real MCP client.)
- [x] 2.2 Add assertions that the `memory.search` description conveys hybrid semantic+keyword ranking AND the widen-via-`limit`/`offset` affordance, while the recall trigger assertion still passes.

## 3. Validation

- [x] 3.1 `pnpm run typecheck` and `pnpm run lint` clean.
- [x] 3.2 `pnpm vitest run` for the affected mcp test file(s) green.
- [x] 3.3 `openspec validate clarify-memory-search-tool-description` passes.
