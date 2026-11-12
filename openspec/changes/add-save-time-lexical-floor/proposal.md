## Why

Every `memory.save` turns up to `CANDIDATES_PER_SAVE_MAX` (default 5) detected candidates into pending judgments, and the lexical channel admits a candidate by rank position alone, so one shared common word is enough. Issue #453 reports a probe in which a save unrelated to a 20-memory corpus produced 5 pending judgments, all with a reported `similarity` between 0.17 and 0.25, while a near-duplicate control matched at 0.93 and filled its other four slots with the same kind of noise. That is about five meaningless judgments per save, which buries the real conflicts the judgment queue exists to surface. The documentation also describes two threshold variables (`CANDIDATE_VEC_THRESHOLD`, `CANDIDATE_FTS_THRESHOLD`) that no code reads, and the `memory.save` description claims every candidate cleared "the configured similarity threshold", which is false for the lexical and entity channels.

## What Changes

- The lexical save-time channel gains a floor, `LEXICAL_CANDIDATE_FLOOR`, applied to the unweighted overlap measure it already computes and already reports as `similarity`. A lexical match below the floor is dropped before the channels are merged and ranked, so it takes no slot in the per-save budget, writes no pending row and is not counted in `candidatesDetected`. Admission becomes rank position within the pool AND the floor. The measure stays unweighted and corpus-independent.
- The floor's value is chosen by a new save-time calibration sweep and is not set by hand. The sweep runs the production save path over a committed, labelled fixture of near-duplicate, contradicting and unrelated saves. That fixture is separate from the retrieval corpus, so retrieval baselines do not move. The same sweep reports the queue depth (pending judgments created per N saves) before and after, under one named instrument.
- The vector channel (`VEC_THRESHOLD = 0.7`) and the entity channel (rarity-gated, no text-overlap floor) are unchanged. The entity channel exists to surface contradictions that share an identifier but little vocabulary, and a text-overlap floor would remove exactly those pairs.
- `CANDIDATES_PER_SAVE_MAX` is unchanged and remains the only operator knob over save-time surfacing.
- The save path gains no database read: the floor filters values that are already computed. A before/after measurement of `memory.save` latency at 1 000, 20 000 and 50 000 memories shows no regression beyond the instrument's noise.
- Documentation tells the truth: `CANDIDATE_VEC_THRESHOLD` and `CANDIDATE_FTS_THRESHOLD` are removed from the README, `docs/embeddings.md` describes the lexical floor, and the `memory.save` description stops claiming that every candidate cleared a similarity threshold.
- Pending judgments that already exist are left untouched. They age out through the existing deadline sweep, so no stored row changes.

Behaviour change, not marked **BREAKING**: a save can now return fewer `candidates[]` and a lower `candidatesDetected` than before for the same corpus. No field, input or schema changes, and no client update is needed.

Invariants touched:

- **Fresh-context judgment:** fewer, better-targeted candidates reach `memory.save.candidates[]`; `memory.judge_batch` itself is unchanged.
- **Append-only memory:** untouched. No stored row is updated, deleted or migrated.
- **Scope at the service layer:** untouched. The floor runs inside the existing scoped detection.
- **`topic_key` convergence:** untouched.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `memory`: "Save-time lexical candidate scoring MUST increase with match quality" now admits a lexical candidate by rank position AND a calibrated floor on its reported overlap measure. "Retrieval and lifecycle constants MUST be named and bounded in one place" names `LEXICAL_CANDIDATE_FLOOR`, corrects the `CANDIDATE_POOL_SIZE` entry (the pool is no longer the whole lexical admission rule) and states the evidence a change to the floor must carry. "Memory title MUST participate in both retrieval branches" rewords its one sentence that still described save-time admission as rank position alone.
- `mcp-api`: adds a requirement that the `memory.save` description describe save-time detection truthfully, channel by channel.
- `retrieval-evaluation`: adds a requirement for a reproducible save-time calibration sweep over a labelled fixture, reporting surfaced labelled pairs, noise from unrelated saves, and queue depth per N saves.

## Impact

- **Code:**
  - `packages/core/src/services/save-time-candidates.ts`: the new constant, the filter in the lexical pool, and a `lexicalFloor` test seam on `CandidateOptions`.
  - `packages/core/src/services/save-time-candidates.test.ts`: the regression test from the issue probe.
  - The post-save curation steps (`runPostSaveSteps`) move from `packages/mcp/src/memory-tools.ts` into a `core` service, so the server and the harness share one implementation. The copy in `packages/core/src/test-support/retrieval/ingest.ts` is deleted.
- **Harness:**
  - `packages/core/src/test-support/retrieval/`: a new save-time fixture and sweep module beside `ingest.ts` and `run-eval.ts`, plus a documented command for it in the root `package.json` next to `eval`.
- **MCP description:**
  - `packages/mcp/src/server.ts` (`SAVE_DESCRIPTION`), still within `DESCRIPTION_MAX_LENGTH`;
  - `apps/web/src/test/mcp-transport.test.ts`, the description assertions.
- **Docs:**
  - `README.md`: the configuration table rows for the two unread variables;
  - `docs/embeddings.md`: the detection diagram and the "lexical pass has no equivalent absolute threshold" paragraph.
- **Specs:**
  - `openspec/specs/memory/spec.md`;
  - `openspec/specs/mcp-api/spec.md`;
  - `openspec/specs/retrieval-evaluation/spec.md`.
- **Measurements:** committed under `openspec/changes/add-save-time-lexical-floor/measurements/`: the sweep grid, the queue depth before and after, and the save latency before and after.
- **No change to:** the database schema, migrations, stored data, MCP input schemas, plugins, the installer or dependencies.
