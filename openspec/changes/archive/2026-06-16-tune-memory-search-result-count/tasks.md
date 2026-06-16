## 1. Implementation

- [x] 1.1 In `apps/server/src/services/memory.ts`, add a `DEFAULT_SEARCH_LIMIT = 8` constant and use it in `clampLimit` in place of the literal `20`.

## 2. Tests

- [x] 2.1 Audit `apps/server/src/services/memory.test.ts` (and any other in-repo `memory.search` caller) for an assertion that implicitly relies on the old 20-row default; update to the new default. (No caller relied on the 20 default — `tools.test.ts`/`invariants.test.ts` use `toBeGreaterThan(0)` and scope checks, not exact counts.)
- [x] 2.2 Add/adjust a test asserting that an omitted `limit` yields at most `DEFAULT_SEARCH_LIMIT` (8) results on BOTH the hybrid text-query branch and the no-query listing branch, and that an explicit `limit` still overrides it.

## 3. Validation

- [x] 3.1 `pnpm run typecheck` and `pnpm run lint` clean.
- [x] 3.2 `pnpm vitest run apps/server/src/services/memory.test.ts apps/server/src/services/hybrid-search.test.ts` green.
- [x] 3.3 `openspec validate tune-memory-search-result-count` passes.
