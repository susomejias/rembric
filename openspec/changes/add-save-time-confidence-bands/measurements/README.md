# Measurements — save-time confidence bands

Every figure here comes from a committed script run against the committed code. The thresholds are not calibrated here. `CANDIDATE_LOW_BAND_CEILING = 0.75` and `CANDIDATE_HIGH_BAND_FLOOR = 0.85` rest on two sources:

- **The maintainer's private aggregates (issue #467).** These are the share of judged pairs per band whose verdict was `supersedes` or `conflicts_with`:
  - lexical ≥ 0.60: 74%;
  - vector ≥ 0.85: 72%;
  - vector 0.80–0.85: 29%;
  - vector 0.75–0.80: 8%;
  - vector 0.70–0.75: 3%;
  - shared entity only, below 0.70: 1%;
  - about 9% overall.
- **The synthetic fixture below.** It shows the consequence on known pairs; it does not measure how often a band occurs.

No private content or per-pair data was used.

## Files

| file                                 | instrument                                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `sweep-before.txt`                   | `pnpm run eval:save-time` on the parent commit. It is byte-identical to `add-save-time-lexical-floor/measurements/sweep.txt`. |
| `sweep-after.txt`                    | the same command on this change. Lines 1–55 are byte-identical to `sweep-before.txt`; the band section is appended.           |
| `mutation.txt`                       | `scripts/mutate.mjs`: one case per guarded condition, with the tests each case turned red.                                    |
| `cosine-lookup-latency.mts` / `.txt` | wall clock of the new `VectorsRepository.cosineDistances` statement, measured in isolation (not end to end).                  |

## Test-first evidence

The RED runs were taken on the unchanged code, before any implementation.

- **`save-time-candidate-bands.test.ts`: 14 of 14 failed.**
  - The five `classifyCandidateBand` tests failed with `TypeError: classifyCandidateBand is not a function`.
  - The curation-path tests failed on their assertions. For example, a low-band pair was still returned in `candidates`: `expected [ { …(7) } ] to deeply equal []`. Another failure was `related` being `undefined`.
  - The read-recording test then named the method `cosineSimilarities`. It was renamed to the final `cosineDistances` before GREEN.
- **The MCP handler tests: 4 of 4 failed.**
  - The low-band target was still a candidate: `expected [ id, …(1) ] to deeply equal [ id ]`.
  - `related` was `undefined`.

The test that an entity target outside the dense pool is classified by its exact cosine (`poolSize: 1`) was added after GREEN. Its guard is covered by the mutation check below: replacing the read's condition with `if (false)` turns it red.

## Sweep: before and after

The instrument counts pending rows written, plus related rows returned, by the production curation path (`runPostSaveSteps`). The run uses floor 0.60, a per-save cap of 5, the compiled-in model `onnx-community/gte-multilingual-base`, and 37 saves: the 27 labelled saves of the floor calibration, then 10 `related` saves. "Off" means the `bands` test seam is disabled, so every admitted pair is pending, which matches the code before this change.

| class            | saves | pending off | pending on | high | middle | related (low) | expected target: high / middle / low / missed |
| ---------------- | ----- | ----------- | ---------- | ---- | ------ | ------------- | --------------------------------------------- |
| near-duplicate   | 8     | 8           | 8          | 8    | 0      | 0             | 8 / 0 / 0 / 0                                 |
| expanded-rewrite | 4     | 4           | 4          | 2    | 2      | 0             | 2 / 2 / 0 / 0                                 |
| contradiction    | 5     | 6           | 6          | 2    | 4      | 0             | 2 / 3 / 0 / 0                                 |
| related          | 10    | 18          | 8          | 1    | 7      | 10            | 1 / 2 / 6 / 1                                 |
| unrelated        | 10    | 0           | 0          | 0    | 0      | 0             | —                                             |

Queue depth (pending rows over the 37 saves):

| bands | total | per save |
| ----- | ----- | -------- |
| off   | 36    | 0.97     |
| on    | 26    | 0.70     |

While ingesting the retrieval corpus at floor 0.60, pending rows went from 54 with the bands off to 16 with them on.

Readings:

- **No labelled near-duplicate, expanded rewrite or contradiction lost its pending row.** All 17 expected targets landed in the high or middle band.
- **The low band absorbed only related-class pairs.** It took 10 of the 18 pending rows those saves wrote before. Six of their ten expected targets moved to `related[]`:
  - two entity-only pairs below 0.70 (`r-session-owner`, `r-session-lint`);
  - four dense-only pairs in 0.70–0.75.
- **Two of the ten related saves stayed judged.** `r-webhook-replay` (dense 0.80) and `r-reconnect-shard` (entity plus dense 0.77) are middle.
- **One related save landed in the high band.** `r-reconnect-helper` (entity plus dense 0.89) is a related, non-conflicting save that the steer would wrongly call a near-duplicate. Its pending row survives, so the agent can still judge it `related`. This is the cost of a high band that keeps its row (design D6).
- **One related save was not surfaced at all.** `r-cache-metrics` has a cosine of 0.66 and no shared entity, so no channel admits it.
- **The ceiling margin.** The fixture contradiction `c-cache` is admitted only by the dense channel, at a cosine of 0.751. It is middle by about 0.001; a ceiling of 0.76 would move it to `related[]`. The fixture does not calibrate the ceiling, but the margin is recorded here for any future change to the ceiling or the model.

The related saves were written to exercise each band rule. Their composition is illustrative, not a rate.

Without an embedder, every cosine is unknown and the bands change nothing. `save-time-sweep.test.ts` asserts this for the whole fixture.

## Cosine read latency (statement level)

The instrument is `performance.now()` around one `cosineDistances` call with 40 target ids (the realistic upper bound: lexical pool plus entity pool), over 400 rounds after 20 warm-up rounds, on random unit vectors. The `knnCandidates` series is a separately labelled reference: the dense read every save already performs.

| memories | `cosineDistances` p50 / p95 | `knnCandidates` p50 / p95 (reference) |
| -------- | --------------------------- | ------------------------------------- |
| 1 000    | 0.333 / 0.376 ms            | 0.309 / 0.343 ms                      |
| 20 000   | 0.599 / 0.673 ms            | 2.651 / 2.720 ms                      |

The read runs only when the dense pool returned rows and a merged target lacks a cosine. It never runs without vectors, which a recording-proxy test asserts. These are isolated statement timings. They are not an end-to-end `memory.save` latency, and they are not tabulated with the sweep.

## Mutation check

Every case turned at least one named test red (`mutation.txt`). Each case below shows the condition changed and the mutation applied.

**`save-time-candidates.ts`:**

| condition                                                               | mutation                          |
| ----------------------------------------------------------------------- | --------------------------------- |
| `vec < CANDIDATE_LOW_BAND_CEILING`                                      | `<=`                              |
| `CANDIDATE_LOW_BAND_CEILING = 0.75`                                     | `0.7` (the low band vanishes)     |
| `vec >= CANDIDATE_HIGH_BAND_FLOOR`                                      | `>`                               |
| `CANDIDATE_HIGH_BAND_FLOOR = 0.85`                                      | `0.95`                            |
| entity rule `dense ? 'middle' : 'low'`                                  | always `'low'`                    |
| `vec >= VEC_THRESHOLD` (dense admission)                                | `>`                               |
| `lexical \|\| vec === null` (the unknown-cosine rule)                   | `vec === null` dropped            |
| `lexical \|\| vec === null` (the lexical rule)                          | `lexical` dropped                 |
| the no-band return                                                      | removed                           |
| no pending row for the low band (`judged = all.filter(band !== 'low')`) | `judged = all`                    |
| a low-band pair takes no slot                                           | cap applied before the band split |
| `detected: judged.length`                                               | `all.length`                      |
| the `related` bound                                                     | `.slice(0, perSaveMax)` removed   |
| the cosine-read guard                                                   | `if (false)`                      |
| the cosine-read guard                                                   | `vecRows.length > 0` dropped      |
| the `bands` seam                                                        | ignored                           |

**`save-curation.ts`:**

| condition                             | mutation               |
| ------------------------------------- | ---------------------- |
| `convergeWith` only for the high band | every candidate pushed |
| `related` assignment                  | removed                |

**`vectors-repository.ts`:** the partition-key filter of `cosineDistances` was removed.

**MCP wiring:**

| file                     | condition                  | mutation    |
| ------------------------ | -------------------------- | ----------- |
| `memory-tools.ts`        | `related`                  | always `[]` |
| `memory-tools.ts`        | `convergeWith`             | always `[]` |
| `observability-tools.ts` | `related` aggregation      | removed     |
| `observability-tools.ts` | `convergeWith` aggregation | removed     |

## Retrieval eval

`pnpm eval` passed, with `rembric retrieval eval passed.`:

| run    | P@8   | R@8   | MRR@8 |
| ------ | ----- | ----- | ----- |
| hybrid | 0.212 | 0.975 | 0.900 |

Ranking reads no relation rows, so the bands cannot move it.

## Spec validation

- **`openspec validate add-save-time-confidence-bands --strict`:** `Change 'add-save-time-confidence-bands' is valid`.
- **`node scripts/check-delta-freshness.mjs`:** `ok (19 active change(s), 33 body difference(s) to review)`. This change's four differences are deliberate rewrites:
  - the detection paragraph and the row paragraph of "`memory.save` MUST surface candidate conflicts at save-time";
  - the `candidatesDetected` definition;
  - the composition paragraph of "Entity overlap MUST be a save-time conflict-detection channel".

  The rest belong to other active changes.

- **`node scripts/check-spec-crossrefs.mjs`:** `ok (105 citation(s) across 29 published capabilities, 1 item(s) to review)`. The review item is the verbatim published citation of "Embeddings MUST be computed in-process by a model loaded at boot", which `lazy-embedding-load-identity-check` removes. The archive-order note is in design D7.
