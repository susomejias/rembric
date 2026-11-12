## MODIFIED Requirements

### Requirement: `memory.save` MUST surface candidate conflicts at save-time

After a `memory.save` inserts the new row, the server SHALL run a candidate-detection step over rows in the same `(scope, project_id)`, excluding the newly inserted row and any rows already linked to it via `replaces`. The detection SHALL combine FTS5 lexical neighbors (always), vec kNN neighbors (when the just-saved row has an embedding), and entity-overlap neighbors (see `memory-entities`'s save-time conflict-detection requirement, which owns the gate: an entity common enough to occupy the whole per-save budget contributes nothing, while one linked to fewer memories than that budget holds is not gated at all), apply the internal similarity thresholds (compile-time constants, calibrated for the compiled-in model — not environment-configurable), deduplicate by target id, rank the merged list by the precedence the `memory-entities` capability defines (entity-sourced candidates lead, then the reported `similarity` descending), classify every ranked pair into a confidence band (see "Save-time candidates MUST be classified into confidence bands by one shared function"), and return up to `CANDIDATES_PER_SAVE_MAX` (default 5) candidates from the middle and high bands, in that ranked order.

A low-band pair SHALL NOT be a candidate. It SHALL be returned separately as a related memory (see the `mcp-api` capability, "Save responses MUST report low-band pairs as `related[]` and high-band candidates in `convergeWith[]`"): at most `CANDIDATES_PER_SAVE_MAX` of them, in the same ranked order. A low-band pair SHALL NOT occupy a candidate slot, so it can never displace a middle- or high-band pair from the list.

Each detection channel SHALL scan a bounded pool before that ranking is applied, sized by a single named constant (`CANDIDATE_POOL_SIZE`, see "Retrieval and lifecycle constants MUST be named and bounded in one place"). The pool bound is therefore UPSTREAM of the cap: the merged, ranked list is itself bounded, and no scope-wide count of related memories is available at save time. Consequently the count the response reports (see the `mcp-api` capability, "`memory.save` MUST report how many candidates its detection produced") SHALL be specified as a LOWER BOUND on how many memories in scope resemble the saved row, and SHALL NOT be specified as a total. A count that happens to be exact — which it is whenever the scope holds fewer comparable rows than the pool bound — SHALL NOT be relied upon as exact, because that exactness is a property of corpus size and not of the count.

The lexical pass SHALL build its FTS5 `MATCH` expression with the SAME Unicode-aware builder used by interactive `memory.search` (see the `mcp-api` hybrid-retrieval contract): it SHALL keep whole Unicode word tokens and SHALL NOT split a token at a non-ASCII character nor drop tokens that are entirely non-ASCII (accented or CJK text), and it SHALL apply a bounded term cap so a long save body cannot build an unbounded `MATCH` expression. Consequently, save-time candidate detection SHALL NOT silently degrade to vector-only for non-ASCII content: a non-ASCII memory body SHALL produce a non-empty `MATCH` expression and SHALL be eligible to surface `source: 'fts'` candidates. The lexical pass SHALL still skip only when the builder yields no usable tokens at all.

The detection SHALL additionally exclude any target id that was already judged `relation = 'not_conflict'` against the new memory's `replaces` ancestry. That ancestry is the TRANSITIVE closure of `replaces[]`, bounded by its own constant — see "Dismissal suppression MUST bound its ancestry walk with its own named constant", which owns the depth, the order and the bound. It is NOT the array's own elements: `replaces[]` alone is one hop, and one hop loses a dismissal made two or more saves back on the same topic, which is the case this suppression exists for. This suppresses the re-surfacing of a pair the agent already dismissed as a false positive on an earlier save of the same evolving topic. Because `memory_relations` has no topic column and each save mints a fresh `source_id`, the dismissal SHALL be carried forward by walking that ancestry, NOT by the new row's own id (which no prior relation references). Only `not_conflict` SHALL be suppressed; other judged relations (notably `conflicts_with`) SHALL continue to surface so an unresolved contradiction re-confronts the agent on the next save.

For each candidate surfaced, a `memory_relations` row SHALL be inserted with `status = 'pending'`, `source_id = <new row>`, `target_id = <candidate>`, and a generated `judgment_id`. A low-band pair returned as a related memory SHALL NOT be recorded: no `memory_relations` row, no `judgment_id`, no journal entry. It is the same derived prompt the next paragraphs describe, so not recording it loses nothing.

Candidates that were detected but fall outside `CANDIDATES_PER_SAVE_MAX` SHALL NOT be recorded: no `memory_relations` row, no `judgment_id`, no journal entry. This is not an information loss, and the requirement states why so that a future change does not "fix" it by recording them.

A candidate pair is DERIVED: its two endpoints and its `similarity` are a function of `memory.title` and `memory.content` — immutable under "Memories MUST be append-only" — together with recipes pinned in the shipped image behind version markers (the FTS5 tokenizer, the entity extractor behind `EXTRACTOR_VERSION`, and the embedding identity behind `EMBEDDING_INPUT_VERSION` and the pinned model constants, per "Embeddings MUST be computed in-process by a model loaded at boot" and "Stale vectors MUST be re-embedded after a model change"). It therefore satisfies the same test the `persistence` capability applies to its own derived tables (`memory_fts`, `memory_vec`, `memory_replaces`, and the entity tables, which that capability requires to be "declared derived, never primary"): dropping it loses nothing that cannot be recomputed from rows still in the database. An agent's VERDICT on a pair is the opposite — SOURCE data, recomputable by nothing — which is precisely what earns a row.

Dropping a candidate therefore discards a prompt, not a fact, and the prompt is re-derivable at any time from the surviving inputs via `memory.search` over the memory's own text (lexical and dense channels) and `memory.search` with an `entity` filter (entity channel).

That re-derivability SHALL be specified as re-derivability and NOT as reproducibility. A re-derived candidate set is the CURRENT one, not the save-time one: rows created since the save are included, `superseded` and `archived` rows are absent, and a change to the pinned embedding recipe changes the vectors. Nor is it identical in shape: `memory.search` is a fused ranked read that returns memories, not pairs carrying `judgment_id`s, so recording a verdict on a re-derived pair is `memory.compare`. No requirement SHALL claim that a dropped candidate can be reconstructed as it stood at save time.

#### Scenario: A save finds two strong candidates

- **GIVEN** two existing active memories M1 and M2 in the same scope each reach the middle or high band against the just-saved row N (for example a dense cosine of at least `CANDIDATE_LOW_BAND_CEILING`)
- **WHEN** `memory.save({...})` returns
- **THEN** the response SHALL include `candidates: [{ judgmentId, targetId: M1, snippet, similarity, source }, { judgmentId, targetId: M2, ... }]` and `judgmentRequired: true`; two `memory_relations` rows SHALL exist with `status = 'pending'`

#### Scenario: A save finds zero candidates

- **WHEN** no existing memory exceeds the thresholds
- **THEN** the response SHALL include `candidates: []` and `judgmentRequired: false`; no `memory_relations` rows SHALL be inserted

#### Scenario: The just-saved row has no embedding

- **GIVEN** the inline embedding of the just-saved row failed (logged, drain will retry)
- **WHEN** `memory.save` runs candidate detection
- **THEN** only FTS5-derived candidates SHALL be considered; each candidate in the response SHALL carry `source: 'fts'`

#### Scenario: Candidate count exceeds the cap

- **GIVEN** `CANDIDATES_PER_SAVE_MAX = 5` and 12 middle- or high-band candidates exceed the thresholds
- **WHEN** `memory.save` returns
- **THEN** the response SHALL include the top 5 by the ranking precedence above; the remaining 7 SHALL NOT have `memory_relations` rows inserted and SHALL NOT surface to the agent; and the response SHALL report the detected count so the truncation is not silent

#### Scenario: The number of pending rows equals the number of surfaced candidates

- **GIVEN** a save whose detection ranked more candidates than `CANDIDATES_PER_SAVE_MAX`
- **WHEN** the save completes
- **THEN** the number of `memory_relations` rows inserted for that save SHALL equal the length of the returned `candidates[]`, and SHALL NOT equal the reported detected count

#### Scenario: The detected count is taken before the cap, not after

- **GIVEN** a save whose detection ranked 12 candidates with `CANDIDATES_PER_SAVE_MAX = 5`
- **WHEN** the save completes
- **THEN** the reported detected count SHALL be 12, and the returned `candidates[]` SHALL hold 5 entries which SHALL be the first 5 of that same ranked order

#### Scenario: A topic-key save's superseded predecessor is neither surfaced nor counted

- **GIVEN** a save carrying a `topic_key` that supersedes a previously-active row P in the same slot
- **WHEN** candidate detection runs for the new row
- **THEN** P SHALL NOT appear in `candidates[]` and SHALL NOT be included in the reported detected count, because P is in the new row's `replaces[]` and is therefore excluded from every channel's pool

#### Scenario: Candidate detection respects scope

- **GIVEN** the just-saved row is in scope `project:'A'`
- **WHEN** candidate detection runs
- **THEN** every candidate's `project_id` SHALL match `'A'`; rows in any other project SHALL NOT be considered, regardless of similarity

#### Scenario: The detected count respects scope

- **GIVEN** memories in another project that would resemble the just-saved row
- **WHEN** candidate detection runs for a row in scope `project:'A'`
- **THEN** the reported detected count SHALL count only pairs whose target lies in `project:'A'`

#### Scenario: A previously dismissed `not_conflict` pair is not re-surfaced

- **GIVEN** an earlier memory M0 (with `topic_key = 'arch/auth'`) for which the agent judged a candidate target X as `relation = 'not_conflict'`
- **AND** a new save N for the same topic whose `replaces[]` includes M0 (so M0 is N's predecessor)
- **WHEN** `memory.save` runs candidate detection for N and X would otherwise exceed the similarity thresholds
- **THEN** X SHALL NOT appear in N's `candidates[]` and NO new pending `memory_relations` row SHALL be inserted for the `(N, X)` pair

#### Scenario: A previously judged `conflicts_with` pair still surfaces

- **GIVEN** an earlier memory M0 for which the agent judged a candidate target Y as `relation = 'conflicts_with'`
- **AND** a new save N for the same topic whose `replaces[]` includes M0
- **WHEN** `memory.save` runs candidate detection for N and Y exceeds the similarity thresholds
- **THEN** Y SHALL still appear in N's `candidates[]` with a fresh pending `memory_relations` row — only `not_conflict` dismissals are suppressed, not unresolved conflicts

#### Scenario: Suppression keys on the ancestry, not the new id

- **GIVEN** a target X dismissed as `not_conflict` only against M0, and a new save N whose `replaces[]` does NOT include M0 (an unrelated save)
- **WHEN** `memory.save` runs candidate detection for N and X exceeds the thresholds
- **THEN** X SHALL still surface for N — the suppression follows the `replaces` ancestry, so a save that does not inherit M0's chain is unaffected by M0's prior dismissal

#### Scenario: A non-ASCII save participates in the lexical pass

- **GIVEN** an existing active memory whose content is non-ASCII (e.g. CJK or accented text) in scope `project:'A'`, and a just-saved row N in the same scope whose content lexically overlaps it
- **WHEN** `memory.save` runs candidate detection
- **THEN** the FTS5 `MATCH` expression built from N's content SHALL be non-empty (it SHALL NOT degrade to skipping the lexical pass), and the overlapping memory SHALL be eligible to surface as a `source: 'fts'` candidate when it clears the FTS threshold

#### Scenario: A dropped candidate is re-derivable but not reproducible

- **GIVEN** a save whose detection ranked more candidates than the cap, and a later session that wants the pairs which were not surfaced
- **WHEN** the agent re-derives them by calling `memory.search` with the memory's own text and with an `entity` filter
- **THEN** the pairs SHALL be reachable, and the re-derived set SHALL reflect the CURRENT corpus — including memories saved after the original save and excluding rows now `superseded` or `archived` — rather than the set that existed at save time

#### Scenario: A low-band pair is reported as related and not recorded

- **GIVEN** an existing active memory M admitted only by the dense channel against the just-saved row N, at a cosine of 0.72, sharing no entity with N
- **WHEN** `memory.save` returns
- **THEN** M SHALL NOT appear in `candidates[]`, SHALL appear in the related memories without a `judgmentId`, and no `memory_relations` row SHALL exist for `(N, M)`

#### Scenario: A low-band pair takes no candidate slot

- **GIVEN** `CANDIDATES_PER_SAVE_MAX = 1`, an entity-only pair L whose cosine is known and below `VEC_THRESHOLD`, which leads the ranking, and a middle-band pair M
- **WHEN** `memory.save` returns
- **THEN** `candidates[]` SHALL hold M, the related memories SHALL hold L, and the reported detected count SHALL be 1

## ADDED Requirements

### Requirement: Save-time candidates MUST be classified into confidence bands by one shared function

Every pair the save-time detection admits SHALL be classified into exactly one confidence band, and the band SHALL decide what the pair costs the agent. Admission is unchanged (see "`memory.save` MUST surface candidate conflicts at save-time"). The classification SHALL use three signals per pair:

- whether the dense channel admits it, that is, whether its cosine is at least `VEC_THRESHOLD`;
- whether the lexical channel admitted it (pool rank and `LEXICAL_CANDIDATE_FLOOR`);
- whether it shares a rare entity with the saved memory.

It SHALL also use the pair's cosine itself. The bands are:

- **High:** a cosine of at least `CANDIDATE_HIGH_BAND_FLOOR = 0.85`, whichever channels admitted the pair. A high-band pair SHALL remain a candidate with a pending `memory_relations` row. The response SHALL additionally steer the agent toward converging the two memories (see the `mcp-api` capability).
- **Low:** either of the following, but in neither case a pair the lexical channel admitted:
  - a pair admitted only by the dense channel, sharing no entity, with a cosine below `CANDIDATE_LOW_BAND_CEILING = 0.75`;
  - a pair admitted only by a shared entity whose cosine is known and below `VEC_THRESHOLD`.

  A low-band pair SHALL NOT receive a pending row.
- **Middle:** every other admitted pair. A middle-band pair SHALL remain a candidate with a pending row, unchanged.

The cosine SHALL be the exact cosine between the two memories' vectors whenever both have one. It SHALL be taken from the dense pool when the pool returned the target, and otherwise read by id within the saved memory's scope. That read SHALL NOT run when the dense pool returned nothing, because then no target can have a known cosine. When either memory has no vector, the cosine SHALL be treated as unknown, and an entity-only pair with an unknown cosine SHALL be **middle**. A missing vector means inference is degraded or a row awaits the embedding drain. In that state the entity channel's purpose (contradictions that share an identifier but little vocabulary) still applies, and a missing value SHALL NOT be read as a low one.

The classification SHALL be ONE exported pure function in `core`, `classifyCandidateBand`, taking those signals and returning the band, or no band when no channel admits the pair. The save path SHALL call it. Any other component that decides whether the current rules would create a pending row for a pair SHALL call the same function and SHALL NOT restate its thresholds; the drain of stale pending rows is the first such component.

`CANDIDATE_LOW_BAND_CEILING` and `CANDIDATE_HIGH_BAND_FLOOR` SHALL be declared once, beside `VEC_THRESHOLD`. They SHALL be compile-time constants, calibrated for the compiled-in model like `VEC_THRESHOLD`. They SHALL NOT be read from the environment and SHALL NOT be reachable as a request parameter. The entity rule SHALL reuse `VEC_THRESHOLD` rather than introduce a third constant of equal value.

The values rest on two sources of evidence:

- the share of actionable verdicts (`supersedes` or `conflicts_with`) per band, as aggregated from one real installation's judged pairs and reported in issue #467;
- the committed save-time sweep's band composition (see the `retrieval-evaluation` capability), which demonstrates the consequence on a synthetic fixture but does not calibrate the values.

A change to either constant, or to the compiled-in embedding model, SHALL carry a re-run of that sweep and fresh per-band verdict-rate evidence.

#### Scenario: A dense-only pair below the low-band ceiling is low

- **WHEN** a pair admitted only by the dense channel, sharing no entity, has a cosine at least `VEC_THRESHOLD` and below `CANDIDATE_LOW_BAND_CEILING`
- **THEN** it SHALL be classified low, and SHALL NOT receive a pending row

#### Scenario: The low-band ceiling itself is middle

- **WHEN** a dense-only pair has a cosine exactly `CANDIDATE_LOW_BAND_CEILING`
- **THEN** it SHALL be classified middle

#### Scenario: The high-band floor itself is high, and keeps its row

- **WHEN** a pair has a cosine exactly `CANDIDATE_HIGH_BAND_FLOOR`
- **THEN** it SHALL be classified high, SHALL receive a pending row, and the response SHALL name its target among the convergence suggestions

#### Scenario: An entity-only pair below `VEC_THRESHOLD` is low

- **WHEN** a pair admitted only by a shared entity has a known cosine below `VEC_THRESHOLD`
- **THEN** it SHALL be classified low, and SHALL still be reported with its entity source and shared value

#### Scenario: An entity pair the dense channel also admits is middle

- **WHEN** a pair shares an entity and has a cosine of exactly `VEC_THRESHOLD`
- **THEN** it SHALL be classified middle

#### Scenario: A missing vector keeps an entity-only pair middle

- **GIVEN** a target with no vector, sharing a rare entity with a just-saved memory that has one
- **WHEN** detection runs
- **THEN** the pair SHALL be classified middle and SHALL receive a pending row

#### Scenario: A lexically admitted pair is never low

- **WHEN** the lexical channel admitted a pair, whatever its cosine below `CANDIDATE_HIGH_BAND_FLOOR` and whether or not it shares an entity
- **THEN** it SHALL be classified middle

#### Scenario: An entity target outside the dense pool is classified by its exact cosine

- **GIVEN** a dense pool already filled by nearer neighbours, and an entity-only target outside it whose cosine is below `VEC_THRESHOLD`
- **WHEN** detection runs
- **THEN** the target's cosine SHALL be read by id within scope, and the pair SHALL be classified low

#### Scenario: Without vectors the bands add no read

- **WHEN** detection runs for a saved memory in a scope where the dense pool returns nothing
- **THEN** no cosine read by id SHALL be issued, and every admitted pair SHALL be classified middle

#### Scenario: A pair no channel admits has no band

- **WHEN** a pair has a cosine below `VEC_THRESHOLD` or none, is not lexically admitted, and shares no entity
- **THEN** `classifyCandidateBand` SHALL return no band
