# retrieval-evaluation — delta

## MODIFIED Requirements

### Requirement: Abstention MUST be scored on both error axes and gated as a cap

Abstention has two failure modes and the harness SHALL report each as its own number. Returning results for a query whose answer is absent is a **false positive**; returning nothing for a query that has a gold answer is **over-abstention**. Folding the second into recall makes it indistinguishable from bad ranking, which is precisely the distinction a floor calibration turns on: it is the difference between "the threshold is too high" and "retrieval is weak".

Every aggregate SHALL therefore report an abstention false-positive rate over the empty-gold queries and an over-abstention rate over the gold-bearing queries, at each committed `k` and in the per-question-type breakdown.

Both SHALL be gated in CI. Because lower is better for each, they SHALL be gated as **caps** — a run fails when a measured value rises above its committed cap — rather than as floors, and the committed baseline SHALL record them separately from the lower-is-worse floors so the two cannot be compared in the wrong direction.

A retriever's abstention SHALL be defined, for SCORING purposes, as returning no results — that is what a caller observes and it is the only definition all retrievers can satisfy. That scoring definition SHALL NOT be promoted into a correctness requirement on a retriever's own flag. A retriever that reports an explicit flag MAY legitimately return no results while reporting `abstained: false`: the `memory` capability mandates exactly that for a page sliced beyond a non-empty candidate pool ("BREAKING — offset is best-effort on the hybrid branch") and for a page the relative relevance filter shortened to nothing. Requiring the harness to fail on it would put the harness in contradiction with the shipped retrieval contract, and the retrieval contract is the authority on what a retriever does.

The remaining direction IS a correctness requirement and SHALL be enforced: a retriever that reports `abstained: true` while returning results is incoherent under any reading of the flag, and the harness SHALL fail the run naming the retriever, the query and the returned count. This is the direction a future abstention floor could plausibly break.

Because the committed corpus cannot exercise that check — no committed query yields an empty candidate pool, so no outcome exercises either direction — the check SHALL NOT be presented as covered by the evaluation run. It SHALL instead carry a direct test over constructed outcomes, asserting that the enforced direction fails and that the permitted combination passes. A guard whose only evidence is a green job that would be green without it SHALL be treated as untested.

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
- **WHEN** it reports `abstained: true` while returning one or more results
- **THEN** the evaluation job SHALL fail, naming the retriever, the query and the number of results returned
- **AND** the converse combination SHALL NOT fail the run, which the next scenario pins

#### Scenario: An empty result set with `abstained: false` does not fail the run

- **GIVEN** a retriever that reports an explicit abstention flag
- **WHEN** it returns no results while reporting `abstained: false` — the response the `memory` capability mandates for a page sliced beyond a non-empty candidate pool
- **THEN** the evaluation job SHALL NOT fail on the flag check
- **AND** the query SHALL still be scored as an abstention for the two rate metrics, which are defined on emptiness

#### Scenario: The flag check is tested directly, not inferred from a green run

- **WHEN** the flag check is exercised over constructed outcomes rather than over the committed corpus
- **THEN** an outcome reporting `abstained: true` with results SHALL produce a failure naming that outcome
- **AND** an outcome reporting `abstained: false` with no results SHALL produce no failure
