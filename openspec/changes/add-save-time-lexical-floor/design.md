## Context

`findSaveTimeCandidates` (`packages/core/src/services/save-time-candidates.ts`) merges three channels:

- **Vector:** kNN over `memory_vec`, filtered at `VEC_THRESHOLD = 0.7`.
- **Lexical:** an FTS5 `MATCH` over up to 16 content terms, ordered by bm25 and limited to `CANDIDATE_POOL_SIZE = 20`. There is no other admission rule. Each row's reported `similarity` is `tokenContainment(tokenSet(saved.content), tokenSet(title + content))`: the share of the saved text's distinct terms that the candidate also contains, unweighted and in `[0,1]`.
- **Entity:** memories sharing an extracted identifier, gated only by entity rarity. These lead the merged list.

Rows are deduplicated by target id, ranked (entity first, then `similarity` descending), and the first `CANDIDATES_PER_SAVE_MAX` (default 5) become pending `memory_relations` rows.

Because the lexical channel admits by rank only, any row sharing one term with the saved text qualifies. A scope with more than five such rows therefore fills the budget on every save. Issue #453 reports exactly this: an unrelated save scored 0.17–0.25 on all five slots, while a near-duplicate control scored 0.93.

The published spec constrains the fix in two ways:

- `openspec/specs/memory/spec.md`, "Save-time lexical candidate scoring MUST increase with match quality", requires the reported lexical `similarity` to be a corpus-independent overlap measure. It forbids replacing it with the inverse-document-frequency weighting the search path uses, and forbids an absolute threshold over raw bm25.
- "Retrieval and lifecycle constants MUST be named and bounded in one place" requires every such constant to be named once, not operator-configurable, and backed by evidence when it changes.

## Goals / Non-Goals

**Goals:**

- An unrelated save over a heterogeneous corpus creates zero lexical-sourced pending judgments, while a near-duplicate still surfaces its match.
- The floor's value is reproducible from a committed sweep and is not chosen by hand.
- The queue depth per N saves is reported before and after under one named instrument.
- `memory.save` latency does not regress.
- The README, the `memory.save` description and the code agree on every threshold.

**Non-Goals (each a candidate follow-up change, in this order):**

1. **Save-time dedupe:** an identical save becomes a confirmation of the existing memory.
2. **Confidence bands and similarity-aware orphaning:** near-duplicates are steered to `topic_key`/`memory.merge`, low-similarity pairs are reported as related without a pending row, and low-similarity pendings orphan sooner. The two go together because both change the response shape and the pending lifecycle.
3. **Cluster merge suggestions** in the deterministic sweep.

Also out of scope:

- Any change to the vector or entity channels.
- Any change to `CANDIDATES_PER_SAVE_MAX`.
- Any change to pending rows that already exist.

## Decisions

### D1 — Floor the measure the channel already reports, unweighted

`LEXICAL_CANDIDATE_FLOOR` is compared against the `similarity` value the lexical channel already computes and reports. A row below it is not a candidate.

Alternatives considered:

- **Gate on the inverse-document-frequency-weighted coverage that search's relevance level uses** (`weightedCoverage`, `termWeightsFor`). Rejected for two reasons.
  - The published requirement contracts the save-time measure as corpus-independent and explicitly forbids that weighting.
  - The deeper reason is calibration transfer. The floor is calibrated on a small committed fixture and then applied to every deployment. A corpus-independent measure gives the same value for the same pair of texts in the fixture and in production, so the calibrated value carries over. A corpus-dependent measure does not: the same pair scores differently as a deployment's term statistics drift, so a value fitted on the fixture is uncalibrated everywhere else.
  - It would also add a per-save term-statistics read whose cost scales with the saved body's length. `memory.save` has no content-length bound, so that cost is unbounded.
- **Require at least two shared significant terms, with a stop-word list.** Rejected.
  - It needs a curated per-language list, and stored memories here are routinely English and Spanish.
  - The archived relevance-weighting design already recorded the preference for a mechanism "that needs no curated list".
  - A term count also cannot express proportion: two shared terms mean something different in a 5-term save than in a 500-term one.
- **Floor raw bm25.** Forbidden by the published requirement: bm25 magnitudes scale with corpus size, so no fixed threshold over it is stable.
- **Gate on the combined text overlap at merge time, across channels.** Rejected because it would also gate the entity channel (see D2).

A useful property of D1: `similarity` is always `>= 0`, so a floor of `0.0` reproduces today's behaviour exactly. The sweep's `0.0` grid point is therefore the "before" measurement, and rollback is setting the constant to `0.0`.

### D2 — Floor the lexical channel only

- **Vector channel:** already thresholded, and its threshold was calibrated separately. It is not part of this change.
- **Entity channel:** left without a text-overlap floor. `memory-entities` specifies that this channel exists to surface contradictions that share an identifier but "almost no vocabulary". It also records that the shared overlap measure is "near zero for exactly the pairs this channel exists to find". A floor on that measure would switch the channel off for its own purpose. Entity noise, if measured, belongs to the entity channel's composition follow-up that `memory-entities` already records.

### D3 — Filter before merge, so junk takes no slot and is not counted

The floor is applied while building the lexical pool, before deduplication, ranking and the cap.

- A below-floor row never displaces a real candidate.
- A target that both the vector channel (above 0.7) and the lexical channel (below the floor) find is still surfaced, through its vector entry.
- `candidatesDetected` keeps its contracted meaning ("distinct candidate pairs the detection ranked before the cap"). It is lower simply because fewer rows are candidates.

Alternative: filter after the cap. Rejected, because junk would keep occupying slots and the queue would still fill.

### D4 — Calibrate on a separate labelled save-time fixture, with two arms

The retrieval corpus cannot calibrate this floor:

- It carries no labelled duplicate or contradiction pairs.
- Its metrics observe the ranked search path, not save-time decisions.
- Adding pairs to it would move every retrieval baseline. The retrieval-evaluation spec also requires corpus changes and level-function changes to land separately.

A new fixture therefore lives beside the retrieval harness. It holds a heterogeneous base corpus of English and Spanish project facts and a labelled save sequence with four classes:

- **near-duplicate:** the same fact reworded or lightly edited;
- **expanded rewrite:** the same fact with substantially more text;
- **contradiction:** an incompatible statement about the same identifier, in different words;
- **unrelated:** a fact about something absent from the base corpus.

The sweep saves each labelled item through the production curation path (embedding, detection, pending-row creation, entity linking) into a throwaway database and records which pending rows were created, with their `source`.

**One implementation of the curation path.** Today that path exists twice:

- `runPostSaveSteps` in `packages/mcp/src/memory-tools.ts`;
- `saveThroughCuration`, a hand-copied variant in `packages/core/src/test-support/retrieval/ingest.ts`.

The harness is in `core` and cannot import from `mcp`, which depends on `core`. So the post-save steps move into a `core` service, built only from `core` pieces (`extractEntities`, `findSaveTimeCandidates`, `RelationsService.createPending`, `linkMemory`). `memory.save`, `memory.capture_passive` and `memory.merge` call it through the existing `saveMemoryWithCandidates` wrapper, and the retrieval ingest and the new sweep call it directly, so the copy is deleted. The move keeps behaviour identical, including best-effort failure handling. That is checked by the existing `memory.save` tests and by a retrieval-ratchet run, whose baselines are unaffected because ranking reads confirmations and metadata, never relation rows.

The sweep varies the floor through a `lexicalFloor` field on `CandidateOptions`, a test seam that is never read from the environment, alongside the existing `poolSize`. The shipped value is the named constant. It runs across a grid of floor values from `0.00` to `0.95`, in steps of at most `0.05`, in two arms:

- **lexical-only:** no embedder. This is the documented degraded mode when inference fails, and it isolates the channel under change.
- **production:** the compiled-in embedder.

Per grid point and arm it reports:

- labelled pairs surfaced, per class;
- pending rows created per unrelated save, split by `source`;
- total pending rows created over the N labelled saves. This is the queue-depth instrument, and the `0.00` point is the "before".

A value is admissible when all of the following hold:

1. **Lexical-only arm:** every labelled near-duplicate is surfaced.
2. **Production arm:** every labelled pair of every class is surfaced by some channel.
3. **Both arms:** unrelated saves create zero lexical-sourced pending rows.
4. The value sits in the interior of an admissible plateau at least `0.10` wide, which is the same plateau rule the published constants requirement already applies to search gates.

Expanded rewrites are reported for the lexical-only arm but are not gated there (see Risks).

As a secondary, non-gating series, the sweep also reports the pending rows created while ingesting the retrieval corpus, at `0.00` and at the chosen value. The value is the midpoint of the plateau, rounded to the grid.

Alternative: calibrate by hand from the issue's probe (around 0.5). Rejected. The issue itself calls that figure indicative only, and the constants requirement forbids an uncommitted calibration.

### D5 — Performance: no new read, and a stated budget on a named instrument

The floor is one comparison against a number the channel already computes. No SQL statement is added to the save path, and below-floor rows avoid a `createPending` insert, so the expected effect is neutral or faster. That expectation is not accepted without measurement:

- **Instrument:** end-to-end `saveMemoryWithCandidates` wall clock, measured with `performance.now()`.
  - The embedder is not wired, so inference is identical (absent) in both arms.
  - The corpus is built with `pnpm run corpus:build` at 1 000, 20 000 and 50 000 rows.
- **Arms:** `floor = 0.00` (today) and `floor = chosen`, interleaved in one process against one database, so cache and drift hit both equally.
- **Noise band:** taken as the p50 difference between two identical `0.00` arms.
- **Budget:** at every size, the added p50 SHALL be at or below that noise band.
- **Fallback, written before measuring:** the change adds no work, so a regression outside the noise band means either the implementation added work (fix it) or the instrument is faulty (re-measure). It is never shipped as an accepted cost.

The instrument is named in the header of every committed measurement file and is never tabulated with the sweep's queue-depth series.

### D6 — The description describes each channel truthfully

The `memory.save` description replaces "matches existing memories above the configured similarity threshold" with a statement that candidates come from similar wording, similar meaning, or a shared rare identifier such as a file path or URL. The last of these can surface a pair with little shared wording. Everything the published `candidatesDetected` requirement obliges the description to say is kept, and the text stays within `DESCRIPTION_MAX_LENGTH` (1900, including the redaction note).

### D7 — Remove the unread variables, do not wire them

`CANDIDATE_VEC_THRESHOLD` and `CANDIDATE_FTS_THRESHOLD` are removed from the README. The published requirement says the thresholds are compile-time constants "not environment-configurable", and that `CANDIDATES_PER_SAVE_MAX` is the only operator knob. Wiring them would contradict both.

### D8 — Leave existing pending rows alone

Pending rows that are already noise are not rewritten or bulk-orphaned by this change. The deterministic sweep orphans them at `JUDGMENT_ORPHAN_DEADLINE_MS` (journaled and undoable), and the operator can already bulk-orphan them from `/dashboard/judgments`.

Alternative: a one-off orphaning pass over below-floor pendings. Rejected. It would be a new journaled bulk mutation with its own review burden, delivering what the deadline already delivers within 14 days.

## Risks / Trade-offs

- **[Risk] With the embedder down, the floor drops a true near-duplicate whose wording diverged.** → Admissibility criterion 1 requires the lexical-only arm to surface every labelled near-duplicate. In normal operation the vector channel catches paraphrase.
- **[Risk] A long save that expands a short existing memory scores low.** Containment divides by the saved text's term count, so a 400-term rewrite of a 40-term memory has a containment of at most 0.10 and is dropped lexically. → The fixture labels this class separately and criterion 2 requires the production arm to surface it, normally through the vector channel. If the lexical-only arm loses it, that is recorded in the measurements as a known consequence, not hidden. Changing the measure's direction would change the published reported `similarity` and is a separate change.
- **[Risk] The fixture is not representative of real memories.** → The measure is corpus-independent, so the value transfers as long as text style is similar. The plateau rule rejects a value that holds only on a narrow band. The fixture deliberately mixes languages, lengths and memory types.
- **[Risk] Entity-channel noise remains.** → Accepted and out of scope (D2). The issue's measurement attributes the filled cap to the lexical channel alone.
- **[Trade-off] For the same corpus, saves return fewer `candidates[]` and a lower `candidatesDetected` than before.** → Accepted because it is the point of the change. No field, input or schema changes.
- **[Trade-off] Existing noise stays in the queue for up to 14 days.** → Accepted (D8).

## Migration Plan

- No schema change, no migration and no stored-data change.
- Deploy is a normal server release.
- Rollback is reverting the commit, or setting `LEXICAL_CANDIDATE_FLOOR = 0.0`, which reproduces today's behaviour exactly (D1).

## Open Questions

None blocking. The follow-ups listed under Non-Goals are separate changes.
