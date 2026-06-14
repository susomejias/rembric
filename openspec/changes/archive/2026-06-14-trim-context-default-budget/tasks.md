## 1. Code

- [x] 1.1 In `apps/server/src/mcp/sessions-tools.ts` `handleContext`, change the three default literals: `sessionsLimit = clamp(args.sessions ?? 3, 0, 25)`, `memoriesLimit = clamp(args.memories ?? 10, 0, 100)`, `promptsLimit = clamp(args.prompts ?? 5, 0, 50)`. Leave the maxima and the `clamped` computation untouched.

## 2. Spec

- [x] 2.1 Update the `mcp-api` "three research tools" requirement: the bootstrap-snapshot scenario states the new defaults (sessions=3, memories=10, prompts=5); the `recentSessions` truncation reference changes from `sessions ?? 5` to `sessions ?? 3`. The clamp-maxima scenario (`> 25 / > 50 / > 100`) is unchanged.

## 3. Tests

- [x] 3.1 Grep tests for reliance on the old implicit sizes (`apps/server/src/test/mcp-integration.test.ts`, `apps/server/src/mcp/*.test.ts`). Any assertion that depended on a default of 20 memories / 10 prompts / 5 sessions is updated to the new default or pinned with an explicit arg.
- [x] 3.2 Add/adjust a test asserting the new defaults: a `memory.context` call with no size args returns at most 3 sessions, 10 memories, 5 prompts.

## 4. Validation

- [x] 4.1 `openspec validate trim-context-default-budget --strict` passes.
- [x] 4.2 `pnpm run typecheck`, `pnpm run lint`, `pnpm test` pass.
