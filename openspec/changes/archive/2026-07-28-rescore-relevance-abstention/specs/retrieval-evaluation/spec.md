## MODIFIED Requirements

### Requirement: The corpus MUST include in-corpus distractors and abstention queries

A corpus of unrelated memories does not discriminate between retrievers. The committed corpus SHALL include, for each gold memory, at least one same-project near-miss that shares vocabulary with it but does not answer the query. The query set SHALL include `abstention` queries whose answer is deliberately absent from the corpus, scored on whether the retriever returns nothing rather than the least-bad rows.

The query set SHALL contain at least eight `abstention` queries. A threshold cannot be calibrated against a metric with three attainable values: with two such queries the abstention rate can only read 0, 0.5 or 1, so no sweep over it can distinguish a good value from a lucky one, let alone identify a plateau. Each `abstention` query SHALL share vocabulary with the scope it is issued against, so that the lexical branch returns candidates and the query tests the relevance gate rather than an empty candidate set.

Question types SHALL cover at minimum: extraction, `knowledge-update`, `temporal`, `preference`, `multi-session-causal`, `cross-scope`, and `abstention`.

#### Scenario: A distractor is not counted as a hit

- **GIVEN** a query whose gold memory has a vocabulary-sharing near-miss in the same project
- **WHEN** the retriever returns the near-miss and not the gold memory
- **THEN** the query SHALL score zero recall

#### Scenario: An abstention query is scored on restraint

- **GIVEN** a query whose answer is absent from the corpus
- **WHEN** the retriever returns any result
- **THEN** the abstention metric SHALL record a false positive for that query

#### Scenario: An abstention query exercises the gate, not an empty candidate set

- **GIVEN** any committed `abstention` query
- **WHEN** the production hybrid retriever runs it with both gates disabled
- **THEN** it SHALL return at least one result, proving the query's restraint score measures the gate rather than the absence of candidates

#### Scenario: A cross-scope query respects isolation

- **GIVEN** a gold memory in project A and a vocabulary-sharing memory in project B
- **WHEN** a query is run scoped to project A
- **THEN** project B's memory SHALL NOT appear in the results

### Requirement: Regressions MUST fail CI via a committed ratchet

Committed baseline scorecards SHALL define a floor for each **quality** metric — Precision@k, Recall@k and MRR, enumerated as `FLOOR_METRICS` — and CI SHALL run the harness and fail when any of them falls below its floor. The harness SHALL run as a target separate from the unit-test suite, because it is slow, and a floor SHALL only be lowered by an explicit committed change to the baseline.

The lower-is-better metrics SHALL be enumerated separately, as `CAP_METRICS`, and gated as caps in their own baseline block: the abstention false-positive rate and the over-abstention rate (see "Abstention MUST be scored on both error axes and gated as a cap"). Enumerating them apart from `FLOOR_METRICS` is what makes the comparison direction structural rather than remembered — a metric in the cap list cannot be accidentally compared like a floor.

One metric remains measured and reported but NOT gated, and the gap is stated rather than implied, because "a floor per metric" read as unconditional and a regression that doubled the tokens returned would pass CI unremarked: `avgTokensReturned` has no committed ceiling. It SHALL be closed by its own change; until then no requirement SHALL claim CI protects the token axis.

A cap SHALL be derived as `measured + headroom` where `headroom` is ONE query's worth of that metric's own step, computed from the committed query set's denominator for that metric rather than from a shared literal — the two axes count over different query sets (empty-gold queries for the false-positive rate, gold-bearing ones for over-abstention), so a single headroom taken from the coarser axis silently tolerates several queries going wrong on the finer one. A cap SHALL be clamped to 1, both metrics being rates.

The ratchet SHALL be enforced by the baseline WRITER, not left to the author's discipline, and SHALL apply in both directions of goodness: a floor SHALL never be reduced, and a cap SHALL never be raised, as a side effect of regenerating baselines. A bound derived from a measurement is not a gate on its own: regenerating baselines after a regression rewrites the bound PAST the regressed value, so the next run compares against the worse number and the job stays green permanently, with nothing recording that the gate moved. A proposed bound looser than the committed one is discarded in favour of the committed one, and the fact is reported.

Loosening a bound SHALL remain possible, because a deliberate trade (recall for tokens, say) is legitimate — but only through an explicit opt-in on the write, and every loosened bound SHALL be named in the output so it appears in review rather than only in a diff of generated JSON. The ratchets SHALL be pure functions, unit-tested independently of the slow harness, so the properties "a floor only ever moves up" and "a cap only ever moves down" are asserted rather than assumed.

#### Scenario: A tuning change that regresses recall is rejected

- **WHEN** a change lowers Recall@5 below the committed floor
- **THEN** the evaluation job SHALL fail

#### Scenario: A tuning change that improves recall passes and can raise the floor

- **WHEN** a change raises Recall@5 above the committed floor
- **THEN** the job SHALL pass, and the baseline MAY be updated in the same change to ratchet the floor upward

#### Scenario: Regenerating baselines after a regression does not lower the floor

- **GIVEN** a committed floor and a measurement whose derived floor would fall below it
- **WHEN** baselines are regenerated without the explicit lowering opt-in
- **THEN** the committed floor SHALL be preserved and the attempted reduction SHALL be reported

#### Scenario: Regenerating baselines after a regression does not raise a cap

- **GIVEN** a committed cap and a measurement whose derived cap would rise above it
- **WHEN** baselines are regenerated without the explicit loosening opt-in
- **THEN** the committed cap SHALL be preserved and the attempted increase SHALL be reported

#### Scenario: Lowering a floor is explicit and named

- **WHEN** baselines are regenerated WITH the lowering opt-in and a floor drops
- **THEN** the written floor SHALL be the lower value and the output SHALL name every metric and `k` that was lowered

#### Scenario: Repeated regeneration cannot drift a floor down

- **GIVEN** an unchanged measurement
- **WHEN** baselines are regenerated any number of times
- **THEN** every floor and every cap SHALL be identical after every write

#### Scenario: An ungated metric is reported, not enforced

- **WHEN** a change doubles `avgTokensReturned` without moving any quality metric
- **THEN** the harness SHALL report the new value and the job SHALL pass — the token axis carries no committed ceiling, and any claim that it is gated SHALL be treated as a spec defect

#### Scenario: The harness does not slow the unit suite

- **WHEN** the unit test suite runs
- **THEN** the evaluation harness SHALL NOT execute as part of it

## ADDED Requirements

### Requirement: Abstention MUST be scored on both error axes and gated as a cap

Abstention has two failure modes and the harness SHALL report each as its own number. Returning results for a query whose answer is absent is a **false positive**; returning nothing for a query that has a gold answer is **over-abstention**. Folding the second into recall makes it indistinguishable from bad ranking, which is precisely the distinction a floor calibration turns on: it is the difference between "the threshold is too high" and "retrieval is weak".

Every aggregate SHALL therefore report an abstention false-positive rate over the empty-gold queries and an over-abstention rate over the gold-bearing queries, at each committed `k` and in the per-question-type breakdown.

Both SHALL be gated in CI. Because lower is better for each, they SHALL be gated as **caps** — a run fails when a measured value rises above its committed cap — rather than as floors, and the committed baseline SHALL record them separately from the lower-is-worse floors so the two cannot be compared in the wrong direction.

A retriever's abstention SHALL be defined as returning no results, which is what a caller observes and is the only definition all retrievers can satisfy. Where a retriever also reports an explicit abstention flag, the harness SHALL assert that the flag agrees with emptiness, so a flag that drifts from the behaviour it describes fails the run.

#### Scenario: A gold-bearing query that returns nothing is visible as over-abstention

- **GIVEN** a query with a gold answer, and an abstention floor set high enough to reject it
- **WHEN** the harness scores the run
- **THEN** the over-abstention rate SHALL be non-zero, and SHALL be reported separately from recall

#### Scenario: A regression in either abstention axis fails CI

- **GIVEN** a committed cap for the abstention false-positive rate and for the over-abstention rate
- **WHEN** a change raises either measured value above its cap
- **THEN** the evaluation job SHALL fail, naming the metric and both values

#### Scenario: An abstention flag that disagrees with the result set fails the run

- **GIVEN** a retriever that reports an explicit abstention flag
- **WHEN** it reports `abstained: true` while returning results, or `abstained: false` while returning none
- **THEN** the evaluation job SHALL fail

### Requirement: The harness MUST emit a reproducible calibration sweep for the abstention gates

A threshold chosen by inspecting one scorecard is a guess with a number attached. The harness SHALL provide a sweep mode that runs the production retriever across a committed grid of abstention-floor and relative-ratio values and reports, per grid point, recall, the abstention false-positive rate, the over-abstention rate and tokens returned, at every committed `k`.

The sweep SHALL be invocable as a documented command so that any reviewer can reproduce the grid that justified a value, and SHALL be deterministic on unchanged inputs like every other harness output. It SHALL also report each component of the relevance level — the lexical coverage and the dense cosine of that same leading row — so that a decision to split the single level into per-branch thresholds can be made on measured evidence rather than on preference.

#### Scenario: The sweep reports every axis at every grid point

- **WHEN** the sweep is run
- **THEN** it SHALL emit one row per grid point containing recall, the abstention false-positive rate, the over-abstention rate and tokens returned, at each committed `k`

#### Scenario: A value's plateau is visible in the sweep output

- **GIVEN** a candidate value that satisfies every acceptance criterion
- **WHEN** the sweep output is read
- **THEN** the adjacent grid points' results SHALL be present in the same output, so whether the value sits in a plateau or on a cliff edge is readable without re-running the harness

#### Scenario: Two sweeps on unchanged inputs agree

- **WHEN** the sweep is run twice against identical corpus, query set and grid
- **THEN** every reported value SHALL be identical apart from latency
