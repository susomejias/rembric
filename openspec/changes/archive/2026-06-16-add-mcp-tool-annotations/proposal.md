## Why

Rembric registers ~25 MCP tools with `description` + `inputSchema` only — no `annotations`. Annotation-aware clients (ChatGPT's connector UI, and any client honoring the 2025-06-18 hint vocabulary) therefore fall back to the most cautious defaults and render **every** tool as destructive / public-write / open-world. That is factually wrong: read tools (`memory.search`, `get`, `context`, `session_get`, `timeline`, `search_prompts`, `doctor`, `about`, `stats`, `suggest_topic_key`, `project.list`, `project.current`) never mutate, and per Rembric's append-only invariant **no** tool is destructive — even a supersede is a reversible, journaled `status` flip. Mislabeling reads as destructive pushes clients to gate them behind confirmations or avoid them, degrading the experience for no reason.

## What Changes

- Add a `ToolAnnotations` object to every `server.registerTool(...)` call in `apps/server/src/mcp/server.ts` (and the `memory.about` registration), carrying `title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`.
- Read-only tools get `readOnlyHint: true`; **all** tools get `destructiveHint: false` (append-only invariant) and `openWorldHint: false` (closed local store). Idempotent tools (`memory.compare`, `memory.session_end`, `suggest_topic_key`, reads) get `idempotentHint: true`.
- Add an invariant-style test asserting the annotation contract holds for the full tool set (read tools `readOnlyHint:true`; every tool `destructiveHint:false` + `openWorldHint:false`).
- **Explicitly out of scope**: `outputSchema` / `structuredContent`. Deferred with a documented tradeoff (see `design.md`) — it is a hard, fragile contract change across four clients, not additive metadata. This change is metadata-only and non-breaking.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `mcp-api`: add a requirement that every registered MCP tool advertises behavioral annotations consistent with the append-only / closed-store invariants.

## Impact

- Code: `apps/server/src/mcp/server.ts` (tool registrations), one new/extended test under `apps/server/src/mcp/` or `apps/server/src/test/`.
- Spec: `openspec/specs/mcp-api/spec.md` (new requirement + scenarios).
- Clients: purely additive — no change to tool inputs, outputs, or descriptions; existing four clients (Claude Code, Codex, Hermes, opencode) and tests are unaffected. Annotation-aware UIs (ChatGPT connector) immediately render correct read/destructive/world hints.
- No DB migration, no dependency change.
