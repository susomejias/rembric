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

The sweep SHALL be invocable as a documented command so that any reviewer can reproduce the grid that justified a value, and SHALL be deterministic on unchanged inputs like every other harness output. It SHALL also report each component of the relevance level — the lexical coverage and the dense cosine of the gate window's leader — so that a decision to split the single level into per-branch thresholds can be made on measured evidence rather than on preference.

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
