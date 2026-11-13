## Why

`memory.search` gets slower as the whole server grows, not just as the searched project grows (issue #473). Its lexical branch ORs every token of the query into one FTS5 `MATCH`. One token found in most memories, such as "the" or "how", pulls almost every indexed row into the match set. FTS5 then computes bm25 for each of those rows and sorts them before the scope filter and `LIMIT` apply (`SCAN memory_fts VIRTUAL TABLE INDEX 0:M3 … USE TEMP B-TREE FOR ORDER BY`).

Re-measured on this change's base (`measurements/baseline.txt`), with the 28 retrieval-eval queries against the largest project of the realistic corpus:

| rows   | rows matched (p50) | statement p50 | `MemoryService.search` p50 (no embedder) |
| ------ | ------------------ | ------------- | ---------------------------------------- |
| 1 000  | 90.0%              | 0.303 ms      | 1.000 ms                                 |
| 20 000 | 90.0%              | 2.719 ms      | 3.521 ms                                 |
| 50 000 | 90.0%              | 6.625 ms      | 7.884 ms                                 |

Such a token adds nothing to the ranking. FTS5 clamps the inverse document frequency of a term found in at least half of the indexed rows to `1e-6` (`openspec/changes/prune-common-terms-from-save-time-match/measurements/idf-clamp.txt`). Save-time detection already drops these terms (#469).

The order against #465 is settled. Its decision D1 (`openspec/changes/scope-save-time-lexical-index-per-project/design.md`) keeps `memory.search` on the global `memory_fts`. So this change prunes against the global index: the same index the statement scans and bm25 weights terms over.

## What Changes

- Before building the search `MATCH`, the lexical branch drops every single-term token whose document frequency is at least `COMMON_TERM_DOCUMENT_RATIO` (`0.5`) of the document total. It is the same constant and the same `pruneCommonTokens` the save-time pass uses. The statistics are global: per-term counts from `memory_fts_vocab`, and every `memory` row as the total, which is the population the relevance gate already uses.
- **Fallback (owner decision):** if no kept token occurs in any indexed row, the branch keeps every token, exactly as the builder produced them. A query made only of common words therefore matches what it matched before. Because the counts are global and the statement is scoped and filtered, a reduced `MATCH` that returns no row is run again as the full expression, and a failed statistics read searches the full expression. A query is not an indexed row, so the save-time "another row" test (frequency above 1) becomes "any row" (frequency above 0). `pruneCommonTokens` takes the number of indexed rows that belong to the probe itself: 1 at save time, 0 for a query.
- **One read, shared (owner decision):** the relevance gate already reads term statistics on every gated search. A new read-only repository method tokenises the query (row 0) and each token (rows 1..n) through the existing temp-schema tokenising table in one statement, and joins each distinct term to `memory_fts_vocab` once. The gate's map comes from row 0, unchanged; the pruning uses rows 1..n. `hybridSearch` makes the read at most once per call and both consumers share it. Measured: the read costs the gate's current read plus 0.01–0.03 ms, and its output equals the separate reads for 28/28 queries at every size.
- **Test seam:** `commonTermRatio` on the `hybridSearch` options, `null` to turn pruning and its read off. Like the gate overrides, it is not part of any MCP input.
- **What stays the same:** the dashboard memory search (owner decision: only `memory.search` and `/api/<slug>/memory/recall`, which calls the same service), save-time detection, the relevance gate's weights and levels, RRF, the ranking boost, every MCP schema.

Behaviour change, not marked **BREAKING**: a lexical result that shared only index-common terms with a query may no longer be returned by the lexical branch. On the realistic corpus the top-8 lexical ids change for 1 of 28 queries; on the generator corpus for 12 of 28 at 50 000 rows, within rows that matched on common terms alone. No field, input, schema or stored row changes.

Invariants touched:

- **Scope at the service layer:** untouched. Term statistics are the unscoped aggregates "The relevance level's term statistics MUST come from the search index" already bounds. They only remove rows from the match set; they never add one.
- **Append-only memory, `topic_key` convergence, fresh-context judgment, derived review state:** untouched.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `memory`:
  - Adds "The search lexical `MATCH` MUST omit terms present in at least half of the index", naming the ratio, the fallback and the shared read.
  - Modifies "Recall MUST be able to return nothing": the scenario "Abstention is off by default" now allows the lexical branch's own statistics read, and still forbids any read made on the gates' behalf.

## Impact

- **Code:**
  - `packages/db/src/repositories/term-statistics-repository.ts`: `adminSearchTermFrequencies`; `adminQueryTermFrequencies` reads through it.
  - `packages/core/src/services/save-time-candidates.ts`: `pruneCommonTokens` takes the probe's own indexed rows.
  - `packages/core/src/services/hybrid-search.ts`: the lexical branch prunes; one memoised statistics read shared with `poolLevels`; the `commonTermRatio` seam.
- **Tests:** `term-statistics-repository.test.ts`, `hybrid-search.test.ts`, `save-time-candidates.test.ts`, and the `admin*` allow-list in `apps/web/src/test/invariants.test.ts`.
- **Retrieval eval:** `pnpm eval` against the committed baselines (`measurements/retrieval-eval.txt`).
- **Docs:** `docs/embeddings.md`.
- **Specs:** `openspec/specs/memory/spec.md`.
- **Measurements:** under `openspec/changes/prune-common-terms-from-search-match/measurements/`.
- **No change to:** the durable schema, migrations, stored data, MCP input schemas, the dashboard, plugins, the installer or dependencies.
