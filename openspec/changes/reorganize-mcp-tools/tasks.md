## 1. Extract shared helpers

- [x] 1.1 Move `errToMcp` into `apps/server/src/mcp/errors.ts` (next to `mcpError`); delete the copies and import from `errors.ts`.
- [x] 1.2 Create `apps/server/src/mcp/_shared.ts` with `scopeFromContext`, `routerKey`, `clamp`, `snippet`, `serializeMemory` (plus the shared `resolveSessionId`); import it from the handler modules. Removed the duplicate `routerKey` from `project-tools.ts`. `_shared.ts` imports only types + `result.ts` (no cycle).

## 2. Rename the core memory module

- [x] 2.1 Renamed `tools.ts` → `memory-tools.ts`; `buildHandlers` → `buildMemoryHandlers`; `ToolDeps` → `MemoryToolDeps`. Updated `server.ts` and `mcp/index.ts`.
- [x] 2.2 Renamed `tools.test.ts` → `memory-tools.test.ts`.

## 3. Split `sessions-tools.ts` by domain

- [x] 3.1 `session-tools.ts` — `session_start`/`end`/`summary`/`get` + `buildSessionHandlers` + `SessionToolDeps`.
- [x] 3.2 `prompt-tools.ts` — `save_prompt`/`search_prompts` + `buildPromptHandlers` + `PromptToolDeps`.
- [x] 3.3 `observability-tools.ts` — `doctor`/`stats`/`capture_passive` + `parseKeyLearnings` + `DoctorReport` + `buildObservabilityHandlers`. (Per the bucketing decision, `context`/`timeline` went to `memory-tools.ts`, not here.)
- [x] 3.4 Deleted `sessions-tools.ts`. Updated `server.ts` (three new factories, same `registerTool` calls/schemas/annotations) and `mcp/index.ts`. Repointed `bootstrap.ts`'s `DoctorReport` import to `observability-tools.ts`.
- [x] 3.5 Split the tests: `tools.test.ts`→`memory-tools.test.ts`; `sessions-tools.test.ts` (parseKeyLearnings)→`observability-tools.test.ts`; `session-deleted.test.ts`→`buildSessionHandlers`; `project-suggestion-pending.test.ts`→memory+session builders; `session-scope-resolution.test.ts`→merged memory+prompt+observability handlers.

## 4. Enforce the convention

- [x] 4.1 Added the grep invariant to `invariants.test.ts`: no `mcp/tools.ts`; every `mcp/*-tools.ts` exports exactly one `build*Handlers`; `errToMcp`/`routerKey` each defined once. (It caught a real leftover `routerKey` duplicate in `project-tools.ts`, now removed.)

## 5. Verify

- [x] 5.1 `openspec validate reorganize-mcp-tools --strict` passes.
- [x] 5.2 `tsc --noEmit` and `eslint` pass (no import cycles).
- [x] 5.3 Full server suite passes: 833 passed, 1 pre-existing skip, including the new layout invariant.
- [ ] 5.4 Dev-stack boot smoke (`pnpm run dev:docker:up`) — confirm the MCP server registers the same tool surface end-to-end. _(Pending the joint dev-env check.)_
