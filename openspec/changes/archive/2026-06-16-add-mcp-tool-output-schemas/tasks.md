## 1. Shared result builder

- [x] 1.1 Create `apps/server/src/mcp/result.ts` exporting `ok(payload)` that returns `{ content: [{type:'text', text: JSON.stringify(payload,null,2)}], structuredContent: JSON.parse(JSON.stringify(payload)) }`, typed against the SDK `CallToolResult`.
- [x] 1.2 Delete the local `ok()` in `tools.ts`, `sessions-tools.ts`, `project-tools.ts`, `relations-tools.ts` and import the shared one. Update `about-tool.ts` to use it.

## 2. Output schemas

- [x] 2.1 Create `apps/server/src/mcp/output-schemas.ts` with one raw-shape zod `outputSchema` per tool (success shape only), plus reused sub-objects (`relationView`, `searchRow`, `candidate`, `promptRow`, `sessionRow`, `memoryNeighbor`). Timestamps `z.string()`; nullable columns `.nullable()`; conditional fields `.optional()`.
- [x] 2.2 Cover all ~24 tools: save, search, get, confirm, session_start, session_end, session_summary, context, session_get, timeline, capture_passive, save_prompt, search_prompts, doctor, about, stats, project.use, project.list, project.current, suggest_topic_key, judge, compare.

## 3. Wire registrations

- [x] 3.1 Add `outputSchema: <tool>Output` to every `server.registerTool(...)` config in `apps/server/src/mcp/server.ts`.

## 4. Tests

- [x] 4.1 In `apps/server/src/test/mcp-integration.test.ts`, add a test that asserts every tool from `listTools()` has an `outputSchema`.
- [x] 4.2 Add/extend tests so every tool is invoked once and its result `structuredContent` is asserted present (the SDK validates conformance on each call). Cover read tools, write tools, and the project/relations tools.

## 5. Verify

- [x] 5.1 `pnpm run typecheck` passes.
- [x] 5.2 `pnpm run lint` passes.
- [x] 5.3 Full `pnpm vitest run` (server) passes — any output-schema mismatch surfaces as `Output validation error` on the offending tool call.
