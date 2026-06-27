# Design — recall projection, scoped batch get, unified FTS builder

## Context

Three independent recall-path defects, grouped because they all change what the agent actually receives back from a recall.

1. **Search projection.** `memorySearchSchema.limit` allows up to 200 (`memory-tools.ts:73`), and `handleSearch` returns full `content` per row (`:606`). A broad triage scan (`limit: 200`, no narrowing filters) therefore streams up to 200 full memory bodies into the context window before the agent has decided which are worth reading. `memory.context` already solved the same problem for its own lists with the `snippet(content, CONTEXT_SNIPPET_CHARS)` helper (`_shared.ts:77`, used at `memory-tools.ts:737/751/764`), but `memory.search` has no equivalent affordance.

2. **Batch get.** `memory.context` returns ids with a 350-char snippet and the documented next step is to "drill in with memory.get", but `memoryGetSchema` is `{ id }` (`:88`) and `handleGet` resolves exactly one (`:623-675`). Pulling N full bodies the agent identified from a context snapshot is N MCP round-trips. The service already has a batch primitive — `MemoryService.unsafeGetByIds` (`memory.ts:433`) delegating to the repo `unsafeGetByIds` (`memory-repository.ts:342`, a scope-naive `inArray(memory.id, ids)`), used internally by `search` (`memory.ts:327`). But it is `@internal` and cross-scope by design — it must NOT be exposed raw.

3. **FTS builder divergence.** `escapeFts` (`save-time-candidates.ts:134`) is ASCII-only: it splits on `/[^a-z0-9]+/` (`:137`), so a Japanese or accented memory body tokenizes to zero tokens and returns `''`; the caller then skips the FTS pass (`:82`, `if (matchExpr.length > 0)`). `sanitizeFtsQuery` (`hybrid-search.ts:122`) is Unicode-aware: it keeps any token containing `/[\p{L}\p{N}]/u` (`:130`). The compiled-in embedder is `gte-multilingual-base` (`save-time-candidates.ts:26`), so the corpus is expected to be multilingual — yet for that exact corpus, save-time conflict detection silently runs vector-only, missing lexical-only duplicates whose embeddings are below the vec threshold or not yet computed. The two builders share the same OR-of-quoted-phrases output strategy; the only material differences are `escapeFts`'s lowercase + min-length-3 + uniquify + 16-term cap.

## Goals / Non-Goals

**Goals**

- Let the agent scan `memory.search` results cheaply (snippet/field projection) then drill in, without breaking the default full-content shape.
- Let the agent fetch N memories the context snapshot surfaced in ONE scope-enforced call.
- Make save-time FTS candidate detection work for the multilingual corpus the embedder targets, by collapsing onto one Unicode-aware builder.

**Non-Goals**

- No change to ranking, fusion (RRF), or which rows `memory.search` selects — projection is purely presentational, applied AFTER selection.
- No new MCP tool, no new plugin manifest entry, no change to the four-client wire surface beyond the two extended schemas.
- No change to scope-resolution semantics; batch get reuses `resolveEffectiveProject` exactly as single get does.
- No change to the interactive-search FTS behaviour or its existing test expectations.

## Decisions

### Decision 1 — Extend `memory.get` with `ids[]` vs add a new `memory.get_many` tool

**Chosen:** Extend `memory.get` to accept `ids?: string[]` alongside `id?: string` (exactly one required). The single-`id` path is unchanged; the batch path returns `{ memories: [...], notFound: [...] }`.

**Alternatives considered:**

- _New `memory.get_many` tool._ Cleaner schema (no `id` xor `ids` validation), but it adds a tool to the MCP surface, which means a new entry in every client's tool list and description, plus a new protocol-teaching description and CI assertion. The repo's plugin discipline explicitly prizes minimizing per-client churn ("prefer backward-compatible extension to avoid plugin-manifest churn"). Rejected for the surface cost.
- _Comma-joined string `id: "a,b,c"`._ No schema change at all, but it overloads a typed field with ad-hoc parsing, is hostile to the typed clients, and muddies validation errors. Rejected.

The xor constraint is expressed with a zod `superRefine`/`refine` on the tool args ("exactly one of `id`, `ids`"), surfaced as the existing `invalid_input` MCP error (covered by the existing zod-validation requirement in `mcp-api`).

### Decision 2 — Where to enforce scope on the batch path

**Chosen:** Add a SCOPED `MemoryService.getMany(ids, scope)` that calls `unsafeGetByIds(ids)` then filters each row through `memoryMatchesScope(row, scope)` (the same predicate single `get` uses at `memory.ts:212`), dropping non-matching rows. `unsafeGetByIds` stays `@internal` and cross-scope; only `getMany` is callable from the MCP handler. Out-of-scope (and genuinely missing) ids are reported back as not-found ids — the handler cannot distinguish the two, so no existence/content of another scope's rows ever leaks. This mirrors single `get`'s "missing OR out-of-scope → null" contract (`memory.ts:206-212`).

**Alternatives considered:**

- _Push scope into the repository (`getByIds(ids, scope)`)._ Possible, but the codebase resolves scope at the service layer and passes it down to scoped repo reads; an unscoped `unsafeGetByIds` already exists and is used by `search`. Adding a parallel scoped repo method duplicates the filter that the service can apply in one pass. The data-access invariant is satisfied either way (no SQL leaves `db/`); doing the filter in the service keeps the repo surface minimal. Accepted to keep one scope-filter codepath shared with single `get`.
- _Per-id authz in the handler only (no service guard)._ The handler does run `isAuthorized` per row (it must, to honour read-only/token-scope rules like single `get` at `:637`), but token-authz is orthogonal to memory-scope isolation. Relying on authz alone would let a project-scoped connection probe ids from other projects. Rejected — scope isolation must live in the service, authz layered on top.

### Decision 3 — Projection shape: `snippet` (number) and/or `fields` (string[])

**Chosen:** Two orthogonal optional params. `snippet: number` truncates each row's `content` via the shared `snippet()` helper (identical semantics to `memory.context`: slice to `N-1` + `…`). `fields: string[]` selects which row fields to return (always-present invariants — `id`, `type`, `title` — are returned regardless so a projected row is still identifiable). They compose: `fields` including `content` together with `snippet` yields a truncated content field. Default (neither set) returns today's full shape.

**Alternatives considered:**

- _Boolean `full: false`._ Coarser; the agent cannot tune snippet length per scan. The numeric `snippet` matches the existing `memory.context` mental model and is strictly more flexible. Rejected.
- _Only `snippet`, no `fields`._ Snippet alone covers the "200 full bodies" cost (the dominant cost is `content` length). `fields` is the smaller win but cheap to add and lets a pure id+title triage skip `relations`/`reviewState` payload too. Kept both; `fields` is optional and additive.
- _Server-imposed default snippet when `limit` is large._ Would silently change the default response shape for existing callers requesting big pages — a back-compat break. Rejected; projection is strictly opt-in.

### Decision 4 — Unify the FTS builders on `sanitizeFtsQuery`, parameterized

**Chosen:** Keep ONE Unicode-aware builder (the `sanitizeFtsQuery` strategy: keep whole Unicode word tokens, strip stray quotes, drop pure-punctuation tokens, OR quoted phrases) and give it an optional `maxTerms` cap. The interactive-search call (`hybrid-search.ts:51`) passes no cap (current behaviour). The save-time call passes `maxTerms: 16`. `escapeFts` is deleted. The save-time path loses `escapeFts`'s lowercase + min-length-3 + uniquify, but: lowercasing is unnecessary (the FTS5 tokenizer case-folds), min-length-3 only dropped short ASCII noise (the OR-fusion ranking already down-weights ubiquitous short tokens, and dropping them entirely is exactly what kills CJK where "tokens" may be short), and dedup is a minor efficiency that the term cap already bounds.

**Alternatives considered:**

- _Make `escapeFts` Unicode-aware in place, keep two functions._ Fixes the bug but preserves two near-identical builders that will drift again — the CLAUDE.md "cross-language wrapper > duplication" ethos argues for one. Rejected.
- _Unify on `escapeFts` (ASCII) and Unicode-enable it._ Equivalent to the above; still two functions. Rejected.
- _Keep min-length-3 / dedup in the unified builder behind a flag._ Adds config surface for a behaviour that the interactive path deliberately does NOT want (it keeps short tokens like "C++" → `"C++"`, tested at `hybrid-search.test.ts:35`). A flag that only the save path sets re-introduces a fork. Rejected; only the term cap is parameterized.

## Risks / Trade-offs

- [Trade-off] Dropping `escapeFts`'s min-length-3 filter means short/common ASCII tokens (e.g. "the") now enter the save-time `MATCH`. → Accepted because the unified builder ORs quoted phrases and BM25 already ranks ubiquitous tokens low; the `FTS_THRESHOLD` (0.4) still gates which BM25 hits become candidates, so noise does not inflate the candidate set. Behaviour matches the interactive path, which has shipped with this exact tokenization.
- [Risk] Removing the 16-term cap by accident would let a very long save body build a huge `MATCH` expression. → Mitigation: the cap is an explicit `maxTerms` argument the save path MUST pass; a unit test asserts the unified builder truncates at the cap, and a test asserts the save-time call still produces ≤16 phrases.
- [Risk] The `id` xor `ids` validation could regress single-`id` callers. → Mitigation: a scenario asserts the legacy single-`id` request returns the unchanged single-memory shape, and a scenario asserts supplying both `id` and `ids` is an `invalid_input` error.
- [Risk] Batch get could leak cross-scope existence via timing or via a distinct error per id. → Mitigation: `getMany` drops out-of-scope rows identically to genuinely-missing ones; the response reports an undifferentiated `notFound` id list (same "cannot tell the two apart" guarantee as single `get`). A scenario asserts a cross-scope id appears in `notFound`, never in `memories`.
- [Trade-off] `fields` adds per-row shaping logic to `handleSearch`. → Accepted because it is a pure presentational filter over already-selected rows; ordering, scope, and selection are untouched (asserted by a scenario that projection does not change which rows or their order).
- [Risk] A non-ASCII save that previously surfaced zero candidates may now surface FTS candidates, changing `memory.save` output for existing flows. → Mitigation: this is the intended correctness fix; it is called out as internal-BREAKING in the proposal and covered by a new scenario in the `memory` candidate-detection requirement.

## Migration Plan

Pure additive at the wire level plus one internal builder consolidation; no data migration, no SQLite table rebuild.

1. Generalize the lexical builder in `hybrid-search.ts` to accept an optional `maxTerms`; keep the no-arg call behaviour identical (existing `hybrid-search.test.ts` cases must still pass verbatim).
2. Replace `escapeFts(saved.content)` in `save-time-candidates.ts` with the unified builder at `maxTerms: 16`; delete `escapeFts`.
3. Add `MemoryService.getMany(ids, scope)` (scoped wrapper over `unsafeGetByIds` + `memoryMatchesScope`).
4. Extend `memorySearchSchema` (`snippet`, `fields`) and `handleSearch` projection; extend `memoryGetSchema` (`ids`) and `handleGet` batch branch with per-row authz.
5. Update tool schemas/outputs and tests; run `pnpm run typecheck`, `pnpm test`.

No client/plugin manifest change is required (no new tool). Rollback is reverting the diff; no persisted state changes.

## Open Questions

- `fields` allowed set: should it be a closed zod enum of the row keys (rejecting unknown field names with `invalid_input`) or a permissive string list that silently ignores unknowns? Leaning closed-enum for a typed contract — resolved at apply time; the spec only requires that always-present identity fields are returned and unknown handling is deterministic.
- Should the batch `memory.get` cap `ids.length` (e.g. ≤50) to bound payload size, mirroring `memory.context`'s `memories` clamp of 100? Leaning yes with a `.max()` on the array; exact ceiling deferred to apply.
