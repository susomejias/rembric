## Context

`findSaveTimeCandidates` (`packages/core/src/services/save-time-candidates.ts`) merges three channels:

- **Dense:** kNN over `memory_vec`, admitted at `VEC_THRESHOLD = 0.7`.
- **Lexical:** an FTS5 pool admitted by `LEXICAL_CANDIDATE_FLOOR = 0.6` (from `add-save-time-lexical-floor`).
- **Entity:** a shared rare entity.

Rows are deduplicated by target, ranked (entity first, then `similarity`), and the first `CANDIDATES_PER_SAVE_MAX` become pending `memory_relations` rows through `runPostSaveSteps` (`save-curation.ts`). That one function serves `memory.save`, `memory.capture_passive` and a `memory.merge` commit.

The maintainer's installation shows that most of those rows are not worth a judgment. Issue #467 reports, for the maintainer's own judged pairs, the share whose verdict was `supersedes` or `conflicts_with`. The bands are mutually exclusive and evaluated top to bottom:

| band                               | actionable share |
| ---------------------------------- | ---------------- |
| lexical containment ≥ 0.60         | 74%              |
| vector ≥ 0.85                      | 72%              |
| vector 0.80–0.85                   | 29%              |
| vector 0.75–0.80                   | 8%               |
| vector 0.70–0.75                   | 3%               |
| shared entity only (vector < 0.70) | 1%               |

Overall, about 9% of verdicts were actionable. The figures are aggregates computed locally by the maintainer. No private content or per-pair data enters this repository.

The maintainer chose the "moderate" policy:

- **Low:** dense-only pairs in `[0.70, 0.75)` without a shared entity, and entity-only pairs below `0.70`. They are reported as related and never judged.
- **High:** a cosine of at least `0.85`. It is judged, and the response also steers the agent to converge.
- **Middle:** every other admitted pair, judged as today.

## Goals / Non-Goals

**Goals:**

- Low-band pairs write no pending row, while the agent still sees them.
- High-band pairs keep their pending row and gain an explicit convergence steer.
- One exported pure function decides the band, so the drain step that follows in this chain can ask, for an existing pending row, whether the current rules would still create it.
- The three write paths report the bands identically.
- The existing floor calibration stays reproducible byte for byte.

**Non-Goals:**

- Changing existing pending rows. That is the drain change that follows in this chain, and it will call `classifyCandidateBand`.
- Changing the channels, `VEC_THRESHOLD`, `LEXICAL_CANDIDATE_FLOOR` or the ranking precedence.
- Changing `CANDIDATES_PER_SAVE_MAX`.
- Similarity-aware orphaning of pending rows.

## Decisions

### D1 — Classify by channel admission plus the exact cosine, in one pure function

```ts
classifyCandidateBand({ vecSimilarity: number | null, lexical: boolean, entity: boolean }): 'low' | 'middle' | 'high' | null
```

The function returns, evaluated in order:

1. `null` when no channel admits the pair. Dense admission means `vecSimilarity >= VEC_THRESHOLD`.
2. `high` when `vecSimilarity >= CANDIDATE_HIGH_BAND_FLOOR`.
3. `middle` when the lexical channel admitted the pair, or when the cosine is unknown.
4. For an entity pair: `middle` when the dense channel also admits it, otherwise `low`.
5. For a dense-only pair: `low` below `CANDIDATE_LOW_BAND_CEILING`, otherwise `middle`.

The `null` result exists for the drain step. A pair that no channel admits today is also one the current rules would not create.

Alternatives considered:

- **Classify on the reported `similarity`.** Rejected. That number is the dense cosine for a `vec` candidate, but token containment for `fts` and `entity` candidates, as `memory-entities` requires. The maintainer's rates are stated per channel and per cosine band. A function over the reported number would put a 0.72-containment entity pair and a 0.72-cosine dense pair in the same band.
- **Gate inside each channel** (for example, a second dense threshold). Rejected. Bands are a property of the merged pair, which may be admitted by several channels. Splitting the rule across pools leaves the drain step nothing to call.
- **Let the drain recompute the rule itself.** Rejected. Two copies of a threshold rule drift, which is the defect class `runPostSaveSteps` was extracted to end.

### D2 — An unknown cosine is middle

An entity-only pair whose target or source has no vector has no cosine. It stays **middle** and keeps its pending row.

Alternatives considered:

- **Treat an unknown cosine as low.** Rejected.
  - The cosine is missing exactly when inference is down or a row awaits the embedding drain. Those are the documented degraded modes.
  - The entity channel exists to surface contradictions that share an identifier but little vocabulary.
  - Silencing it whenever a vector is missing would trade a known 1% rate for an unknown one.
- **Infer the cosine from the kNN pool.** For example: a target absent from a full pool must sit below the pool's smallest cosine. Rejected.
  - The bound holds only if the vec0 kNN order equals cosine order, which depends on unit-normalised vectors.
  - It also holds only if the pool was saturated.
  - That is a proof resting on two incidental properties. A one-statement exact read is cheaper to trust (D3).

Consequences: in the lexical-only sweep arm, and in every test without vectors, the bands change nothing. The sweep test asserts this.

### D3 — Read the exact cosine for merged targets the dense pool did not return

The dense pool already holds the cosine of up to `CANDIDATE_POOL_SIZE` neighbours, including those below `VEC_THRESHOLD`. Most entity-only pairs sit far apart in embedding space and are therefore outside that pool. Without another read, the low-band entity rule would almost never fire.

`VectorsRepository.cosineDistances({ memoryId, scope, targetIds })` reads `vec_distance_cosine` for the named ids. It is filtered on the scope's partition key, so it is a scoped read under the data-access rules. It runs only when two conditions hold:

- the dense pool returned at least one row, so the saved memory has a vector and the scope holds others;
- at least one merged target still lacks a cosine.

It never runs in degraded mode and never runs in a scope without vectors.

Cost, measured on the statement in isolation and not end to end (`measurements/cosine-lookup-latency.txt`), with 40 target ids, which is the realistic upper bound (lexical pool plus entity pool):

| memories | `cosineDistances` p50 | `knnCandidates` p50 (reference) |
| -------- | --------------------- | ------------------------------- |
| 1 000    | 0.333 ms              | 0.309 ms                        |
| 20 000   | 0.599 ms              | 2.651 ms                        |

The reference series is the kNN read every save already performs, shown for scale. The two are separate instruments, not one series.

Alternatives considered:

- **No read.** Every target outside the pool keeps an unknown cosine and stays middle. Rejected, because the maintainer's entity rule would be inert for the pairs it targets.
- **Raise the dense pool size.** Rejected. It scans more vectors for every save, to learn about a handful of targets that are already known by id.

### D4 — Response shape: `related[]` and `convergeWith[]`

| field                | holds                                                                                                          | present                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `candidates[]`       | middle- and high-band pairs, each with a `judgmentId` and a pending row (unchanged shape)                      | as today                                                                                                                                  |
| `related[]`          | low-band pairs: the candidate shape without `judgmentId`, same ranked order, at most `CANDIDATES_PER_SAVE_MAX` | always on `memory.save` and on a `memory.merge` commit; on `memory.capture_passive` exactly when `candidates` is, that is, when non-empty |
| `convergeWith[]`     | target ids of the high-band entries of `candidates[]`                                                          | same rule as `related[]`                                                                                                                  |
| `judgmentRequired`   | `candidates.length > 0` (unchanged)                                                                            | as today                                                                                                                                  |
| `candidatesDetected` | middle- and high-band pairs ranked before the cap (D5)                                                         | as today                                                                                                                                  |

On `memory.capture_passive`, both arrays are concatenated across the learnings it saved, exactly as `candidates[]` is.

Alternatives considered:

- **A per-candidate `band` or `converge` field.** Rejected. The published `candidatesDetected` requirement states that "the per-candidate object SHALL NOT gain a field". A response-level list keeps that contract and the published candidate shape.
- **Keep low-band pairs in `candidates[]` without a `judgmentId`.** Rejected.
  - `candidates[]` means "close each with `memory.judge_batch`", and the output schema requires `judgmentId`.
  - An entry without one breaks both.
- **`convergeWith[]` as judgment ids.** Considered, because on `memory.capture_passive` a target id does not say which learning it pairs with. Rejected, because the actions it steers toward take memory ids: `memory.merge` takes `ids`, and `topic_key` reuse is read from the target. `memory.save`, the primary path, has exactly one source. The `memory.capture_passive` ambiguity matches its existing `candidates[]`, which carries no source id either.
- **A top-level boolean such as `convergeSuggested`.** Rejected. It cannot say which pair is meant, and the published requirement already rejects companion booleans beside a list.

The descriptions name both fields. To fit within `DESCRIPTION_MAX_LENGTH`, `memory.save` reclaims the following clauses. No requirement mandates them, and they are named here as the published description requirement asks:

- "and is often a real contradiction": the maintainer's data puts entity-only pairs at 1% actionable, so the clause was also untrue;
- "a short … label … — written as a scannable headline", reworded to "a ≤100-char scannable headline";
- "evolving" and "update is", in the `topic_key` sentence;
- "the previous active row in that slot is auto-superseded atomically", reworded to "the slot's previous active row is superseded atomically";
- "close each pending judgment", reworded to "judge each";
- "on how many memories resemble this one" and "trimmed the list", in the `candidatesDetected` sentence;
- "instead of judging many pairs";
- "stays reachable … and recordable", reworded to "is reachable …, recordable".

The registered description is 1868 characters, including the redaction note.

### D5 — Low-band pairs take no slot and are not counted

The cap is applied to the middle- and high-band list. `related[]` takes the first `CANDIDATES_PER_SAVE_MAX` low-band pairs of the same ranked order. `candidatesDetected` counts the middle- and high-band list before its cap.

Alternatives considered:

- **One shared budget** (cap the merged list, then split it). Rejected. Entity-sourced pairs lead the ranking (`memory-entities`), and entity-only pairs are 1% actionable. A shared budget would let them displace 72%-actionable high-band pairs, which is the composition defect `memory-entities` already records.
- **Count every admitted pair.** Rejected for two reasons:
  - `candidatesDetected > candidates.length` would stop meaning truncation.
  - The published advice to converge under one `topic_key` when the count far exceeds the list would fire on weak, related-only matches.
- **A separate `relatedDetected` count.** Rejected. No action depends on how many weak matches exist. The remainder is re-derivable with `memory.search` like any unsurfaced pair, and the description has no budget for a field nobody acts on.

### D6 — The high band keeps its pending row

This is the maintainer's decision: high-band pairs are 72% actionable, the highest rate after the lexical band. The pair stays a judgment, and the steer only adds the cheaper action.

Alternatives considered:

- **Auto-supersede.** Rejected. It violates the fresh-context judgment invariant: a verdict is source data that only the agent can produce.
- **Steer without a row.** Rejected by the maintainer. A missed steer would then lose a 72%-actionable pair silently.

### D7 — Constants, requirement placement and archive order

`CANDIDATE_LOW_BAND_CEILING = 0.75` and `CANDIDATE_HIGH_BAND_FLOOR = 0.85` are declared once, beside `VEC_THRESHOLD`. They are compile-time constants, never read from the environment, and never request parameters. The entity rule reuses `VEC_THRESHOLD` rather than adding a third constant equal to it.

`add-save-time-lexical-floor` already MODIFIES "Retrieval and lifecycle constants MUST be named and bounded in one place" and "Save-time lexical candidate scoring MUST increase with match quality". Two active changes modifying one requirement collide at archive. So this change:

- names its constants in its own ADDED requirement ("Save-time candidates MUST be classified into confidence bands by one shared function"), which carries the same obligations: named once, not operator-configurable, evidence on change;
- modifies only requirements the other change leaves alone: "`memory.save` MUST surface candidate conflicts at save-time", "Entity overlap MUST be a save-time conflict-detection channel", and "`memory.save` MUST report how many candidates its detection produced".

A later housekeeping change may fold the band constants into the constants requirement once both changes are archived.

**Archive order:** archive this change AFTER `add-save-time-lexical-floor`. Its code builds on that change's floor and shared curation path. Its ADDED `retrieval-evaluation` requirement extends the save-time sweep that the other change ADDs.

There is a second hazard with `lazy-embedding-load-identity-check`. That change REMOVES "Embeddings MUST be computed in-process by a model loaded at boot" and ADDS a "… loaded on first use" requirement. The MODIFIED block of "`memory.save` MUST surface candidate conflicts at save-time" quotes the published body verbatim, so it still cites the "at boot" title (`check-spec-crossrefs` flags this as an advisory). Whichever of the two changes archives second SHALL rebase on the published text and cite the surviving title.

### D8 — Calibration evidence and the sweep

The thresholds rest on the maintainer's private aggregates above, plus the committed synthetic fixture. The fixture demonstrates the mechanics; it does not measure rates.

The sweep gains a `related` labelled class: saves about the same subject as a base memory that neither duplicate nor contradict it. The ten saves were written so that each band rule is exercised, which is why the class demonstrates what the low band absorbs and is not evidence of how often it does.

The class lives in its own list, `SAVE_TIME_RELATED_SAVES`. The floor section of the sweep runs with the `bands` seam disabled, so it keeps measuring the floor alone, and its output is byte-identical to the committed `add-save-time-lexical-floor/measurements/sweep.txt`. A new section then runs the production arm at the shipped floor over the labelled saves followed by the related ones, twice:

- once with the seam disabled (the "before");
- once enabled (the "after").

It reports, per class:

- pending rows before and after;
- high, middle and related rows;
- where each expected target landed.

It also reports the queue depth per save, and the retrieval-corpus pending rows before and after.

Alternatives considered:

- **Append the related saves to `SAVE_TIME_SAVES`.** Rejected. It moves every queue-depth figure of the floor calibration, so the floor's committed evidence could no longer be reproduced.
- **Grid-search the band boundaries on the fixture.** Rejected. The fixture is written by hand and holds 37 saves; boundaries fitted to it would be fitted to its author. The maintainer's verdict rates are the calibration. The fixture shows the consequence.

## Risks / Trade-offs

- **[Risk] The low band hides a real conflict.** On the maintainer's data, 3% of dense pairs in `0.70–0.75` and 1% of entity-only pairs were actionable. → Mitigation:
  - `related[]` still shows every such pair to the agent, with its source and shared entity.
  - `memory.compare` can record a verdict on one.
  - The pair stays re-derivable with `memory.search`.
- **[Risk] The low-band ceiling sits close to a labelled contradiction in the fixture.** The fixture contradiction `c-cache` is admitted only by the dense channel, at a cosine of 0.751 with the compiled-in model. It stays middle by about 0.001; a ceiling of 0.76 would move it to related. → Mitigation: the ceiling is not tuned on the fixture (D8). The margin is recorded in the measurements so a future change to the ceiling or the model sees it.
- **[Risk] A model change shifts the cosine distribution, and the bands stop meaning what the rates measured.** → Mitigation: the band constants are calibrated for the compiled-in model, as `VEC_THRESHOLD` is. The ADDED requirement states that changing the model or a band constant requires re-running the band-composition sweep and fresh verdict-rate evidence.
- **[Trade-off] The high-band steer depends on the agent acting on it.** → Accepted because the pending row remains (D6). Nothing is lost when the steer is ignored.
- **[Trade-off] Middle-band entity pairs still lead the ranking and can fill the cap.** This covers pairs with an unknown cosine or a cosine of at least `VEC_THRESHOLD`. → Accepted. The low band removes the 1%-actionable entity-only pairs from the budget, which is most of the composition defect. Bounding the channel's share stays with `memory-entities`.
- **[Trade-off] The extra read.** It costs at most about 0.6 ms at 20 000 memories for 40 ids, and runs only when vectors exist (D3). → Accepted, because without it the entity rule is inert.
- **[Trade-off] The `memory.save` description has 32 characters of headroom left.** → Accepted, and recorded so the next change to that description plans its reclaim.

## Migration Plan

- No schema change, no migration and no stored-data change.
- Deploy is a normal server release.
- Rollback is reverting the commit. Low-band pairs then become pending candidates again, and the two response fields disappear.

## Open Questions

None blocking. These questions are for the maintainer:

1. Should `convergeWith[]` carry judgment ids instead of target ids, so that `memory.capture_passive` can say which learning a near-duplicate pairs with (D4)?
2. Is the fixture's 0.001 margin on `c-cache` a reason to revisit the 0.75 ceiling, or is the maintainer's 3% rate for that band the deciding evidence?
