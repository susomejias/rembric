## 1. One curation path (behaviour-preserving refactor)

- [x] 1.1 Move `runPostSaveSteps` and `SaveTimeCandidateView` out of `packages/mcp/src/memory-tools.ts` into a `core` service built only from `core` pieces (`extractEntities`, `findSaveTimeCandidates`, `RelationsService.createPending`, `linkMemory`). Keep its best-effort failure handling unchanged. `saveMemoryWithCandidates` and `handleMerge` call it, and `@rembric/mcp` re-exports the view type so its existing imports keep compiling.
- [x] 1.2 Replace `saveThroughCuration` in `packages/core/src/test-support/retrieval/ingest.ts` with a call to that service, and delete the copy.
- [x] 1.3 Done when:
  - `pnpm run typecheck` is green;
  - `pnpm test` is green with no test edited;
  - `pnpm eval` produces result ids identical to the committed retrieval baselines, and `floor-ratchet.test.ts` stays green.
- [x] 1.4 Commit as its own work unit: `refactor(core): share one post-save curation path between memory.save and the eval harness`.

## 2. Save-time fixture and calibration sweep

- [x] 2.1 Add the labelled save-time fixture beside the retrieval harness. It holds:
  - a heterogeneous base corpus of at least 20 memories, mixing English and Spanish, memory types and text lengths;
  - labelled saves in four classes: near-duplicate, expanded rewrite, contradiction and unrelated. Every class except unrelated names its expected target.

  The retrieval corpus and the query files stay untouched.

- [x] 2.2 Add the filter mechanism with no behaviour change: declare `LEXICAL_CANDIDATE_FLOOR = 0` beside `VEC_THRESHOLD`, add `lexicalFloor?: number` to `CandidateOptions` as a test seam beside `poolSize` (never read from the environment), and drop lexical pool rows whose `similarity` is below `opts.lexicalFloor ?? LEXICAL_CANDIDATE_FLOOR` before the merge, ranking and cap. At `0` every row is admitted, so the shipped behaviour is unchanged until task 3.2; `pnpm eval` result ids stay identical. The sweep needs the mechanism in place to vary the floor, which is why it lands before the RED test.
- [x] 2.3 Implement the sweep module and a documented root script (`pnpm run eval:save-time`) per the `retrieval-evaluation` delta:
  - two arms: lexical-only, and production with the compiled-in embedder;
  - a grid from `0.00` to `0.95` in steps of `0.05`;
  - output per grid point and arm: labelled pairs surfaced per class, pending rows per unrelated save by `source`, and total pending rows labelled as the queue-depth instrument;
  - a secondary series: pending rows created by ingesting the retrieval corpus at `0.00`.
- [x] 2.4 Add tests:
  - the `0.00` grid point writes the same pending rows as rank-only admission;
  - two lexical-only runs on unchanged inputs produce identical output.
- [x] 2.5 Run the sweep and commit its output as `openspec/changes/add-save-time-lexical-floor/measurements/sweep.txt`, naming the instrument on every row.
- [x] 2.6 From that grid, choose `LEXICAL_CANDIDATE_FLOOR` as the midpoint of the admissible plateau, rounded to the grid, per design D4. Record the plateau and the reasoning in `measurements/README.md`.
- [x] 2.7 **Stop and report** if no plateau at least `0.10` wide satisfies every criterion. In particular, report if the lexical-only arm cannot surface every near-duplicate while unrelated saves write zero lexical pending rows. That outcome is a **Needs your decision** result, never a hand-picked value.
- [x] 2.8 Commit: `test(core): add a save-time candidate calibration sweep over a labelled fixture`.

## 3. The lexical floor

- [x] 3.1 RED: add the issue-probe regression test to `packages/core/src/services/save-time-candidates.test.ts`, with no embeddings:
  - an unrelated save over a heterogeneous scope of at least 20 memories yields no `source: 'fts'` candidate and writes no pending row for one;
  - a lightly edited near-duplicate is surfaced with `source: 'fts'` and `similarity >= LEXICAL_CANDIDATE_FLOOR`.

  Observe the first assertion fail on the unchanged code.

- [x] 3.2 GREEN: set `LEXICAL_CANDIDATE_FLOOR` to the value chosen in 2.6. The vector and entity pools are untouched.
- [x] 3.3 Add one test per `memory` delta scenario:
  - a below-floor lexical match takes no slot, and `candidatesDetected` counts only admitted rows;
  - a below-floor lexical target is still surfaced as `source: 'vec'`;
  - the entity channel is not gated;
  - the same repository reads occur at the shipped floor and at `0`, asserted with a recording proxy over the `repos` argument.
- [x] 3.4 Assert that `LEXICAL_CANDIDATE_FLOOR`, `CANDIDATE_POOL_SIZE` and `ENTITY_RARITY_MIN_LINKS` are not readable from the environment. No such test existed, so `apps/web/src/test/save-time-constants-env.test.ts` adds one, with a control proving the scan sees the `CANDIDATES_PER_SAVE_MAX` env read.
- [x] 3.5 Mutation check. Weaken each piece separately with `node scripts/mutate.mjs`:
  - the floor comparison removed;
  - the constant set to `0`;
  - the filter moved after the cap.

  Confirm that the tests naming each piece turn red. Commit the commands and outcomes to `measurements/mutation.txt`.

- [x] 3.6 Re-run the sweep at the shipped constant and confirm it matches the chosen grid point. Re-run `pnpm eval` and confirm the retrieval baselines are unchanged.
- [x] 3.7 Commit: `fix(core): floor lexical save-time candidates so unrelated saves stop filling the judgment queue`.

## 4. Performance: no regression

- [ ] 4.1 Write `measurements/save-latency.mjs` per design D5:
  - instrument: end-to-end `saveMemoryWithCandidates` p50, embedder not wired;
  - corpora built with `pnpm run corpus:build` at 1 000, 20 000 and 50 000 rows;
  - arms `floor = 0.00` and `floor = shipped`, interleaved in one process, plus a second `0.00` arm for the noise band.
- [ ] 4.2 Commit the output as `measurements/save-latency.txt`, with the instrument named on every row. Confirm the added p50 is at or below the noise band at every size.
- [ ] 4.3 If the budget is missed, **stop**: the change adds no work, so investigate the implementation or the instrument. Never record it as an accepted cost.
- [ ] 4.4 Commit: `test(core): measure memory.save latency before and after the lexical floor`.

## 5. Description and documentation

- [ ] 5.1 Rewrite `SAVE_DESCRIPTION` in `packages/mcp/src/server.ts` per design D6 and the `mcp-api` delta:
  - no "configured similarity threshold";
  - the shared-rare-identifier source and its little-shared-wording caveat;
  - every `candidatesDetected` obligation kept.

  It must stay within `DESCRIPTION_MAX_LENGTH` including the redaction note.

- [ ] 5.2 Update `apps/web/src/test/mcp-transport.test.ts` with one assertion per `mcp-api` delta scenario.
- [ ] 5.3 Remove the `CANDIDATE_VEC_THRESHOLD` and `CANDIDATE_FTS_THRESHOLD` rows from `README.md`. Add a test asserting that `CANDIDATES_PER_SAVE_MAX` is the only save-time candidate variable the README documents.
- [ ] 5.4 Update `docs/embeddings.md`:
  - in the detection diagram, the FTS5 pass admits by rank AND `LEXICAL_CANDIDATE_FLOOR`;
  - replace the "lexical pass has no equivalent absolute threshold" paragraph so it distinguishes the forbidden raw-bm25 threshold from the floor on the reported overlap measure;
  - add the constant to the engine-constants table.
- [ ] 5.5 Search `docs/` for other descriptions of save-time candidate admission and align any that say the lexical channel is rank-only.
- [ ] 5.6 Commit: `docs: make save-time candidate thresholds in the README, docs and memory.save description match the code`.

## 6. Verification and delivery

- [ ] 6.1 Run `pnpm run typecheck`, `pnpm run lint` and `pnpm test`, all green.
- [ ] 6.2 Run `openspec validate add-save-time-lexical-floor --strict`, `node scripts/check-delta-freshness.mjs` and `node scripts/check-spec-crossrefs.mjs`, all green.
- [ ] 6.3 Local smoke against the dev server (`pnpm run dev`, following the `rembric-smoke-tests` skill). Through MCP `memory.save` in a throwaway project:
  - an unrelated save returns no `source: 'fts'` candidate;
  - a near-duplicate save returns its match.

  Record the result in `measurements/smoke.md`.

- [ ] 6.4 Confirm `git ls-files openspec/changes/add-save-time-lexical-floor/measurements` holds `sweep.txt`, `README.md`, `mutation.txt`, `save-latency.mjs`, `save-latency.txt` and `smoke.md`, and that no scratch path remains in the worktree.
- [ ] 6.5 Push and open the pull request: an English title and description, linking issue #453. This step is the user's decision.
