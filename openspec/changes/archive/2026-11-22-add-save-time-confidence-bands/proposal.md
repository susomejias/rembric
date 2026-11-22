## Why

Every admitted save-time candidate becomes a pending judgment, and most of them are not worth an agent's attention. On one real self-hosted installation, replayed read-only with the lexical floor of `add-save-time-lexical-floor` applied, a save wrote about 4.3 pending rows on average and 77% of saves filled the per-save cap. Only about 9% of that installation's past verdicts were `supersedes` or `conflicts_with` (issue #467). A single threshold cannot separate the two groups, but the share of actionable verdicts varies strongly by band, so the band can decide what a candidate costs the agent.

## What Changes

- Every candidate the existing detection admits is classified into one of three **confidence bands** by one exported pure function in `core`, `classifyCandidateBand`. The bands follow the maintainer's "moderate" policy:
  - **Low band.**
    - A pair admitted only by the dense channel with a cosine in `[0.70, 0.75)` and no shared entity.
    - A pair admitted only by a shared entity whose cosine is known and below `0.70`.
  - **High band.** A cosine of at least `0.85`, whatever else admitted the pair.
  - **Middle band.** Every other admitted pair, including an entity-only pair whose cosine is unknown because either memory has no vector.
- **Low band.** The pair writes no `memory_relations` row and receives no `judgmentId`. The save response reports it in a new `related[]` array: the candidate shape without `judgmentId`, in the same ranked order, bounded by the same `CANDIDATES_PER_SAVE_MAX`. A low-band pair takes no candidate slot.
- **High band.** The pair still writes a pending row and appears in `candidates[]`. Its `judgmentId` is also listed in a new `convergeWith[]` array. That array is an advisory steer toward converging the two memories with `memory.merge` or a `supersedes` verdict, reusing the target's `topic_key`. A judgment id names the pair, so it stays unambiguous across the learnings of one `memory.capture_passive`.
- **Middle band.** Unchanged: a pending row and a `candidates[]` entry.
- `candidatesDetected` counts only middle- and high-band pairs ranked before the cap, so `candidatesDetected > candidates.length` still means truncation and a high count still points at `topic_key` convergence. Low-band pairs are not counted.
- `judgmentRequired` keeps its meaning: `candidates.length > 0`.
- `memory.save`, a `memory.merge` commit and `memory.capture_passive` report the two new arrays with one meaning, because all three run `runPostSaveSteps`.
- The band thresholds are named once beside `VEC_THRESHOLD`: `CANDIDATE_LOW_BAND_CEILING = 0.75` and `CANDIDATE_HIGH_BAND_FLOOR = 0.85`. The entity rule reuses `VEC_THRESHOLD`. None is read from the environment.
- To know the cosine of a lexical or entity target that the dense kNN pool did not return, detection adds one scoped read by id (`VectorsRepository.cosineDistances`). The read runs only when the dense pool returned rows and some merged target lacks a cosine.
- The save-time sweep (`pnpm run eval:save-time`) gains a band-composition section with a labelled `related` class. The existing floor-calibration output stays byte-identical.
- The `memory.save` and `memory.capture_passive` descriptions name `related[]` and `convergeWith[]`.

Behaviour change, not marked **BREAKING**:

- `memory.save`, `memory.capture_passive` and a `memory.merge` commit gain two response fields.
- For the same corpus, a save can return fewer `candidates[]`, a lower `candidatesDetected` and fewer pending rows than before.
- No input schema changes. A client that ignores unknown fields needs no update.

Invariants touched:

- **Fresh-context judgment:** fewer pairs reach `candidates[]`. Those that do are the bands with an actionable rate high enough to justify a judgment. `memory.judge_batch` is unchanged.
- **Append-only memory:** untouched. Existing pending rows are not changed; draining them is a separate change in this chain.
- **Scope at the service layer:** the new read takes the `Scope` and filters on its partition key.
- **`topic_key` convergence:** `convergeWith[]` points at it. Its mechanics are unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `memory`:
  - MODIFIED "`memory.save` MUST surface candidate conflicts at save-time": only middle- and high-band pairs are candidates, and low-band pairs are reported as related.
  - ADDED "Save-time candidates MUST be classified into confidence bands by one shared function": the bands, the missing-cosine rule, the two constants and their evidence.
- `memory-entities`: MODIFIED "Entity overlap MUST be a save-time conflict-detection channel": an entity-only pair whose cosine is known and below `VEC_THRESHOLD` is surfaced as related rather than judged.
- `mcp-api`:
  - MODIFIED "`memory.save` MUST report how many candidates its detection produced": the count excludes low-band pairs.
  - ADDED "Save responses MUST report low-band pairs as `related[]` and high-band candidates in `convergeWith[]`": the shape across the three write paths and the description obligations.
- `retrieval-evaluation`: ADDED "The save-time sweep MUST report candidate band composition".

## Impact

- **Code:**
  - `packages/core/src/services/save-time-candidates.ts`: the band constants, `classifyCandidateBand`, per-target channel signals, the band split before the cap, and a `bands` test seam on `CandidateOptions`;
  - `packages/core/src/services/save-curation.ts`: `related` and `convergeWith` on `PostSaveResult`, plus the `RelatedMemoryView` type;
  - `packages/db/src/repositories/vectors-repository.ts`: `cosineDistances`;
  - `packages/mcp/src/memory-tools.ts`: the output schemas of `memory.save` and `memory.merge`, and the response assembly;
  - `packages/mcp/src/observability-tools.ts`: the `memory.capture_passive` output schema and aggregation;
  - `packages/mcp/src/server.ts`: the `memory.save` and `memory.capture_passive` descriptions.
- **Tests:**
  - `packages/core/src/services/save-time-candidate-bands.test.ts` (new);
  - `packages/db/src/repositories/vectors-repository.test.ts`;
  - `packages/mcp/src/memory-tools.test.ts`;
  - `packages/mcp/src/observability-tools.test.ts`;
  - `packages/core/src/test-support/retrieval/save-time-sweep.test.ts`;
  - `apps/web/src/test/mcp-transport.test.ts`.
- **Harness:**
  - `packages/core/src/test-support/retrieval/save-time-fixture.ts`: the `related` class;
  - `save-time-sweep.ts` and `run-save-time-sweep.ts`: band composition;
  - `ingest.ts`: passes the seam through.
- **Docs:** `docs/relations.md`, `docs/embeddings.md`.
- **Specs:**
  - `openspec/specs/memory/spec.md`;
  - `openspec/specs/memory-entities/spec.md`;
  - `openspec/specs/mcp-api/spec.md`;
  - `openspec/specs/retrieval-evaluation/spec.md`.
- **Measurements:** `openspec/changes/add-save-time-confidence-bands/measurements/`.
- **No change to:** the database schema, migrations, stored data, MCP input schemas, plugins, the installer or dependencies.
- **Archive order:** archive after `add-save-time-lexical-floor` (see design D7).
