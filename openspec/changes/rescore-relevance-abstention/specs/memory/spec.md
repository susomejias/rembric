## MODIFIED Requirements

### Requirement: Recall MUST be able to return nothing

The text-query branch SHALL be able to report that it found nothing relevant, rather than always returning the highest-scoring available rows. A confidently-irrelevant result is worse than an empty one, because the calling agent has no signal to distrust it and will treat it as established project knowledge.

Both gates SHALL read ONE quantity, at ONE point in the pipeline.

The quantity is a per-row **relevance level** in `[0,1]`: the greater of (a) the fraction of the query's distinct tokens present in the row's title and content, and (b) the dense branch's cosine similarity for that row. It is bounded and independent of corpus size by construction, so a calibrated value means the same thing on a 40-row corpus and a 5,000-row one. The level SHALL NOT be derived from:

- **raw or logistically-normalised `bm25()`** — unbounded, corpus-relative, and, because FTS5 clamps a non-positive IDF to `1e-6`, always at or above 0.5 under the logistic, saturating to 0.98 within a few IDF units. No absolute threshold on it can fire in the usable range;
- **fused RRF scores** — a function of rank position, not of match quality. Their consecutive ratios are fixed by the rank constant (0.984 rising to 0.996 within a branch-membership class, exactly 0.500 across the both-branches → single-branch boundary), so a threshold over them selects branch membership rather than relevance;
- **any window-relative normalisation** (min-max, rank-percentile, z-score over the branch's own rank window) — each maps the window's best row to a constant, so it can express the *shape* of a result list but never its *level*, and an absolute floor is a statement about level.

The evaluation point is **after fusion and before the ranking boost**. After fusion, because the page only exists once the branches are fused. Before the boost, because the boost is a ranking multiplier over recency, type and confirmation count with a reachable spread of 1.5× — it is not a relevance measure, and a gate placed behind it lets a fresh, repeatedly-confirmed, irrelevant row clear an abstention check that a stale relevant row fails.

At that point the two gates are:

- The **floor** is absolute and is compared against the highest relevance level in a bounded gate window over the fused pool. When no row in that window reaches the floor, the response SHALL contain no results and SHALL carry an explicit abstention flag and a reason.
- The **relative filter** keeps a row only while its level is at or above `ratio × leaderLevel`, where `leaderLevel` is the same window maximum the floor used, and preserves fused order. It is a per-row test **relative to the best level**, not a truncation at the first consecutive-pair drop: a gradually decaying tail passes every consecutive test and so returns rows far below the leader, and over a level sequence that is not monotone in fused order, truncating at the first offender discards strictly better rows behind it.

A page shortened by the relative filter SHALL NOT be padded to the requested limit, and SHALL report `abstained: false` — abstention is the floor's verdict, and a caller MUST be able to tell "nothing relevant exists" from "fewer than `limit` rows were relevant".

Both gates SHALL be disabled by default. While both are disabled the branch SHALL perform no gate-related work at all: it SHALL issue the same queries and return the same result ids as if the gates did not exist.

#### Scenario: A query with nothing relevant abstains

- **GIVEN** the floor is enabled with a calibrated value, and a scope whose memories are all unrelated to the query
- **WHEN** `memory.search` is called
- **THEN** the response SHALL contain no results and SHALL report abstention with a reason

#### Scenario: A gate decision does not change when the corpus grows

- **GIVEN** the floor and the relative filter are enabled, and a query whose decision is recorded against a corpus
- **WHEN** the corpus is enlarged with rows unrelated to that query and the same query is re-run
- **THEN** both gates SHALL reach the same decision, because the level of a row depends only on that row and the query

#### Scenario: A gradually decaying tail is cut

- **GIVEN** the relative filter is enabled at a ratio of 0.5, and a fused pool whose relevance levels are 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3
- **WHEN** `memory.search` is called with a limit of 8
- **THEN** the rows at 0.4 and 0.3 SHALL be omitted, because each is below `0.5 × 0.9`

#### Scenario: A short page is distinguishable from an abstention

- **GIVEN** the relative filter is enabled and it drops every row but two, while the leader clears the floor
- **WHEN** `memory.search` is called with a limit of 8
- **THEN** the response SHALL contain two results and SHALL report `abstained: false`

#### Scenario: Abstention is off by default and costs nothing

- **WHEN** the system runs without calibrated abstention values configured
- **THEN** the text-query branch SHALL return the same result ids it returns with the gates removed, and SHALL issue no additional database read on their behalf

### Requirement: Retrieval and lifecycle constants MUST be named and bounded in one place

Ranking, projection and lifecycle behaviour is governed by a set of compile-time constants that no requirement previously named, which made each one invisible to review and free to drift. None SHALL be operator-configurable or exposed as a per-request tunable, and each SHALL be declared once, as a named constant, in the module that owns the behaviour:

- `RANK_WINDOW_MARGIN` — the over-fetch added to `limit + offset` before the floor and ceiling are applied, so a page near a window edge still fuses over more candidates than it returns.
- `RANK_WINDOW_CEILING` — the hard cap on that window, set strictly above the maximum `limit`. It doubles as the entity path's page size when no `limit` is given (see `mcp-api`), so exact-address retrieval is complete-within-a-bound rather than truncated to a ranked default.
- `GATE_WINDOW_MARGIN` — the over-fetch added to `limit + offset` to form the gate window over which relevance levels are computed. Strictly smaller than the rank window, because the gate window's rows are read with their text and the rank window's are not.
- `RELATIVE_LEVEL_RATIO` — the relative-filter ratio applied against the gate window's highest relevance level. Named for what it measures; it is not a consecutive-pair gap ratio and SHALL NOT be described as one.
- `RELEVANCE_LIMIT` — the cap on `memory.context`'s relevance channel, shared by its entity pre-pass and its ranked pass.
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
