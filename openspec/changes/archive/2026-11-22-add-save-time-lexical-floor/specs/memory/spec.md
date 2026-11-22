## MODIFIED Requirements

### Requirement: Save-time lexical candidate scoring MUST increase with match quality

FTS5's bm25 score is negative and unbounded, and a better match is _more_ negative. Any similarity derived from it SHALL be monotonically **increasing** in match quality, and SHALL be bounded to `[0, 1]` so that the value reported to the agent as `similarity` is truthful against its documented range and comparable with the cosine similarity produced by the dense detector.

Because bm25 magnitudes scale with corpus size and term IDF, the system SHALL NOT gate lexical candidates on an absolute threshold over the raw bm25 value: no such threshold is stable across corpus sizes. Admission SHALL instead be by rank position within the already-correctly-ordered candidate pool AND by a floor, `LEXICAL_CANDIDATE_FLOOR`, over the reported `similarity`, which SHALL be computed as a corpus-independent lexical overlap measure between the saved text and the candidate. Rank position alone admitted any row sharing a single term with the saved text, so a scope holding more such rows than the per-save budget filled that budget on every save with pairs whose overlap was near zero.

That overlap measure SHALL remain UNWEIGHTED, and SHALL NOT be replaced by the inverse-document-frequency weighting the search path's relevance level uses (see "Recall MUST be able to return nothing"). The two serve different contracts: `similarity` is reported to the agent as a number in a documented range and is required above to be corpus-independent, while the level exists to be thresholded and is required to be corpus-dependent. The two paths SHALL nonetheless share ONE tokenisation, so they cannot disagree about what a token is.

Corpus independence is also what makes the floor calibratable. The floor's value is chosen on a committed fixture (see the `retrieval-evaluation` capability, "The harness MUST provide a reproducible save-time calibration sweep for the lexical candidate floor") and applied to every deployment. A pair of texts scores the same overlap in the fixture and in production, so the calibrated value carries over; a corpus-dependent measure would leave a fixture-fitted value uncalibrated everywhere else.

The floor SHALL be applied while the lexical pool is built, BEFORE candidates are deduplicated by target, ranked and capped by `CANDIDATES_PER_SAVE_MAX`. A lexical row below the floor SHALL NOT be a candidate: it SHALL occupy no slot in the per-save budget, SHALL write no `memory_relations` row, and SHALL NOT be counted in `candidatesDetected`. A target the lexical channel finds below the floor SHALL still be surfaced when another channel admits it, carrying that channel's `source`.

The floor SHALL apply to the lexical channel ONLY. The dense channel keeps its own threshold, and the entity channel's admission rule is its rarity gate (see `memory-entities`). The entity channel exists for pairs whose overlap measure is near zero, so a floor on that measure SHALL NOT be applied to it.

The floor SHALL be compared against the overlap measure the lexical channel already computes for each pool row, and SHALL NOT add a database read to the save path. Because that measure is never negative, a floor of `0` reproduces rank-only admission exactly.

#### Scenario: A byte-identical duplicate is surfaced lexically

- **GIVEN** a scope containing at least fifty active memories, and a newly saved memory whose text is byte-identical to one of them, with no embedding available
- **WHEN** save-time candidate detection runs
- **THEN** the identical memory SHALL be surfaced as a candidate with `source: 'fts'`
- **AND** its reported `similarity` SHALL be 1.0

#### Scenario: A near-zero-IDF match is not reported as identical

- **GIVEN** a scope in which a term appears in nearly every memory
- **WHEN** a save shares only that term with an otherwise unrelated memory
- **THEN** that memory SHALL NOT be reported with a `similarity` near 1.0
- **AND** it SHALL NOT displace a genuinely similar candidate from the per-save candidate budget

#### Scenario: Lexical detection does not go silent as the corpus grows

- **GIVEN** the same duplicate-save scenario evaluated at corpus sizes of 50, 150 and 300 active memories
- **WHEN** save-time candidate detection runs at each size
- **THEN** the identical memory SHALL be surfaced at every size

#### Scenario: Save-time similarity does not move with the corpus

- **GIVEN** one saved text and one candidate memory, evaluated in two scopes whose other memories differ entirely
- **WHEN** save-time candidate detection runs in each
- **THEN** the reported `similarity` SHALL be identical in both, unaffected by how common the shared terms are in either corpus

#### Scenario: An unrelated save creates no lexical candidates

- **GIVEN** a scope of at least twenty active memories about unrelated project facts, and no embedding available
- **WHEN** a memory is saved whose text shares only common words with every memory in the scope
- **THEN** no candidate SHALL carry `source: 'fts'`, and no `memory_relations` row SHALL be written for a lexical match

#### Scenario: A near-duplicate is still surfaced lexically

- **GIVEN** the same scope, and no embedding available
- **WHEN** a memory is saved that restates one of its memories in lightly edited words
- **THEN** that memory SHALL be surfaced as a candidate with `source: 'fts'` and a `similarity` at or above `LEXICAL_CANDIDATE_FLOOR`

#### Scenario: A below-floor lexical match takes no slot

- **GIVEN** a scope in which more rows than the per-save budget each share one term with the saved text, and one row restates it
- **WHEN** save-time candidate detection runs with no embedding available
- **THEN** the restating row SHALL be surfaced, no row below the floor SHALL be surfaced, and `candidatesDetected` SHALL count only rows at or above the floor

#### Scenario: A pair below the lexical floor is still surfaced by the dense channel

- **GIVEN** an existing memory whose overlap with the saved text is below `LEXICAL_CANDIDATE_FLOOR` and whose cosine similarity with it is at or above the dense threshold
- **WHEN** save-time candidate detection runs
- **THEN** that memory SHALL be surfaced with `source: 'vec'`

#### Scenario: The lexical floor does not gate the entity channel

- **GIVEN** an existing memory that shares a rare extracted identifier with the saved text and whose overlap with it is below `LEXICAL_CANDIDATE_FLOOR`
- **WHEN** save-time candidate detection runs
- **THEN** that memory SHALL be surfaced with `source: 'entity'`

#### Scenario: The floor adds no read to the save path

- **WHEN** save-time candidate detection runs for the same save with `LEXICAL_CANDIDATE_FLOOR` at its shipped value and at `0`
- **THEN** both runs SHALL issue the same repository reads, and differ only in which lexical rows are admitted

### Requirement: Retrieval and lifecycle constants MUST be named and bounded in one place

Ranking, projection and lifecycle behaviour is governed by a set of compile-time constants that no requirement previously named, which made each one invisible to review and free to drift. None SHALL be operator-configurable or exposed as a per-request tunable, and each SHALL be declared once, as a named constant, in the module that owns the behaviour:

- `RANK_WINDOW_MARGIN` — the over-fetch added to `limit + offset` before the floor and ceiling are applied, so a page near a window edge still fuses over more candidates than it returns.
- `RANK_WINDOW_CEILING` — the hard cap on that window, set strictly above the maximum `limit`. It doubles as the entity path's page size when no `limit` is given (see `mcp-api`), so exact-address retrieval is complete-within-a-bound rather than truncated to a ranked default.
- `RELATIVE_LEVEL_RATIO` — the relative-filter ratio applied against the fused pool's highest relevance level. Named for what it measures; it is not a consecutive-pair gap ratio and SHALL NOT be described as one.
- `RELEVANCE_LIMIT` — the cap on `memory.context`'s relevance channel, shared by its entity pre-pass and its ranked pass.
- `CANDIDATE_POOL_SIZE` — the per-channel pool each save-time candidate channel scans BEFORE the merged list is ranked and capped. It is the bound that makes the reported detected count a lower bound rather than a total, and for the lexical channel it is half of the admission rule, together with `LEXICAL_CANDIDATE_FLOOR` (see "Save-time lexical candidate scoring MUST increase with match quality"), so exposing it as configuration would make an admission rule operator-settable. It is applied per channel, and the entity channel applies it once per extracted entity, so the merged pool — and therefore the detected count — MAY exceed it.
- `ENTITY_RARITY_THRESHOLD` — the share of a scope's active memories above which an entity stops proposing save-time candidates. It is a proportion rather than an absolute count so the BLOCKING decision does not become inert as a corpus grows, and it SHALL be consulted only once the entity's active link count reaches `ENTITY_RARITY_MIN_LINKS` below. It SHALL NOT be described as bounding candidate COMPOSITION at every corpus size: a fixed proportion admits a link count that rises with the active population while the per-save budget does not, so above an active count of the budget divided by this threshold a single admitted entity may still fill every slot (see `memory-entities`).
- `ENTITY_RARITY_MIN_LINKS` — the active link count below which the rarity gate above does not apply at all, so an entity linked to fewer active memories than the per-save budget holds is admitted whatever its proportion. Derived ONCE from `CANDIDATES_PER_SAVE_MAX`'s default and NOT read from that setting at request time: such an entity cannot occupy the budget by itself — though several separately-exempt entities from one save can, which `memory-entities` records — while following the operator's value would make an admission rule environment-settable and, at a value of zero, would invert the gate into one that always applies.
- `LEXICAL_CANDIDATE_FLOOR` — the minimum unweighted overlap measure a lexical save-time candidate must report to be admitted, applied before the merged list is ranked and capped. It is the other half of the lexical admission rule, beside `CANDIDATE_POOL_SIZE`. Its value is carried by a committed save-time calibration sweep (see below) and SHALL NOT be chosen by hand.
- `ENTITIES_PROJECTION_CAP` — the per-memory bound on the `entities[]` projection. The reads behind it carry no `LIMIT`, so the complete per-memory count is in hand where the bound is applied and SHALL be reported as a count rather than as an indication that the bound was hit. Unlike `CANDIDATE_POOL_SIZE` above there is no pool upstream of it, so that count is exact and MAY carry a `Total` suffix. It SHALL be applied to a fair-shared order rather than an arbitrary one (see `mcp-api`), so that what the bound withholds is a stated consequence of the memory's entity composition rather than an accident of kind naming — a bound over an arbitrary order cannot be reviewed, because what it costs is unknowable. Changing its value SHALL therefore be argued against a measured distribution of entities per memory, produced by running the shipped extractor over production-shaped content, not against the returned array's length.
- `PREDECESSOR_CAP` — the bound on `memory.get`'s predecessor PROJECTION, and nothing else. Its value is a token budget for that one response, so no other consumer of the `replaces` ancestry SHALL borrow it: a decision to show more or fewer predecessors would otherwise silently change unrelated behaviour elsewhere.
- `DISMISSAL_ANCESTRY_CAP` — how far back along the `replaces` ancestry a `not_conflict` dismissal is carried forward when save-time candidates are suppressed. A suppression-reach decision, not a payload decision, and SHALL be declared separately from `PREDECESSOR_CAP` even while the two hold the same value.
- `ESCALATION_MULTIPLIER` — the multiple of its own TTL a memory sits `needs_review` before `reviewEscalated` derives true.
- `REBUILD_MAX_BATCHES` — the bound on one operator-triggered derived-index rebuild pass, so the rebuild cannot become an unbounded blocking loop.
- `ANNOTATION_REASON_CHARS` — the character bound applied to a judged annotation's `reason` on the multi-row annotation surfaces. It bounds a READ PROJECTION only: the stored `reason` and its input cap are untouched, and the single-memory deep read projects the value verbatim (see the `mcp-api` capability, "Relation annotation reasons MUST be bounded on multi-row reads").
- `RELATION_ANNOTATION_RESPONSE_BUDGET` — the maximum number of annotations one multi-row response may project, bounding `row count × per-row annotation bound`. It SHALL be derived from shipped default behaviour so that no request relying on defaults can be rejected by it — and that derivation SHALL use the LARGEST row count any branch serves for an omitted `limit`, not the `limit` maximum. The entity branch's page size when no `limit` is given exceeds the `limit` maximum, so deriving from the latter leaves that branch able to project several times the budget. It is not itself a per-request tunable: it bounds the product of two request parameters, and a request exceeding it is rejected rather than served with a reduced projection.
- The annotation payload ceiling — the maximum serialized size the annotation projection of any legal request may reach, asserted in CI against a measured worst-case response rather than against the product of the constants above (see the `mcp-api` capability, "The worst-case annotation payload MUST be bounded by a named ceiling asserted in CI").

Three of those constants are gates whose shipped state is recorded HERE and nowhere else, so that exactly one requirement has to be edited when one of them moves: the abstention floor and `RELATIVE_LEVEL_RATIO` (see "Recall MUST be able to return nothing"), and the per-session `DIVERSITY_CAP`. The abstention floor and `DIVERSITY_CAP` ship disabled (`null`); `RELATIVE_LEVEL_RATIO` ships ENABLED, at a value carried by a committed sweep. A gate's disabled state is not itself the contract — an uncalibrated gate silently removes recall, so what is contracted is the evidence a commit must carry to enable one, and any statement elsewhere in this capability about which gates are currently on SHALL defer to this paragraph.

Enabling the abstention floor or `RELATIVE_LEVEL_RATIO` SHALL require, in the same change:

1. a committed sweep across a grid of candidate values, produced by the evaluation harness rather than asserted;
2. an over-abstention rate of zero at every committed `k` — no query with a gold answer returns nothing;
3. an abstention false-positive rate at or below its committed cap;
4. precision, recall and MRR at or above their committed floors at every committed `k`;
5. the chosen value in the interior of an admissible plateau at least **0.10 wide in level units** on each of the criteria above — an absolute width, not a count of grid steps, because the grid's resolution is chosen by the same change that is being judged and refining it manufactures compliance without changing anything real. The sweep's grid step SHALL be no coarser than 0.05, so a compliant plateau is always resolved by at least two measured points either side of the chosen value, and a value that holds only across a narrower band SHALL be rejected as a cliff edge rather than accepted as a calibration.

A change to the relevance level's definition SHALL re-derive every enabled gate's value from a fresh sweep and SHALL NOT carry a value forward: a constant calibrated against a different quantity is uncalibrated.

Enabling `DIVERSITY_CAP` SHALL additionally require a session-labelled evaluation fixture, because it is applied to the whole fused pool before the page is sliced — a held-back row is replaced by whatever ranked next in a 64–400 row pool rather than by a comparable row, which on a single-topic session measurably swaps most of page 1 for noise — and the current corpus cannot see that regression, every corpus row carrying a null session id, which is never grouped.

Changing `LEXICAL_CANDIDATE_FLOOR` SHALL require, in the same change, a committed save-time calibration sweep (see the `retrieval-evaluation` capability, "The harness MUST provide a reproducible save-time calibration sweep for the lexical candidate floor") on which the chosen value:

1. surfaces every labelled near-duplicate in the lexical-only arm;
2. surfaces every labelled pair, of every class, through some channel in the production arm;
3. writes zero lexical-sourced pending rows for the labelled unrelated saves in both arms;
4. sits in the interior of an admissible plateau at least **0.10 wide** on the criteria above, swept at a grid step no coarser than 0.05, for the same reason the search gates carry that rule.

Setting the floor to `0` restores rank-only admission and SHALL carry the same sweep, because it changes which candidates are surfaced as much as raising it does.

That sweep obligation SHALL NOT be extended to `ENTITY_RARITY_THRESHOLD` by analogy. The evaluation harness's ranked metrics enter retrieval through the search path and do not observe save-time candidate decisions, and the save-time calibration sweep varies only the lexical floor over a fixture that is not built to vary entity link counts. Neither can therefore observe this gate's decisions, and a sweep over it would report an unmoved baseline at every grid point — a measurement that discriminates nothing while appearing to calibrate. A change to this constant SHALL instead carry a decision table over the gate's own inputs (the active link count and the active scope total), stating both the admitting and the blocking direction with each proportion's denominator, because the decision function is exhaustively enumerable over those two integers where a corpus is only a sample of them.

#### Scenario: A constant is not reachable as a request parameter

- **WHEN** any MCP tool input schema is inspected
- **THEN** none of the constants above SHALL be settable per request

#### Scenario: The candidate pool size is not operator-configurable

- **WHEN** the environment schema is inspected
- **THEN** none of `CANDIDATE_POOL_SIZE`, `ENTITY_RARITY_MIN_LINKS` and `LEXICAL_CANDIDATE_FLOOR` SHALL be readable from the environment, and `CANDIDATES_PER_SAVE_MAX` SHALL remain the only operator knob over save-time candidate surfacing

#### Scenario: The entity link minimum does not follow the operator's per-save maximum

- **GIVEN** an operator setting `CANDIDATES_PER_SAVE_MAX` to a value other than its default
- **WHEN** the entity channel's rarity gate is evaluated
- **THEN** the link count below which the gate does not apply SHALL be the compile-time constant, unchanged by that setting

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

#### Scenario: Refining the grid does not manufacture a plateau

- **GIVEN** an admissible band 0.03 wide in level units, and a sweep whose grid step is refined to 0.005 so that six consecutive grid points inside that band pass every criterion
- **WHEN** a value from the interior of that band is proposed
- **THEN** it SHALL be rejected, because the plateau is narrower than 0.10 in level units regardless of how many grid points fall inside it

#### Scenario: A new level function does not inherit the old calibration

- **GIVEN** an enabled gate whose value was chosen on a sweep over the previous relevance-level definition
- **WHEN** a change alters how the relevance level is computed
- **THEN** that change SHALL re-run the sweep and re-derive the value, and SHALL be rejected if it carries the value forward on the strength of the superseded grid

#### Scenario: A harness sweep is not accepted as a calibration of the rarity gate

- **GIVEN** a change to `ENTITY_RARITY_THRESHOLD` whose only evidence is an evaluation-harness sweep
- **WHEN** that change is reviewed
- **THEN** it SHALL be rejected, because neither the ranked evaluation nor the save-time calibration sweep varies this gate's inputs, and an unmoved baseline is not evidence about this gate

#### Scenario: Re-enabling the diversity cap without a session-labelled fixture

- **WHEN** `DIVERSITY_CAP` is set to a non-null value while every row in the evaluation corpus carries a null session id
- **THEN** the change SHALL be rejected, because the harness cannot observe the regression the cap causes

#### Scenario: The projection bound is not reused as the suppression bound

- **WHEN** `PREDECESSOR_CAP` is changed
- **THEN** the depth of save-time dismissal suppression SHALL be unchanged, and no module outside `memory.get`'s predecessor projection SHALL read that constant

#### Scenario: The projection bound is changed without a distribution

- **WHEN** a change alters `ENTITIES_PROJECTION_CAP` citing only that the bound is reached, without a measured distribution of entities per memory over production-shaped content
- **THEN** the change SHALL be rejected

#### Scenario: The annotation payload constants are declared once

- **WHEN** the modules owning the annotation projection are inspected
- **THEN** `ANNOTATION_REASON_CHARS` and `RELATION_ANNOTATION_RESPONSE_BUDGET` SHALL each be declared exactly once, alongside `RELATION_ANNOTATION_MAX`, and every enforcement site SHALL read them from that declaration rather than restating a literal

#### Scenario: The lexical floor is changed without a save-time sweep

- **WHEN** a change alters `LEXICAL_CANDIDATE_FLOOR` without a committed save-time calibration sweep across a grid of candidate values
- **THEN** the change SHALL be rejected

#### Scenario: A floor value that loses a labelled near-duplicate is rejected

- **GIVEN** a swept floor value at which any labelled near-duplicate is not surfaced in the lexical-only arm
- **WHEN** that value is proposed for `LEXICAL_CANDIDATE_FLOOR`
- **THEN** it SHALL be rejected regardless of how few pending rows it writes

### Requirement: Memory title MUST participate in both retrieval branches

A memory's `title` SHALL contribute to `memory.search` on BOTH branches of hybrid retrieval, not merely as a display label:

- **Lexical**: the FTS5 index (`memory_fts`) SHALL cover `title` in addition to `content` and `tags`, kept in sync by the same INSERT/UPDATE/DELETE triggers. The interactive search lexical branch SHALL rank with a BM25 column weighting that boosts `title` above `content` (`wTitle > wContent`), so a query matching a memory's title ranks it higher. Save-time candidate detection MAY keep default (unweighted) BM25 ranking — that ranking decides which rows enter the bounded pool before the lexical floor is applied (not an absolute bm25 threshold), so reweighting would silently change which rows are considered.
- **Dense**: the per-memory embedding SHALL be computed from the concatenation of `title` and `content` (not `content` alone), so the curated headline shapes the stored vector and the query-vs-memory cosine similarity.

#### Scenario: A title-only term ranks the memory lexically

- **GIVEN** an `active` memory whose curated `title` contains a term that does NOT appear in its `content`
- **WHEN** `memory.search` is called with a query containing that term
- **THEN** the memory SHALL appear in the fused results via the FTS branch, surfaced by the title match

#### Scenario: Title shapes the embedding

- **WHEN** a memory's embedding is computed (inline at save or by the background drain)
- **THEN** the embedded text SHALL be the memory's `title` concatenated with its `content`, not `content` alone
