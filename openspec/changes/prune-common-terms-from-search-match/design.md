## Context

`hybridSearch` (`packages/core/src/services/hybrid-search.ts`) runs a lexical and a dense retriever and fuses them with RRF. The lexical retriever builds `"t1" OR "t2" OR …` from every whitespace token of the query (`sanitizeFtsQuery`, uncapped on this path) and calls `searchBm25Ids`, which orders the FTS5 matches by weighted bm25 and limits to the rank window. When a query token is common, nearly every row matches and is scored.

After fusion, the relevance gate (`poolLevels`) reads `adminDocumentCount` and `adminQueryTermFrequencies(query)`: the query's terms, tokenised by the index's own tokenizer, with their document frequencies in `memory_fts_vocab`. With `RELATIVE_LEVEL_RATIO = 0.4`, that read runs on every search whose pool is not empty.

#469 added `pruneCommonTokens` for the save-time statement. #465 then moved save-time detection onto per-project indexes and replaced the global per-token read with a project-scoped one. Its D1 keeps interactive search on the global `memory_fts`. The issue's "settle the order first" is therefore answered: this change prunes against the global index.

## Goals / Non-Goals

**Goals:**

- Drop index-common single-term tokens from the search `MATCH`, with the save-time constant and helper.
- Never empty the lexical branch where today's expression matches something.
- No new read on top of the one the gate already makes, and no change to the gate's inputs.
- A retrieval-eval run under the ratchet, with any movement justified.

**Non-Goals:**

- The dashboard memory search (owner decision). It shares `sanitizeFtsQuery` but has its own contract and no quality metric.
- Moving search onto the per-project indexes (#465 D1).
- Changing `COMMON_TERM_DOCUMENT_RATIO`, the gate, RRF, the boost or the rank window.

## Measurements

`measurements/baseline.txt`, taken on the base commit with `measurements/baseline.mts`. The instruments are named in the file and are never tabulated together. Realistic control, largest project, 28 retrieval-eval queries:

| rows   | statement unpruned | statement pruned | rows matched unpruned → pruned | gate read today | combined read, deduplicated |
| ------ | ------------------ | ---------------- | ------------------------------ | --------------- | --------------------------- |
| 1 000  | 0.303 ms           | 0.240 ms         | 90.0% → 51.5%                  | 0.109 ms        | 0.121 ms                    |
| 20 000 | 2.719 ms           | 1.748 ms         | 90.0% → 51.4%                  | 0.339 ms        | 0.351 ms                    |
| 50 000 | 6.625 ms           | 4.223 ms         | 90.0% → 51.4%                  | 0.675 ms        | 0.694 ms                    |

On the generator corpus almost every row still matches after pruning (96.6% → 96.5% at 50 000), so the statement gains little there (24.0 → 23.3 ms): pruning changes 12 of its 28 expressions, and the terms that remain still reach nearly every row.

## Decisions

### D1 — Global statistics, global ratio

The statement scans `memory_fts`, whose bm25 inverse document frequencies are global. The clamp that makes a term worthless to the ranking is therefore global as well, so the frequency and the total come from the same index: `memory_fts_vocab.doc` and `adminDocumentCount()`, every `memory` row. That pair is already the gate's denominator ("The relevance level's term statistics MUST come from the search index"). A widened multi-project search uses the same statistics: it scans the same table.

The ratio is `COMMON_TERM_DOCUMENT_RATIO`, not a second constant (owner decision). Both uses are justified by the same bm25 clamp.

### D2 — Fallback: a kept token must reach at least one row (owner decision)

`pruneCommonTokens` keeps every token when no kept token reaches another row. At save time, "another" means a frequency above 1, because the saved row is already indexed. A query is not indexed, so for search the bound is 0. The helper gains a required `ownIndexedRows` argument instead of a second copy of the rule.

Measured consequence (`baseline.txt`): on the realistic corpus both bounds produce the same expressions (19/28 changed) and the same top-8 (27/28 identical). On the generator at 1 000 rows the bounds differ. With "above 0" a query built from a memory's own words matches 0.1% of rows instead of 96.8%, and the top-8 is identical for 13/28 queries instead of 17/28. The positions that change held rows that matched on common terms only, whose bm25 contribution is clamped to `1e-6`. The owner kept "above 0".

### D3 — One read, terms deduplicated (owner decision)

The pruning needs each token's terms as the index tokenises them: a token such as `two-space` is a two-term phrase and must not be pruned on one term's count ("Term-statistics lookups MUST be keyed on the index's own terms"). A JavaScript re-tokenisation was rejected for that reason.

`adminSearchTermFrequencies(query, tokens)` writes the query as row 0 and token _i_ as row _i + 1_ into the temp-schema tokenising table, then reads every instance with its frequency in one statement. A naive join costs twice the gate's read, because each term's document count is read once per instance (1.318 ms against 0.675 ms at 50 000 rows). A `MATERIALIZED` CTE joins each distinct term to `memory_fts_vocab` once: 0.694 ms. The output equals the two separate reads for 28/28 queries at every size and on both corpora.

Row 0 is read in term order, the order the vocabulary table produced, so the gate's map and its floating-point sums are unchanged. `adminQueryTermFrequencies(text)` becomes `adminSearchTermFrequencies(text, []).query`, so there is one implementation.

`hybridSearch` reads at most once per call, on first use. The lexical branch uses it whenever the query has a token; `poolLevels` reuses it. A gated search with a non-empty pool therefore makes the same statistics reads as before: `adminDocumentCount` and one tokenising read. A search with both gates disabled, or whose pool is empty, now makes them once on the lexical branch's behalf. The spec scenario "Abstention is off by default" is amended accordingly (owner decision).

### D4 — Failure stays inside the lexical branch

The statistics read runs inside the lexical retriever's existing `try`. If it throws, the lexical branch returns nothing and search degrades to the dense branch, as for any lexical failure ("A failure of either branch SHALL degrade gracefully"). The gate makes its own attempt later, exactly as today.

### D5 — Test seam, not configuration

`commonTermRatio?: number | null` on `HybridSearchOpts`. Production omits it. `null` turns pruning and its read off, which reproduces the base behaviour for comparisons. It is not in `SearchMemoriesInput` or `GateOverrides`, so no MCP schema can reach it.

## Risks / Trade-offs

- **Results move for queries whose lexical matches were held up by common terms only.** Mitigation: `pnpm eval` under the ratchet. Any floor drop or cap rise stops the change for an owner decision (owner decision); see `measurements/retrieval-eval.txt`.
- **The gain is corpus-dependent.** On a realistic vocabulary it is about a third of the statement at 50 000 rows. On a flat vocabulary it is small, and the extra cost is the 0.01–0.03 ms deduplicated read. It is never a new full read.
- **Gates disabled now read statistics.** This is only reachable through the test seams and the calibration sweep; production always has the relative filter enabled.

## Migration Plan

None. No schema or stored data changes; rollback is a revert.
