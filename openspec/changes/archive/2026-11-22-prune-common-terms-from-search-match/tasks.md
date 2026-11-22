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
- End to end (`search-after.txt`, after the correction, p50 over 28 queries, run 1 / run 2): realistic 50 000 rows 7.911 / 7.880 ms before, 5.657 / 5.673 ms after; 20 000 rows 3.509 / 3.486 → 2.709 / 2.730 ms; generator 50 000 rows 29.683 / 29.248 → 28.612 / 28.717 ms; generator 1 000 rows 2.719 / 2.657 → 2.650 / 2.640 ms (its reduced `MATCH` often finds nothing in scope and is rerun in full). No size or corpus got slower.

## 6. Independent verification and correction

- [x] 6.1 Independent verifier (Risk item 3: `pruneCommonTokens` is shared with save time, and the gate reads through the new statistics read). Save-time sweep byte-identical; the gate's document total and term map, entries and key order, identical to base on 74 end-to-end probes and 2 000 fuzzed queries.
- [x] 6.2 Blocker reproduced by the parent against the base copy: `kubernetes release notes` in a project of `release notes` rows, with `kubernetes` only in another project, FTS only: base 6 rows, `abstained: false`; change 0 rows, `abstained: true`, "no candidate matched the query in this scope". The same held for a `type` filter.
- [x] 6.3 Correction: a reduced `MATCH` that returns no row runs the full expression once more; a failed statistics read searches the full expression. RED: 3 tests failed on 471be1db. GREEN: 178/178 focused. The verifier's 74 probes now match base in results and abstention (0 differences, 0 emptied; before the correction 4 differed and 3 emptied).
- [x] 6.4 Mutation of the three new conditions: 3 of 3 caught (`mutation.txt`). `pnpm eval` and `dump-ids.ts` are unchanged by the correction (same sha256 as before it).
- [x] 6.5 The spec delta, design D2/D4, the proposal and `docs/embeddings.md` describe the full-expression rerun.
