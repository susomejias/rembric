## Why

Rembric's MCP tools declare `inputSchema` but no `outputSchema`. Per the MCP spec (2025-06-18) and ChatGPT's connector UI recommendation, advertising an `outputSchema` lets annotation-aware clients validate and structurally render tool results instead of re-parsing an opaque JSON text blob. This is the follow-up the operator green-lit after `add-mcp-tool-annotations`: add `outputSchema` to **all** ~24 tools.

## What Changes

- Introduce a single shared `ok(payload)` result builder (replacing the four duplicate per-file copies) that returns BOTH the existing `text` content block AND a `structuredContent` object. `structuredContent` is `JSON.parse(JSON.stringify(payload))` so it is exactly the wire JSON (Dates → ISO strings) the schema validates against.
- Add a per-tool zod `outputSchema` (success shape only) to every `server.registerTool(...)` call. Error/`not_found`/`scope_locked` results are unaffected — the SDK skips output validation for `isError:true` results (`mcp.js:166`), and all Rembric errors flow through `mcpError()`.
- Add tests asserting each tool returns a `structuredContent` that conforms (the SDK throws `Output validation error` on mismatch, so calling every tool through the in-memory client is itself the validation).
- **Not breaking**: the `text` content block is unchanged, so the four existing clients keep working byte-for-byte; `structuredContent` is purely additive.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `mcp-api`: add a requirement that every registered MCP tool advertises an `outputSchema` and returns conforming `structuredContent` on success, without altering the `text` result or error contract.

## Impact

- Code: new `apps/server/src/mcp/result.ts` (shared `ok`) + `apps/server/src/mcp/output-schemas.ts` (zod success schemas); `server.ts` registrations gain `outputSchema`; the four handler files (`tools.ts`, `sessions-tools.ts`, `project-tools.ts`, `relations-tools.ts`) drop their local `ok()` and import the shared one; `about-tool.ts` returns `structuredContent`.
- Tests: extend `apps/server/src/test/mcp-integration.test.ts`.
- Clients: additive; no input/description/error change. No DB migration, no dependency change.
