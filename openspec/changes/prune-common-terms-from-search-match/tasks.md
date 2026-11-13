## 1. Specification

- [x] 1.1 Re-measure the search path on the base commit: `measurements/baseline.mts` → `measurements/baseline.txt`. It covers the unpruned and both fallback bounds, the gate's read, a separate per-token read, and the combined read with and without term deduplication.
- [x] 1.2 Write the proposal, the design and the `memory` delta. The delta:
  - ADDS "The search lexical `MATCH` MUST omit terms present in at least half of the index";
  - MODIFIES "Recall MUST be able to return nothing", only in the scenario "Abstention is off by default".
- [x] 1.3 Run `openspec validate prune-common-terms-from-search-match --strict`, `node scripts/check-delta-freshness.mjs` and `node scripts/check-spec-crossrefs.mjs`.
- [x] 1.4 Commit: `docs(openspec): propose pruning common terms from the search match`.

## 2. Combined statistics read

- [x] 2.1 RED in `packages/db/src/repositories/term-statistics-repository.test.ts`. `adminSearchTermFrequencies(query, tokens)` must:
  - return the query's map exactly as `adminQueryTermFrequencies` returned it, key order included;
  - return each token's term instances in order, with `null` for a term the index lacks;
  - count a repeated-term token such as `ha-ha` as two instances;
  - leak nothing between calls.
- [x] 2.2 GREEN: implement it with one `MATERIALIZED` CTE over the distinct terms; `adminQueryTermFrequencies(text)` delegates to it. Add the method to the `admin*` allow-list for `hybrid-search.ts`.

## 3. Pruning in the lexical branch

- [x] 3.1 RED in `packages/core/src/services/hybrid-search.test.ts`, recording the `matchExpr` passed to `searchBm25Ids`:
  - a common token is absent and a rarer one present;
  - the boundary: exactly N/2 omitted, N/2 − 1 kept;
  - one common term and one unknown term give the full expression;
  - a common-only query gives the full expression and the same ids as `commonTermRatio: null`;
  - a phrase token of common terms is kept;
  - a gated search issues `adminDocumentCount` and `adminSearchTermFrequencies` once each, and its level inputs equal a separate read;
  - commonness is judged over the whole index, not the searched project.
- [x] 3.2 RED in `packages/core/src/services/save-time-candidates.test.ts`: `pruneCommonTokens` with `ownIndexedRows` 0 keeps a pruned list whose kept token reaches exactly one row, and with 1 falls back.
- [x] 3.3 GREEN: `pruneCommonTokens(tokens, terms, total, ratio, ownIndexedRows)`; the save-time call passes 1. `hybridSearch` reads statistics at most once, prunes in the lexical retriever, reuses the read in `poolLevels`; `commonTermRatio` seam.
- [x] 3.4 Amend the tests the omission reaches:
  - the gates-disabled and empty-pool read tests follow the delta's scenario: with pruning on, the only statistics reads are the lexical branch's; with `commonTermRatio: null` there are none;
  - the gate-mechanics tests in `hybrid-search.test.ts` run with `commonTermRatio: null`; their four-to-thirteen-row corpora make every shared word index-common, so pruning would empty the weak rows they exist to cut;
  - `packages/mcp/src/context-relevance-under-gates.test.ts` pads its corpus with unrelated rows so the fillers' shared terms stay under the ratio, and still asserts the shipped gate shortens the page;
  - `commonTermRatio` joins `GateOverrides`, which no MCP input reaches.

## 4. Evidence

- [x] 4.1 `pnpm eval` against the committed baselines → `measurements/retrieval-eval.txt`. Any floor drop or cap rise stops here for an owner decision.
- [x] 4.2 Mutation (`scripts/mutate.mjs`): the ratio comparison, the `frequencies.length === 1` phrase guard, the `ownIndexedRows` bound, the read memoisation → `measurements/mutation.txt`.
- [x] 4.3 After-measurement through `MemoryService.search` at 1 000 / 20 000 / 50 000 rows → `measurements/search-after.txt`.
- [x] 4.4 Differential check against the base commit for the code the change shares: `pnpm run eval:save-time` is byte-identical (save-time `pruneCommonTokens` with own rows 1), and `dump-ids.ts`, which covers the widened eval query, differs only in the three reorderings `retrieval-eval.txt` lists.
- [x] 4.5 Docs: `docs/embeddings.md`.
- [x] 4.6 `pnpm run typecheck`, `pnpm run lint`, `pnpm test`.

## 5. Results

- `pnpm eval`: identical scorecard before and after; no baseline moves.
- End to end (`search-after.txt`, p50 over 28 queries, run 1 / run 2): realistic 50 000 rows 7.877 / 7.903 ms before, 5.687 / 5.680 ms after; 20 000 rows 3.519 / 3.761 → 2.731 / 2.775 ms; generator 50 000 rows 29.851 / 30.457 → 28.416 / 28.635 ms. No size or corpus got slower.
