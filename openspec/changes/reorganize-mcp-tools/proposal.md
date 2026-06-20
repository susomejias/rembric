## Why

The MCP handler layer is asymmetric. Every domain has a `<domain>-tools.ts` module exposing a `build<Domain>Handlers` factory and a `<Domain>ToolDeps` interface — except the core memory tools, which live in a generically-named `tools.ts` (`buildHandlers` / `ToolDeps`), and `sessions-tools.ts`, which has grown to 912 lines holding three unrelated domains (session lifecycle, observability/read-back, and prompts) plus shared helpers. Helpers are duplicated across files (`errToMcp` in both `tools.ts` and `sessions-tools.ts`; `routerKey` in both `sessions-tools.ts` and `project-tools.ts`). The result is hard to navigate and the asymmetry will keep drifting. This change makes the layer uniform and codifies the convention as a grep-enforced invariant so it stays uniform — mirroring how `data-access` enforces "one repository per aggregate."

## What Changes

- **Rename the core memory module to the convention.** `tools.ts` → `memory-tools.ts`, `buildHandlers` → `buildMemoryHandlers`, `ToolDeps` → `MemoryToolDeps`. Update `server.ts` and `mcp/index.ts` imports.
- **Split `sessions-tools.ts` (912 lines) by domain:**
  - `session-tools.ts` — session lifecycle (`memory.session_start` / `session_end` / `session_summary` / `session_get`), `buildSessionHandlers`.
  - `prompt-tools.ts` — `memory.save_prompt` / `memory.search_prompts`, `buildPromptHandlers`.
  - `observability-tools.ts` — `memory.context` / `memory.timeline` / `memory.stats` / `memory.doctor` / `memory.capture_passive`, `buildObservabilityHandlers`.
- **Centralize shared helpers.** Move `errToMcp` into `mcp/errors.ts` (next to `mcpError`) and dedupe both copies. Move `scopeFromContext`, `routerKey`, `clamp`, `snippet`, and `serializeMemory` into a single `mcp/_shared.ts` consumed by every handler module; remove the duplicate `routerKey`.
- **Codify the convention as an enforced invariant.** Add a grep invariant (in `apps/server/src/test/invariants.test.ts`) asserting: no generic `tools.ts` handler module exists; every `mcp/*-tools.ts` exports exactly one `build*Handlers` factory; `errToMcp`/`routerKey` are defined once.

No tool is added, removed, renamed, or has its input/output contract changed. `server.ts` registers the exact same set of tools with the same schemas and annotations; this is a file-layout and helper-dedup refactor only.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `mcp-api`: add one structural requirement — "MCP tool handlers MUST be organized one domain per module" — with a grep-enforced scenario. This is additive (a new invariant over the existing layer); no existing tool-contract requirement changes.

## Impact

- **Code:** `apps/server/src/mcp/` — rename `tools.ts`→`memory-tools.ts`; new `session-tools.ts`, `prompt-tools.ts`, `observability-tools.ts` (carved out of `sessions-tools.ts`, which is deleted); new `_shared.ts`; `errToMcp` into `errors.ts`; `server.ts` + `index.ts` import/wiring updates; remove the duplicate `routerKey` from `project-tools.ts`.
- **Tests:** rename/split the co-located test files to match (`tools.test.ts`→`memory-tools.test.ts`; split `sessions-tools.test.ts` and the session-scope/observability tests to their new homes); add the layout invariant to `invariants.test.ts`.
- **Spec:** `openspec/specs/mcp-api/spec.md` — one ADDED structural requirement (delta in this change).
- **Compatibility:** zero runtime/behavior change — same tools, same schemas, same wiring. Server-only; no plugin/client/DB change; no migration.
