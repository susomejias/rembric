## Context

`add-mcp-tool-annotations` (archived 2026-06-16) deferred `outputSchema` with a tradeoff analysis. Re-examining the SDK (`@modelcontextprotocol/sdk@1.29.0`, `dist/cjs/server/mcp.js`) lowered the risk materially:

- `validateToolOutput` (line ~186): if `tool.outputSchema` is set and a **success** result lacks `structuredContent` → throws; if `structuredContent` is present it is parsed against the schema, throwing on mismatch.
- **Line ~166: `if (result.isError) return;`** — output validation is SKIPPED for error results. Every Rembric error goes through `mcpError()` (`errors.ts`, sets `isError:true`), so error/`not_found`/`scope_locked`/`forbidden` shapes never need to appear in any output schema.
- zod object parsing **strips** unknown keys (does not reject), so over-returning a field never fails validation. The only failure modes are a declared-required field being absent or a present field having the wrong type.

These three facts collapse the "fragile across branches" concern: schemas model only the success shape, only required-when-always-present fields are required, and everything conditional is `.optional()`.

## Goals / Non-Goals

**Goals:**

- Every tool advertises an accurate `outputSchema`; success calls return conforming `structuredContent`.
- The `text` content block and all error results are byte-for-byte unchanged (four clients unaffected).
- Eliminate the four duplicate `ok()` helpers in favor of one.

**Non-Goals:**

- Modeling error payloads (skipped by the SDK).
- Changing any handler's business logic, scope resolution, or input contract.
- Strict/exhaustive nested modeling where a field is genuinely dynamic (`doctor` health dump) — a faithful-but-tolerant schema is acceptable there.

## Decisions

### Decision 1 — `structuredContent = JSON.parse(JSON.stringify(payload))`

Handlers build payloads containing `Date` objects (`createdAt: m.createdAt`) and conditionally-spread fields. The current `ok()` serializes via `JSON.stringify` (Dates → ISO strings) only into the `text` block. If `structuredContent` carried the raw payload, a `Date` object would fail a `z.string()` timestamp field, and validation runs **before** transport serialization (so the Date is still a Date at validation time). Round-tripping through `JSON.parse(JSON.stringify(payload))` makes `structuredContent` identical to the wire JSON: Dates become ISO strings uniformly, `undefined` is dropped, and every timestamp field is modeled as `z.string()`. Rejected alternative: `z.date()` per timestamp — brittle (some handlers already pre-call `.toISOString()`, others pass raw Dates) and the advertised JSON Schema would still be a string. The round-trip normalizes both producers into one rule.

### Decision 2 — One shared `ok()` in `result.ts`

The four identical `ok()` copies (`tools.ts`, `sessions-tools.ts`, `project-tools.ts`, `relations-tools.ts`) are replaced by a single `apps/server/src/mcp/result.ts` export. Centralizing is the only way to attach `structuredContent` once rather than in four places, and it removes duplication the repo already dislikes. `about-tool.ts` (which hand-builds its result) is updated to use it too.

### Decision 3 — Output schemas as raw zod shapes, co-located per handler file

Mirror the `inputSchema` convention exactly: each output schema is a `ZodRawShape` literal (`{ field: z.… }`), which `registerTool` accepts and `normalizeObjectSchema` wraps, and it lives in the SAME handler file as its `inputSchema` (`memory*Output` in `tools.ts`, session/context/doctor/stats outputs in `sessions-tools.ts`, `project*Output` in `project-tools.ts`, judge/compare/suggest in `relations-tools.ts`, `aboutOutput` in `about-tool.ts`). File-local sub-objects (`relationView`, `candidate`, `memoryRow` in `tools.ts`; `promptRow`, `memoryNeighbor`, `counts` in `sessions-tools.ts`) are `z.object(...)` — none is shared across files, so no central module is needed. Timestamps → `z.string()`; nullable DB columns → `.nullable()`; conditionally-spread fields (`reviewState`, `previousSlug`, `replaces`, `fallback`) → `.optional()`/`.nullable()`. (An earlier draft put all schemas in a single `output-schemas.ts`; dropped in review for breaking the established co-location convention — the `outputSchema` belongs next to the `inputSchema` it complements.)

### Decision 4 — Tests are end-to-end calls

The in-memory `Client` already exercises most tools in `mcp-integration.test.ts`. Because the SDK validates `structuredContent` against the schema on every call, **calling a tool is the schema test** — a wrong schema throws `Output validation error` and fails the test. Extend the suite so every one of the ~24 tools is invoked at least once and its `structuredContent` is asserted present. This catches the only real failure mode (required field absent / wrong type) for each tool's happy path.

## Risks / Trade-offs

- [A conditional success branch not hit by tests has a wrong required field] → Mitigation: model conditionally-present fields as `.optional()` by default; only mark a field required when the code path unconditionally sets it. The round-trip + unknown-key-stripping means over-modeling is safe; under-optionalizing is the only risk, handled by conservative optionality.
- [`doctor` health dump drifts from its schema] → model its known top-level keys (`db`, `embeddings`, `consolidation`, `sessions`, `warnings`) per `DoctorReport`; these are stable typed fields, low drift risk.
- [`JSON.parse(JSON.stringify())` double-encode cost] → negligible for these small payloads; bounded by existing response sizes.
- [Future tool registered without `outputSchema`] → the integration test enumerates tools and asserts each returns `structuredContent`, catching an un-schemaed new tool.

## Migration Plan

Additive. Revert = drop `outputSchema` fields + restore per-file `ok()`. No migration, no client change, no data change.

## Open Questions

- None blocking. If a specific client mis-handles `structuredContent`, the `text` block remains the fallback every client already reads.
