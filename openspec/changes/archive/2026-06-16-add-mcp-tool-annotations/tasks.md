## 1. Annotate tool registrations

- [x] 1.1 In `apps/server/src/mcp/server.ts`, add an `annotations` object to the `registerTool` config of each read-only tool (`memory.search`, `memory.get`, `memory.context`, `memory.session_get`, `memory.timeline`, `memory.search_prompts`, `memory.doctor`, `memory.about`, `memory.stats`, `memory.suggest_topic_key`, `project.list`, `project.current`) with `readOnlyHint:true`, `destructiveHint:false`, `idempotentHint:true`, `openWorldHint:false`, and a terse `title`.
- [x] 1.2 Add `annotations` to each mutating tool (`memory.save`, `memory.confirm`, `memory.capture_passive`, `memory.save_prompt`, `memory.session_start`, `memory.judge`, `project.use`) with `readOnlyHint:false`, `destructiveHint:false`, `idempotentHint:false`, `openWorldHint:false`, and a `title`.
- [x] 1.3 Add `annotations` to the idempotent-mutating tools (`memory.session_summary`, `memory.session_end`, `memory.compare`) with `readOnlyHint:false`, `destructiveHint:false`, `idempotentHint:true`, `openWorldHint:false`, and a `title`.

## 2. Pin the contract with a test

- [x] 2.1 Add a test (in `apps/server/src/test/mcp-integration.test.ts`, alongside the existing `listTools` test) that builds the MCP server, lists registered tools, and asserts: every tool has `annotations.destructiveHint===false` and `annotations.openWorldHint===false`; the 12 read tools have `readOnlyHint===true`; the 10 mutating tools have `readOnlyHint===false`.
- [x] 2.2 Assert the read/mutating tool name sets in the test are exhaustive against the registered tool list (a newly-registered tool with no annotation entry fails the test).

## 3. Verify

- [x] 3.1 `pnpm run typecheck` passes.
- [x] 3.2 `pnpm run lint` passes.
- [x] 3.3 `pnpm vitest run` for the affected mcp test files passes (new test + existing `server`/`tools`/`sessions-tools` tests green). Verified: `mcp-integration` 28/28 (incl. new annotations test) + `src/mcp/` suite & `invariants` 147/147.
