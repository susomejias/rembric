## 1. Specification

- [x] 1.1 Write the proposal, the design and the `memory` delta. The delta does two things:
  - it ADDS "The save-time lexical `MATCH` MUST omit terms present in at least half of the index";
  - it MODIFIES the builder paragraph of "`memory.save` MUST surface candidate conflicts at save-time".
- [x] 1.2 Run `openspec validate prune-common-terms-from-save-time-match --strict`, `node scripts/check-delta-freshness.mjs` and `node scripts/check-spec-crossrefs.mjs`. The only body difference reported for this change must be the deliberate builder-paragraph rewrite.
- [x] 1.3 Commit: `docs(openspec): propose pruning common terms from the save-time match`.

## 2. RED

- [x] 2.1 In `packages/core/src/services/save-time-candidates.test.ts`, record the `matchExpr` passed to `searchBm25Candidates` through a spy on the `repos` argument. Add tests that fail on the current code:
  - a token found in at least half of the rows is absent from the `MATCH`, and a rarer token is present;
  - at exactly N/2 the token is omitted, and at N/2 − 1 it is kept;
  - a near-duplicate that shares a rarer token is still surfaced with `source: 'fts'` and an unchanged `similarity`.

  Observe them fail.

- [x] 2.2 Add the fallback and phrase tests:
  - a save whose every token is common gets the builder's unmodified expression;
  - a save whose only kept tokens exist only in itself gets the builder's unmodified expression, and an existing memory sharing its common tokens still surfaces;
  - a multi-term token whose terms are all common stays in the `MATCH`.

  These pass on the current code, because the current code never omits anything. Their coverage is proven by mutation in 4.4.

- [x] 2.3 In `packages/db/src/repositories/term-statistics-repository.test.ts`, add tests that fail because the method does not exist yet. `adminTokenTermFrequencies` must:
  - return each token's term instances in order, from the index's tokenizer;
  - report a term the index lacks as `null`;
  - count a repeated-term token such as `ha-ha` as two instances;
  - leak nothing between calls.

## 3. GREEN

- [x] 3.1 `packages/db/src/query-tokenizer.ts`: add the temp-schema `fts5vocab(…, 'instance')` view beside the existing row view. Extend `query-tokenizer.test.ts` so it asserts that the view is temp-only and absent from the durable schema.
- [x] 3.2 `TermStatisticsRepository.adminTokenTermFrequencies(tokens)`: one `delete-all`, one `INSERT … SELECT FROM json_each`, and one SELECT over the instance view LEFT JOINed to `memory_fts_vocab`.
- [x] 3.3 `hybrid-search.ts`: expose the builder's capped token list, so `sanitizeFtsQuery` and the save-time pass share one builder.
- [x] 3.4 `save-time-candidates.ts`:
  - declare `COMMON_TERM_DOCUMENT_RATIO = 0.5`;
  - add `commonTermRatio?: number | null` as a test seam, never read from the environment;
  - prune common single-term tokens, and apply the fallback.

  Add `termStatistics` to the `repos` picks of `findSaveTimeCandidates`, `PostSaveDeps` and `MemoryToolDeps`.

- [x] 3.5 `apps/web/src/test/invariants.test.ts`: allow-list `adminDocumentCount` and `adminTokenTermFrequencies` for `packages/core/src/services/save-time-candidates.ts`.
- [x] 3.6 Extend the existing env-read test so it also asserts that `COMMON_TERM_DOCUMENT_RATIO` is not readable from the environment.
- [x] 3.7 Run `pnpm run typecheck`, `pnpm run lint` and the touched test files. All must be green.

## 4. Evidence

All evidence lives under `openspec/changes/prune-common-terms-from-save-time-match/measurements/`, with a `README.md`.

- [x] 4.1 `idf-clamp.txt`: FTS5's bm25 returns `-1e-6` exactly when `n >= N/2`.
- [x] 4.2 `statement.txt`: the save-time statement, unpruned against pruned, plus the cost of the document-frequency read itself, at 1 000, 20 000 and 50 000 rows on both corpora. Record:
  - the rows matched;
  - how often the fallback fires;
  - post-floor lexical candidates, unpruned against pruned;
  - the fallback sizes compared (keep 1, 2, 4, 8, all).
- [x] 4.3 `save-latency.txt`: paired end-to-end `saveMemoryWithCandidates` p50 at the same sizes, with arms off, on and off.
- [x] 4.4 `mutation.txt`: run `scripts/mutate.mjs` on three mutations:
  - the pruning condition removed;
  - `>=` weakened to `>`;
  - the fallback removed.

  Each must turn the tests that name it red.

- [x] 4.5 Behaviour gates:
  - `pnpm run eval:save-time` is byte-identical to `add-save-time-lexical-floor/measurements/sweep.txt`, or every difference is explained;
  - `pnpm eval` passes, and `dump-ids.ts` output is identical before and after.
- [x] 4.6 `search-path.txt`: measure the interactive `memory.search` lexical branch with the same two variants. Do not change it.

## 5. Docs and close

- [x] 5.1 `docs/embeddings.md`: update the detection diagram and the engine-constants table, and add one sentence on pruning.
- [x] 5.2 Run the full `pnpm test` once.
- [ ] 5.3 Commit: `perf(core): drop index-common terms from the save-time lexical match`.

## 6. Score only the saving project's matches (owner request)

- [x] 6.1 Record the owner's decision to keep every token in the fallback in `design.md` (D3).
- [x] 6.2 Measure the statement shapes at 1 000, 20 000 and 50 000 rows, with the saving project at 2%, 20% and 60% of rows, on both corpora, with today's `(id, score)` list as the fidelity reference (`measurements/plans.txt`). The shapes:
  - A, today;
  - B, `ORDER BY bm25(memory_fts)`;
  - B2, B plus a rowid set;
  - E1, a project column in the FTS table;
  - E2, an FTS table per project;
  - a memory-driven join (`measurements/driven-and-rebuild.txt`).
- [x] 6.3 RED: add a plan-shape test and a score-fidelity test for `searchBm25Candidates` in `memory-repository.perf.test.ts`. The plan test fails on the old statement.
- [x] 6.4 GREEN: order by `bm25(memory_fts)`. Check that the sweep is byte-identical to the pruning-only run, that `dump-ids` is identical, and that `pnpm eval` passes.
- [x] 6.5 Mutation (`measurements/mutation.txt`): reverting to the FTS5 rank column, weighting the scores, and weighting the order are each caught.
- [x] 6.6 Re-measure end to end with four arms (`measurements/save-latency.txt`): before, after, pruning only, and before again.
- [ ] 6.7 **Stop and report** before any derived-index migration (E2). That is an owner decision.
- [ ] 6.8 Commit: `perf(db): score only the saving project's matches in the save-time lexical query`.
