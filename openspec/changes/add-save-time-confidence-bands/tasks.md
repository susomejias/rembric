## 1. Classification and the scoped cosine read

- [x] 1.1 RED: `packages/core/src/services/save-time-candidate-bands.test.ts`. It asserts, one test per rule:
  - every band boundary: the low-band ceiling, the high-band floor, and `VEC_THRESHOLD` in the entity rule;
  - an unknown cosine stays middle;
  - lexical admission is never low;
  - a pair no channel admits has no band;
  - through `runPostSaveSteps`: a low band writes no row and appears in `related`, a high band writes a row and appears in `convergeWith`, a middle band is unchanged, a missing vector stays middle, a low band takes no slot and is not counted, and `related` is bounded.

  Observe every test fail on the unchanged code: 14 failures, kept in `measurements/README.md`.

- [x] 1.2 Add `VectorsRepository.cosineDistances({ memoryId, scope, targetIds })`, filtered on the scope's partition key, with tests in `vectors-repository.test.ts` for the in-scope, missing-vector, other-project and no-query-vector cases.
- [x] 1.3 GREEN:
  - declare `CANDIDATE_LOW_BAND_CEILING` and `CANDIDATE_HIGH_BAND_FLOOR` beside `VEC_THRESHOLD`;
  - export `classifyCandidateBand`;
  - track per-target channel signals in `findSaveTimeCandidates`;
  - look up missing cosines only when the dense pool returned rows;
  - apply the cap to the middle and high bands, and bound `related` separately;
  - add the `bands` test seam to `CandidateOptions`, never read from the environment.
- [x] 1.4 `runPostSaveSteps` returns `related` and `convergeWith`, and `RelatedMemoryView` is exported.
- [x] 1.5 Add a test that an entity target outside the dense pool (`poolSize: 1`) is classified by its exact cosine. It guards the read.

## 2. Response shape across the three write paths

- [x] 2.1 RED, handler level:
  - `memory-tools.test.ts`: `memory.save` and a `memory.merge` commit;
  - `observability-tools.test.ts`: `memory.capture_passive`, which omits empty arrays like `candidates`.

  Observe 4 failures.

- [x] 2.2 GREEN: declare `related` and `convergeWith` in the output schemas of `memory.save`, `memory.merge` and `memory.capture_passive`, and assemble them from one helper in `memory-tools.ts`.
- [x] 2.3 Rewrite the `memory.save` description within `DESCRIPTION_MAX_LENGTH`, naming the reclaimed clauses in design D4, and extend the `memory.capture_passive` description. In `apps/web/src/test/mcp-transport.test.ts`:
  - update the pinned length to 1868;
  - assert the new substrings and the absence of "often a real contradiction";
  - assert that a merge commit carries both arrays.

## 3. Sweep

- [x] 3.1 Add the `related` class in its own list, `SAVE_TIME_RELATED_SAVES`, so the floor's saves are unchanged.
- [x] 3.2 In the sweep:
  - run the floor section with the bands seam disabled, and confirm its output matches `add-save-time-lexical-floor/measurements/sweep.txt` byte for byte;
  - append the band section: both runs, per-class bands, target bands, queue depth and the retrieval-corpus series.
- [x] 3.3 In `save-time-sweep.test.ts`:
  - assert that without an embedder the bands change no pending row;
  - add a unit test of `summarizeBands`;
  - check that every related save names an existing base memory.
- [x] 3.4 Commit the sweep before and after as `measurements/sweep-before.txt` and `measurements/sweep-after.txt`.

## 4. Evidence

- [x] 4.1 Run a mutation check (`scripts/mutate.mjs`) on each band boundary and constant, the unknown-cosine rule, the lexical rule, the no-band rule, the "no pending row for low band" filter, the slot rule, the count, the `related` bound, the cosine-read guard, the partition filter and the MCP wiring. Every case must turn at least one test red. Outputs are in `measurements/mutation.txt`.
- [x] 4.2 Measure the cosine read at the statement level: `measurements/cosine-lookup-latency.mts` and `.txt`.
- [x] 4.3 Confirm `pnpm eval` passes.

## 5. Documentation and validation

- [x] 5.1 `docs/relations.md` and `docs/embeddings.md` describe the bands, `related[]` and `convergeWith[]`.
- [x] 5.2 Run `openspec validate add-save-time-confidence-bands --strict`, `node scripts/check-delta-freshness.mjs` and `node scripts/check-spec-crossrefs.mjs`, and record the results in `measurements/README.md`.
- [x] 5.3 `pnpm run typecheck`, `pnpm run lint` and the full `pnpm test` are green after a fresh `pnpm --filter @rembric/web build`.

## 6. Follow-up: `convergeWith[]` carries judgment ids

- [x] 6.1 RED: in the core, `memory.save`, `memory.merge` and `memory.capture_passive` tests, expect `convergeWith` to hold the high-band candidate's `judgmentId`. Add a `memory.capture_passive` test where two learnings near one memory get two distinct ids. Observe 5 failures; the new test fails because target ids repeat.
- [x] 6.2 GREEN: `runPostSaveSteps` pushes `row.judgmentId`, and the sweep maps a judgment id back to its candidate. Re-run the sweep; `sweep-after.txt` is unchanged.
- [x] 6.3 Change the `mcp-api` and `memory` deltas, the proposal, the design (D4, D6, Risks, Open Questions), `docs/relations.md` and `docs/embeddings.md` to say "judgment ids" and "advisory".
- [x] 6.4 The description states "holds judgmentIds of candidates likely restating this fact (advisory)". It is now 1891 characters, and the pinned length and substring in `mcp-transport.test.ts` are updated.
- [x] 6.5 Run the mutation check on the wiring: target id substituted for judgment id, the high-band condition removed, and the MCP and capture aggregation. Every case is caught (`measurements/mutation.txt`, follow-up section).
