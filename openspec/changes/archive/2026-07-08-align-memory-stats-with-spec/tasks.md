## 1. Repository counts

- [ ] 1.1 Ensure `db/repositories` can produce: memory counts grouped by scope (`memoriesByScope`), total project count, total token count. Reuse existing methods where present (`memory-repository.countByProject`); add small `count()` methods to the projects and tokens repositories if missing. No SQL outside `db/`.

## 2. Handler + output schema

- [ ] 2.1 Extend `handleStats` (`apps/server/src/mcp/sessions-tools.ts`) to also return `memoriesByScope`, `totalProjects`, `totalTokens` (keep `scope`, `memoriesByStatus`, `memoriesByType`, `sessionsByStatus`).
- [ ] 2.2 Widen `statsOutput` to match: add `memoriesByScope: z.record(z.string(), z.number())`, `totalProjects: z.number()`, `totalTokens: z.number()`.

## 3. Spec + tests

- [ ] 3.1 The spec delta (this change) finalizes the field list and value types; verify `openspec validate` passes.
- [ ] 3.2 Extend `mcp-integration.test.ts` to assert `memory.stats` returns the full field set with correct types (the SDK validates structuredContent against the widened `statsOutput`).

## 4. Verify

- [ ] 4.1 `pnpm run typecheck`, `pnpm run lint`, full `pnpm vitest run` (server) pass.
