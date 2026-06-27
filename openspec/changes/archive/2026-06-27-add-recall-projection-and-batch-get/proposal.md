# Improve recall payloads: search projection, scoped batch get, and one Unicode-aware FTS builder

## Why

The agent's recall path has three rough edges that hurt either context economy or recall correctness. (1) `memory.search` returns the FULL `content` of every row and `limit` goes up to 200 (`apps/server/src/mcp/memory-tools.ts:64-86`, `handleSearch` maps `content: m.content` for every row at `:606`), so a broad triage scan with `limit: 200` dumps 200 full bodies into the context window — the agent cannot scan cheaply then drill in. (2) `memory.context` surfaces ids with a 350-char snippet (`CONTEXT_SNIPPET_CHARS`, `memory-tools.ts:700`, applied at `:751`) and the protocol tells the agent to "drill in with memory.get", but `memory.get` takes a single `id` (`memoryGetSchema`, `:88`) — pulling N full bodies is N round-trips. (3) The save-time candidate detector's FTS builder `escapeFts` (`apps/server/src/services/save-time-candidates.ts:134-146`) splits on `/[^a-z0-9]+/` (ASCII-only) and returns `''` for any CJK/accented content, so the caller skips the FTS branch entirely (`:82`); meanwhile the interactive-search builder `sanitizeFtsQuery` (`apps/server/src/services/hybrid-search.ts:122-134`) is Unicode-aware (`/[\p{L}\p{N}]/u`). Save-time conflict detection therefore silently degrades to vector-only for the entire non-ASCII corpus the compiled-in `gte-multilingual-base` embedder is chosen to serve — a recall-correctness bug, not a nicety. This change tackles all three while keeping every existing default response shape unchanged.

## What Changes

- `memory.search` gains two OPTIONAL projection params: `snippet?: number` (truncate each row's `content` to N chars using the existing snippet helper, same as `memory.context`) and `fields?: string[]` (select a subset of the row fields to return). When neither is supplied, the response is byte-for-byte the current full-content shape — **no breaking change** to default callers.
- `memory.get` is extended to accept `ids?: string[]` ALONGSIDE the existing `id?: string` (back-compat: single-`id` callers are unchanged; exactly one of `id`/`ids` must be supplied). The batch form returns an ordered array of the per-id `memory.get` payloads for the ids that resolve in-scope, and a list of the ids that did not resolve. It is scope-enforced via a new SCOPED service method `MemoryService.getMany(ids, scope)` that wraps the existing scope-naive `unsafeGetByIds` and drops out-of-scope rows; cross-scope ids return as not-found and never leak content. **No new MCP tool** is added (extending the existing tool avoids plugin-manifest churn across all four clients).
- The two FTS5 `MATCH`-expression builders are unified onto ONE Unicode-aware builder (the `sanitizeFtsQuery` lexical strategy), parameterized by an optional term cap so the save-time path keeps its 16-term ceiling. `escapeFts` is removed; the save-time detector calls the unified builder. This restores save-time FTS candidate detection for non-ASCII content — a recall-correctness fix. **BREAKING (internal)**: the save-time `MATCH` expression for non-ASCII content changes from `''` (skip) to a real OR-of-phrases, so non-ASCII saves can now surface `source: 'fts'` candidates they previously could not.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `mcp-api`: `memory.search` gains optional `snippet`/`fields` projection; `memory.get` accepts a scope-enforced `ids[]` batch form.
- `memory`: save-time candidate detection uses the unified Unicode-aware FTS builder so non-ASCII content participates in the lexical pass; a scoped batch retrieve is added.

## Impact

- `apps/server/src/mcp/memory-tools.ts` — `memorySearchSchema` (add `snippet`, `fields`), `memoryGetSchema` (add `ids`), `memorySearchOutput`/`memoryGetOutput` (projection + batch shapes), `handleSearch` (apply projection), `handleGet` (branch single vs batch, authz per row).
- `apps/server/src/services/memory.ts` — add SCOPED `getMany(ids, scope)` wrapping `unsafeGetByIds` + `memoryMatchesScope`; keep `unsafeGetByIds` `@internal`.
- `apps/server/src/services/save-time-candidates.ts` — delete `escapeFts`; call the unified builder with the 16-term cap.
- `apps/server/src/services/hybrid-search.ts` — generalize `sanitizeFtsQuery` to accept an optional `{ maxTerms }` (or export the shared builder it delegates to).
- `apps/server/src/mcp/_shared.ts` — `snippet` helper reused for the search projection (no change to the helper itself).
- `apps/server/src/services/hybrid-search.test.ts`, `apps/server/src/services/save-time-candidates*.test.ts`, `apps/server/src/db/repositories/memory-repository.test.ts` — extend/add coverage for the unified builder and `getMany` scope isolation.
- `openspec/specs/mcp-api/spec.md`, `openspec/specs/memory/spec.md` — updated requirement blocks (this proposal's spec deltas).
