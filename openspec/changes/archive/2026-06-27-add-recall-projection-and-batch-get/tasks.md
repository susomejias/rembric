## 1. Unify the FTS5 MATCH-expression builder

- [x] 1.1 In `apps/server/src/services/hybrid-search.ts`, generalize the lexical builder so the OR-of-quoted-phrases Unicode-aware logic accepts an optional term cap (e.g. `sanitizeFtsQuery(query, { maxTerms }?)` or an exported shared helper it delegates to). The no-cap call MUST be byte-for-byte unchanged.
- [x] 1.2 Verify the existing interactive-search expectations are untouched so that `pnpm vitest run apps/server/src/services/hybrid-search.test.ts` still passes verbatim (the `¿cómo toma el café?`, `coffee OR tea`, `C++`, stray-quote, and pure-punctuation cases).
- [x] 1.3 Add a unit test asserting the cap: a query with >maxTerms usable tokens yields exactly `maxTerms` OR-phrases, so that `pnpm vitest run apps/server/src/services/hybrid-search.test.ts` passes.
- [x] 1.4 In `apps/server/src/services/save-time-candidates.ts`, delete `escapeFts` and call the unified builder with `maxTerms: 16` for `saved.content`. Keep the `if (matchExpr.length > 0)` skip-on-empty guard.
- [x] 1.5 Add/extend a test proving non-ASCII save content now yields a non-empty `MATCH` expression and can surface `source: 'fts'` candidates, so that `pnpm vitest run apps/server/src/services/save-time-candidates.test.ts` passes.

## 2. Scoped batch retrieve at the service layer

- [x] 2.1 In `apps/server/src/services/memory.ts`, add a SCOPED `getMany(ids, scope): MemoryWithHistory[]` (or the agreed per-id payload shape) that calls `this.unsafeGetByIds(ids)` then keeps only rows where `memoryMatchesScope(row, scope)` is true, preserving input id order; out-of-scope and missing ids are simply absent. Keep `unsafeGetByIds` `@internal`.
- [x] 2.2 Add a repository/service test asserting `getMany` returns in-scope rows in request order and OMITS cross-scope ids (no content, no error per id), so that `pnpm vitest run apps/server/src/db/repositories/memory-repository.test.ts` (and/or the service test) passes.

## 3. memory.search projection (mcp-api)

- [x] 3.1 In `apps/server/src/mcp/memory-tools.ts`, add optional `snippet?: number` and `fields?: string[]` to `memorySearchSchema` with `.describe(...)` text, and widen `memorySearchOutput` so `content` MAY be truncated and rows MAY omit non-identity fields.
- [x] 3.2 In `handleSearch`, AFTER selection, apply the projection: truncate `content` via the shared `snippet()` helper (`apps/server/src/mcp/_shared.ts`) when `snippet` is set, and restrict returned fields when `fields` is set, always retaining identity fields (`id`, `type`, `title`). Selection, ordering, scope, and `last_seen_at` touch MUST be unchanged.
- [x] 3.3 Add tests proving (a) default request (no `snippet`/`fields`) returns the unchanged full-content shape, (b) `snippet: N` truncates `content` identically to the `memory.context` helper, (c) `fields` restricts the row shape but keeps identity fields, (d) projection does not change which rows are returned nor their order — so that `pnpm vitest run apps/server/src/mcp/memory-tools.test.ts` passes.

## 4. memory.get batch form (mcp-api)

- [x] 4.1 In `apps/server/src/mcp/memory-tools.ts`, extend `memoryGetSchema` to add `ids?: string[]` (bounded by `.max(...)`) alongside `id?: string`, with a refine enforcing "exactly one of `id` / `ids`" surfaced as `invalid_input`.
- [x] 4.2 Extend `memoryGetOutput` to also describe the batch response (`memories: [...]` plus a `notFound: string[]`), and branch `handleGet`: single-`id` path returns today's exact shape; `ids` path calls `deps.memory.getMany(ids, scope)`, runs the existing per-row `isAuthorized` check, and reports ids that did not resolve in `notFound`.
- [x] 4.3 Add tests proving (a) legacy single-`id` request is byte-for-byte unchanged, (b) `ids` returns an ordered batch, (c) a cross-scope id appears in `notFound` and never leaks content, (d) supplying both `id` and `ids` (or neither) is `invalid_input` — so that `pnpm vitest run apps/server/src/mcp/memory-tools.test.ts` passes.

## 5. Validate, typecheck, full suite

- [x] 5.1 `npx openspec validate --strict add-recall-projection-and-batch-get` exits clean.
- [x] 5.2 `pnpm run typecheck` and `pnpm run lint` pass with no `any`/`as unknown as` in the new code.
- [x] 5.3 `pnpm test` passes (pre-push gate), including the data-access and append-only invariant tests in `apps/server/src/test/invariants.test.ts`.
- [x] 5.4 (operator smoke) Validated against `pnpm run dev:docker:up` via an MCP client at `/mcp/demo`: `memory.search` default returns full content; `snippet:20` truncates with ellipsis; `fields:['id','title']` keeps identity and omits `content` without changing the result set/order; `memory.get` single returns the legacy `{memory,head,…}` shape, batch `ids` returns ordered rows with unknown ids in `notFound` (no content leak), and both/neither `id`/`ids` → `invalid_input`; a CJK-only save surfaced candidates via the unified FTS builder (empty MATCH before #202).
