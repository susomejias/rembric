## 1. Specification

- [x] 1.1 Write the proposal, the design and the `memory` delta. The delta does two things:
  - it ADDS "The save-time lexical `MATCH` MUST omit terms present in at least half of the index";
  - it MODIFIES the builder paragraph of "`memory.save` MUST surface candidate conflicts at save-time".
- [x] 1.2 Run `openspec validate prune-common-terms-from-save-time-match --strict`, `node scripts/check-delta-freshness.mjs` and `node scripts/check-spec-crossrefs.mjs`. The only body difference reported for this change must be the deliberate builder-paragraph rewrite.
- [ ] 1.3 Commit: `docs(openspec): propose pruning common terms from the save-time match`.

## 2. RED

- [ ] 2.1 In `packages/core/src/services/save-time-candidates.test.ts`, record the `matchExpr` passed to `searchBm25Candidates` through a spy on the `repos` argument. Add tests that fail on the current code:
  - a token found in at least half of the rows is absent from the `MATCH`, and a rarer token is present;
  - at exactly N/2 the token is omitted, and at N/2 − 1 it is kept;
  - a near-duplicate that shares a rarer token is still surfaced with `source: 'fts'` and an unchanged `similarity`.

  Observe them fail.

- [ ] 2.2 Add the fallback and phrase tests:
  - a save whose every token is common gets the builder's unmodified expression;
  - a save whose only kept tokens exist only in itself gets the builder's unmodified expression, and an existing memory sharing its common tokens still surfaces;
  - a multi-term token whose terms are all common stays in the `MATCH`.

  These pass on the current code, because the current code never omits anything. Their coverage is proven by mutation in 4.4.

- [ ] 2.3 In `packages/db/src/repositories/term-statistics-repository.test.ts`, add tests that fail because the method does not exist yet. `adminTokenTermFrequencies` must:
  - return each token's term instances in order, from the index's tokenizer;
  - report a term the index lacks as `null`;
  - count a repeated-term token such as `ha-ha` as two instances;
  - leak nothing between calls.

## 3. GREEN

- [ ] 3.1 `packages/db/src/query-tokenizer.ts`: add the temp-schema `fts5vocab(…, 'instance')` view beside the existing row view. Extend `query-tokenizer.test.ts` so it asserts that the view is temp-only and absent from the durable schema.
- [ ] 3.2 `TermStatisticsRepository.adminTokenTermFrequencies(tokens)`: one `delete-all`, one `INSERT … SELECT FROM json_each`, and one SELECT over the instance view LEFT JOINed to `memory_fts_vocab`.
- [ ] 3.3 `hybrid-search.ts`: expose the builder's capped token list, so `sanitizeFtsQuery` and the save-time pass share one builder.
- [ ] 3.4 `save-time-candidates.ts`:
  - declare `COMMON_TERM_DOCUMENT_RATIO = 0.5`;
  - add `commonTermRatio?: number | null` as a test seam, never read from the environment;
  - prune common single-term tokens, and apply the fallback.

  Add `termStatistics` to the `repos` picks of `findSaveTimeCandidates`, `PostSaveDeps` and `MemoryToolDeps`.

- [ ] 3.5 `apps/web/src/test/invariants.test.ts`: allow-list `adminDocumentCount` and `adminTokenTermFrequencies` for `packages/core/src/services/save-time-candidates.ts`.
- [ ] 3.6 Extend the existing env-read test so it also asserts that `COMMON_TERM_DOCUMENT_RATIO` is not readable from the environment.
- [ ] 3.7 Run `pnpm run typecheck`, `pnpm run lint` and the touched test files. All must be green.

## 4. Evidence

All evidence lives under `openspec/changes/prune-common-terms-from-save-time-match/measurements/`, with a `README.md`.

- [ ] 4.1 `idf-clamp.txt`: FTS5's bm25 returns `-1e-6` exactly when `n >= N/2`.
- [ ] 4.2 `statement.txt`: the save-time statement, unpruned against pruned, plus the cost of the document-frequency read itself, at 1 000, 20 000 and 50 000 rows on both corpora. Record:
  - the rows matched;
  - how often the fallback fires;
  - post-floor lexical candidates, unpruned against pruned;
  - the fallback sizes compared (keep 1, 2, 4, 8, all).
- [ ] 4.3 `save-latency.txt`: paired end-to-end `saveMemoryWithCandidates` p50 at the same sizes, with arms off, on and off.
- [ ] 4.4 `mutation.txt`: run `scripts/mutate.mjs` on three mutations:
  - the pruning condition removed;
  - `>=` weakened to `>`;
  - the fallback removed.

  Each must turn the tests that name it red.

- [ ] 4.5 Behaviour gates:
  - `pnpm run eval:save-time` is byte-identical to `add-save-time-lexical-floor/measurements/sweep.txt`, or every difference is explained;
  - `pnpm eval` passes, and `dump-ids.ts` output is identical before and after.
- [ ] 4.6 `search-path.txt`: measure the interactive `memory.search` lexical branch with the same two variants. Do not change it.

## 5. Docs and close

- [ ] 5.1 `docs/embeddings.md`: update the detection diagram and the engine-constants table, and add one sentence on pruning.
- [ ] 5.2 Run the full `pnpm test` once.
- [ ] 5.3 Commit: `perf(core): drop index-common terms from the save-time lexical match`.
