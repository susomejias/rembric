## MODIFIED Requirements

### Requirement: Retrieval and lifecycle constants MUST be named and bounded in one place

Ranking, projection and lifecycle behaviour is governed by a set of compile-time constants that no requirement previously named, which made each one invisible to review and free to drift. None SHALL be operator-configurable or exposed as a per-request tunable, and each SHALL be declared once, as a named constant, in the module that owns the behaviour:

- `RANK_WINDOW_MARGIN` — the over-fetch added to `limit + offset` before the floor and ceiling are applied, so a page near a window edge still fuses over more candidates than it returns.
- `RANK_WINDOW_CEILING` — the hard cap on that window, set strictly above the maximum `limit`. It doubles as the entity path's page size when no `limit` is given (see `mcp-api`), so exact-address retrieval is complete-within-a-bound rather than truncated to a ranked default.
- `RELATIVE_LEVEL_RATIO` — the relative-filter ratio applied against the fused pool's highest relevance level. Named for what it measures; it is not a consecutive-pair gap ratio and SHALL NOT be described as one.
- `RELEVANCE_LIMIT` — the cap on `memory.context`'s relevance channel, shared by its entity pre-pass and its ranked pass.
- `CANDIDATE_POOL_SIZE` — the per-channel pool each save-time candidate channel scans BEFORE the merged list is ranked and capped. It is the bound that makes the reported detected count a lower bound rather than a total, and for the lexical channel it IS the admission rule (see "Save-time lexical candidate scoring MUST increase with match quality"), so exposing it as configuration would make an admission rule operator-settable. It is applied per channel, and the entity channel applies it once per extracted entity, so the merged pool — and therefore the detected count — MAY exceed it.
- `ENTITY_RARITY_THRESHOLD` — the maximum share of a scope's active memories an entity may be linked to before it stops proposing save-time candidates. A proportion, not an absolute count, so it does not become inert as a corpus grows.
- `ENTITIES_PROJECTION_CAP` — the per-memory bound on the `entities[]` projection. The reads behind it carry no `LIMIT`, so the complete per-memory count is in hand where the bound is applied and SHALL be reported as a count rather than as an indication that the bound was hit. Unlike `CANDIDATE_POOL_SIZE` above there is no pool upstream of it, so that count is exact and MAY carry a `Total` suffix. It SHALL be applied to a fair-shared order rather than an arbitrary one (see `mcp-api`), so that what the bound withholds is a stated consequence of the memory's entity composition rather than an accident of kind naming — a bound over an arbitrary order cannot be reviewed, because what it costs is unknowable. Changing its value SHALL therefore be argued against a measured distribution of entities per memory, produced by running the shipped extractor over production-shaped content, not against the returned array's length.
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

#### Scenario: The projection bound is changed without a distribution

- **WHEN** a change alters `ENTITIES_PROJECTION_CAP` citing only that the bound is reached, without a measured distribution of entities per memory over production-shaped content
- **THEN** the change SHALL be rejected
