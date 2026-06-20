## Context

`apps/server/src/mcp/` follows a clear convention almost everywhere: `relations-tools.ts`/`buildRelationsHandlers`, `project-tools.ts`/`buildProjectHandlers`, `about-tool.ts`. Two modules break it. `tools.ts` (596 lines) holds the four core memory tools (`memory.save`/`search`/`get`/`confirm`) under the generic `buildHandlers`/`ToolDeps`. `sessions-tools.ts` (912 lines) holds three unrelated domains — session lifecycle, observability/read-back (`context`/`timeline`/`stats`/`doctor`/`capture_passive`), and prompts (`save_prompt`/`search_prompts`) — under one `buildSessionsHandlers`. Helpers are duplicated: `errToMcp` is defined in both `tools.ts:590` and `sessions-tools.ts`; `routerKey` in both `sessions-tools.ts:293` and `project-tools.ts`. `server.ts` already wires each factory separately, so the split is a clean carve with no wiring redesign.

## Goals / Non-Goals

**Goals:** uniform `<domain>-tools.ts` / `build<Domain>Handlers` / `<Domain>ToolDeps` layout; one home for each shared helper; `server.ts` stays a thin registration manifest; a grep invariant that keeps it uniform.

**Non-Goals:** changing any tool's name, input/output schema, annotations, or behavior; touching the session-lifecycle HTTP protocol; reorganizing non-MCP layers (dashboard/db symmetry are separate candidate changes).

## Decisions

### Decision 1 — Module boundaries

| New module                         | Tools                                                                                          | Factory                      |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------- |
| `memory-tools.ts` (was `tools.ts`) | `memory.save`, `memory.search`, `memory.get`, `memory.confirm`                                 | `buildMemoryHandlers`        |
| `session-tools.ts`                 | `memory.session_start`, `session_end`, `session_summary`, `session_get`                        | `buildSessionHandlers`       |
| `prompt-tools.ts`                  | `memory.save_prompt`, `memory.search_prompts`                                                  | `buildPromptHandlers`        |
| `observability-tools.ts`           | `memory.context`, `memory.timeline`, `memory.stats`, `memory.doctor`, `memory.capture_passive` | `buildObservabilityHandlers` |

`relations-tools.ts`, `project-tools.ts`, `about-tool.ts` already conform and are untouched.

The judgment call is `context`/`timeline`/`capture_passive`: they read memory but are operationally "what's going on / read-back" tools, so they group with `stats`/`doctor` under observability rather than re-entering the memory CRUD module. This keeps `memory-tools.ts` to the four write/read CRUD verbs and avoids a second 900-line file. Boundary is refinable during apply if a tool clearly wants a different home, as long as the one-domain-per-module invariant holds.

### Decision 2 — Shared helpers in one place

- `errToMcp` → `mcp/errors.ts`, alongside the existing `mcpError`. Both current copies import it. This also lets `relations-tools.ts`/`project-tools.ts` (which currently `throw` non-`DomainError`s) adopt the same structured mapping if desired — but that behavior tweak is out of scope here; this change only relocates the existing helper.
- `scopeFromContext`, `routerKey`, `clamp`, `snippet`, `serializeMemory` → `mcp/_shared.ts`. Remove the duplicate `routerKey` from `project-tools.ts`. `_shared.ts` depends only on types + `result.ts`, so no import cycle with the handler modules.

### Decision 3 — Codify the convention (grep invariant)

Mirror `data-access`'s "Repositories per aggregate" guard. Add to `invariants.test.ts` a scan of `mcp/` that asserts: (a) no `tools.ts` exists; (b) each `*-tools.ts` exports exactly one `build*Handlers`; (c) `errToMcp` and `routerKey` each appear as a definition in exactly one module. This is the durable payoff — it's what keeps "symmetric" symmetric.

### Decision 4 — Move tests with their code

Co-located tests follow their handlers: `tools.test.ts`→`memory-tools.test.ts`; `sessions-tools.test.ts`, `session-scope-resolution.test.ts`, `session-deleted.test.ts` split across `session-tools.test.ts`/`observability-tools.test.ts`/`prompt-tools.test.ts` by which tool they exercise. No assertion changes — same behavior, new file homes.

## Risks / Trade-offs

- **Large mechanical diff (file moves + import churn)** → mitigated by zero behavior change: typecheck, lint, and the full unchanged test suite are the safety net; the new layout invariant proves the structure.
- **Import cycles when extracting `_shared.ts`** → avoided by keeping `_shared.ts` dependency-free except types/`result.ts`; verified by typecheck.
- **Bucket boundary for `context`/`timeline`/`capture_passive` is a judgment call** → the invariant enforces one-domain-per-module, not a specific bucketing, so a later move is cheap and guard-safe.
- **Grep invariant brittleness** → keep the assertions structural (file existence, single factory export, single helper definition) rather than parsing tool sets, so ordinary edits don't trip it.

## Migration Plan

Pure refactor, no DB/runtime migration. Land in one change: extract `_shared.ts` + move `errToMcp` first (so both old files compile against the shared copy), then rename `tools.ts` and split `sessions-tools.ts`, then update `server.ts`/`index.ts` wiring, then move tests, then add the invariant. Rollback = revert the commit.

## Open Questions

- Final home for `capture_passive` (observability vs a dedicated tool module) — decide during apply; invariant is agnostic.
