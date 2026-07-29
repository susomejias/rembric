## MODIFIED Requirements

### Requirement: `memory.save` MUST surface candidate conflicts at save-time

After a `memory.save` inserts the new row, the server SHALL run a candidate-detection step over rows in the same `(scope, project_id)`, excluding the newly inserted row and any rows already linked to it via `replaces`. The detection SHALL combine FTS5 lexical neighbors (always), vec kNN neighbors (when the just-saved row has an embedding), and entity-overlap neighbors (see `memory-entities`'s save-time conflict-detection requirement — gated by a rarity threshold so a common entity contributes nothing), apply the internal similarity thresholds (compile-time constants, calibrated for the compiled-in model — not environment-configurable), deduplicate by target id, rank the merged list by the precedence the `memory-entities` capability defines (entity-sourced candidates lead, then the reported `similarity` descending), and return up to `CANDIDATES_PER_SAVE_MAX` (default 5) candidates.

Each detection channel SHALL scan a bounded pool before that ranking is applied, sized by a single named constant (`CANDIDATE_POOL_SIZE`, see "Retrieval and lifecycle constants MUST be named and bounded in one place"). The pool bound is therefore UPSTREAM of the cap: the merged, ranked list is itself bounded, and no scope-wide count of related memories is available at save time. Consequently the count the response reports (see the `mcp-api` capability, "`memory.save` MUST report how many candidates its detection produced") SHALL be specified as a LOWER BOUND on how many memories in scope resemble the saved row, and SHALL NOT be specified as a total. A count that happens to be exact — which it is whenever the scope holds fewer comparable rows than the pool bound — SHALL NOT be relied upon as exact, because that exactness is a property of corpus size and not of the count.

The lexical pass SHALL build its FTS5 `MATCH` expression with the SAME Unicode-aware builder used by interactive `memory.search` (see the `mcp-api` hybrid-retrieval contract): it SHALL keep whole Unicode word tokens and SHALL NOT split a token at a non-ASCII character nor drop tokens that are entirely non-ASCII (accented or CJK text), and it SHALL apply a bounded term cap so a long save body cannot build an unbounded `MATCH` expression. Consequently, save-time candidate detection SHALL NOT silently degrade to vector-only for non-ASCII content: a non-ASCII memory body SHALL produce a non-empty `MATCH` expression and SHALL be eligible to surface `source: 'fts'` candidates. The lexical pass SHALL still skip only when the builder yields no usable tokens at all.

The detection SHALL additionally exclude any target id that was already judged `relation = 'not_conflict'` against the new memory's `replaces` ancestry — i.e. against any of the predecessor ids in the new row's `replaces[]` (the chain the new save supersedes). This suppresses the re-surfacing of a pair the agent already dismissed as a false positive on an earlier save of the same evolving topic. Because `memory_relations` has no topic column and each save mints a fresh `source_id`, the dismissal SHALL be carried forward by walking the `replaces` chain, NOT by the new row's own id (which no prior relation references). Only `not_conflict` SHALL be suppressed; other judged relations (notably `conflicts_with`) SHALL continue to surface so an unresolved contradiction re-confronts the agent on the next save.

For each candidate surfaced, a `memory_relations` row SHALL be inserted with `status = 'pending'`, `source_id = <new row>`, `target_id = <candidate>`, and a generated `judgment_id`.

Candidates that were detected but fall outside `CANDIDATES_PER_SAVE_MAX` SHALL NOT be recorded: no `memory_relations` row, no `judgment_id`, no journal entry. This is not an information loss, and the requirement states why so that a future change does not "fix" it by recording them.

A candidate pair is DERIVED: its two endpoints and its `similarity` are a function of `memory.title` and `memory.content` — immutable under "Memories MUST be append-only" — together with recipes pinned in the shipped image behind version markers (the FTS5 tokenizer, the entity extractor behind `EXTRACTOR_VERSION`, and the embedding identity behind `EMBEDDING_INPUT_VERSION` and the pinned model constants, per "Embeddings MUST be computed in-process by a model loaded at boot" and "Stale vectors MUST be re-embedded after a model change"). It therefore satisfies the same test the `persistence` capability applies to its own derived tables (`memory_fts`, `memory_vec`, `memory_replaces`, and the entity tables, which that capability requires to be "declared derived, never primary"): dropping it loses nothing that cannot be recomputed from rows still in the database. An agent's VERDICT on a pair is the opposite — SOURCE data, recomputable by nothing — which is precisely what earns a row.

Dropping a candidate therefore discards a prompt, not a fact, and the prompt is re-derivable at any time from the surviving inputs via `memory.search` over the memory's own text (lexical and dense channels) and `memory.search` with an `entity` filter (entity channel).

That re-derivability SHALL be specified as re-derivability and NOT as reproducibility. A re-derived candidate set is the CURRENT one, not the save-time one: rows created since the save are included, `superseded` and `archived` rows are absent, and a change to the pinned embedding recipe changes the vectors. Nor is it identical in shape: `memory.search` is a fused ranked read that returns memories, not pairs carrying `judgment_id`s, so recording a verdict on a re-derived pair is `memory.compare`. No requirement SHALL claim that a dropped candidate can be reconstructed as it stood at save time.

#### Scenario: A save finds two strong candidates

- **GIVEN** two existing active memories M1 and M2 in the same scope each exceed the internal vec threshold against the just-saved row N
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

- **GIVEN** `CANDIDATES_PER_SAVE_MAX = 5` and 12 candidates exceed the thresholds
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
- **THEN** every candidate's `(scope, project_id)` SHALL match `project:'A'`; rows in other projects or in global SHALL NOT be considered, regardless of similarity

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

### Requirement: Retrieval and lifecycle constants MUST be named and bounded in one place

Ranking, projection and lifecycle behaviour is governed by a set of compile-time constants that no requirement previously named, which made each one invisible to review and free to drift. None SHALL be operator-configurable or exposed as a per-request tunable, and each SHALL be declared once, as a named constant, in the module that owns the behaviour:

- `RANK_WINDOW_MARGIN` — the over-fetch added to `limit + offset` before the floor and ceiling are applied, so a page near a window edge still fuses over more candidates than it returns.
- `RANK_WINDOW_CEILING` — the hard cap on that window, set strictly above the maximum `limit`. It doubles as the entity path's page size when no `limit` is given (see `mcp-api`), so exact-address retrieval is complete-within-a-bound rather than truncated to a ranked default.
- `RELATIVE_LEVEL_RATIO` — the relative-filter ratio applied against the fused pool's highest relevance level. Named for what it measures; it is not a consecutive-pair gap ratio and SHALL NOT be described as one.
- `RELEVANCE_LIMIT` — the cap on `memory.context`'s relevance channel, shared by its entity pre-pass and its ranked pass.
- `CANDIDATE_POOL_SIZE` — the per-channel pool each save-time candidate channel scans BEFORE the merged list is ranked and capped. It is the bound that makes the reported detected count a lower bound rather than a total, and for the lexical channel it IS the admission rule (see "Save-time lexical candidate scoring MUST increase with match quality"), so exposing it as configuration would make an admission rule operator-settable. It is applied per channel, and the entity channel applies it once per extracted entity, so the merged pool — and therefore the detected count — MAY exceed it.
- `ENTITY_RARITY_THRESHOLD` — the maximum share of a scope's active memories an entity may be linked to before it stops proposing save-time candidates. A proportion, not an absolute count, so it does not become inert as a corpus grows.
- `ENTITIES_PROJECTION_CAP` — the per-memory bound on the `entities[]` projection, whose exhaustion is reported to the caller.
- `PREDECESSOR_CAP` — the bound on the supersedes-chain walk.
- `ESCALATION_MULTIPLIER` — the multiple of its own TTL a memory sits `needs_review` before `reviewEscalated` derives true.
- `REBUILD_MAX_BATCHES` — the bound on one operator-triggered derived-index rebuild pass, so the rebuild cannot become an unbounded blocking loop.

Three gates ship disabled (`null`): the abstention floor and `RELATIVE_LEVEL_RATIO` (see "Recall MUST be able to return nothing"), and the per-session `DIVERSITY_CAP`. Their disabled state is not itself the contract — an uncalibrated gate silently removes recall, so what is contracted is the evidence a commit must carry to enable one.

Enabling the abstention floor or `RELATIVE_LEVEL_RATIO` SHALL require, in the same change:

1. a committed sweep across a grid of candidate values, produced by the evaluation harness rather than asserted;
2. an over-abstention rate of zero at every committed `k` — no query with a gold answer returns nothing;
3. an abstention false-positive rate at or below its committed cap;
4. precision, recall and MRR at or above their committed floors at every committed `k`;
5. the chosen value in the interior of a plateau at least two grid steps wide on each of the criteria above, so a value that holds at exactly one grid point is rejected as a cliff edge rather than accepted as a calibration.

Enabling `DIVERSITY_CAP` SHALL additionally require a session-labelled evaluation fixture, because it is applied to the whole fused pool before the page is sliced — a held-back row is replaced by whatever ranked next in a 64–400 row pool rather than by a comparable row, which on a single-topic session measurably swaps most of page 1 for noise — and the current corpus cannot see that regression, every corpus row carrying a null session id, which is never grouped.

#### Scenario: A constant is not reachable as a request parameter

- **WHEN** any MCP tool input schema is inspected
- **THEN** none of the constants above SHALL be settable per request

#### Scenario: The candidate pool size is not operator-configurable

- **WHEN** the environment schema is inspected
- **THEN** `CANDIDATE_POOL_SIZE` SHALL NOT be readable from the environment, and `CANDIDATES_PER_SAVE_MAX` SHALL remain the only operator knob over save-time candidate surfacing

#### Scenario: A disabled gate stays disabled without a calibration

- **WHEN** the abstention floor, `RELATIVE_LEVEL_RATIO`, or the diversity cap is enabled
- **THEN** the change SHALL be accompanied by a measurement on the evaluation harness, and for the diversity cap by a session-labelled fixture the harness can see the regression through

#### Scenario: A gate is enabled without a committed sweep

- **WHEN** a change sets the abstention floor or `RELATIVE_LEVEL_RATIO` to a non-null value without a committed harness sweep across a grid of candidate values
- **THEN** the change SHALL be rejected

#### Scenario: A candidate value that costs recall is rejected

- **GIVEN** a swept candidate value at which any query with a gold answer returns nothing
- **WHEN** that value is proposed for the abstention floor
- **THEN** it SHALL be rejected regardless of its abstention false-positive rate

#### Scenario: A candidate value that holds at only one grid point is rejected

- **GIVEN** a swept candidate value that meets every criterion at its own grid point and fails at both adjacent grid points
- **WHEN** that value is proposed
- **THEN** it SHALL be rejected as a cliff edge, and the gate SHALL remain disabled

#### Scenario: Re-enabling the diversity cap without a session-labelled fixture

- **WHEN** `DIVERSITY_CAP` is set to a non-null value while every row in the evaluation corpus carries a null session id
- **THEN** the change SHALL be rejected, because the harness cannot observe the regression the cap causes
