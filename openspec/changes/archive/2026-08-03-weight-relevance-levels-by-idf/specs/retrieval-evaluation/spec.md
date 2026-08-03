## MODIFIED Requirements

### Requirement: The harness MUST emit a reproducible calibration sweep for the abstention gates

A threshold chosen by inspecting one scorecard is a guess with a number attached. The harness SHALL provide a sweep mode that runs the production retriever across a committed grid of abstention-floor and relative-ratio values and reports, per grid point, recall, the abstention false-positive rate, the over-abstention rate and tokens returned, at every committed `k`.

The sweep SHALL be invocable as a documented command so that any reviewer can reproduce the grid that justified a value, and SHALL be deterministic on unchanged inputs like every other harness output. It SHALL also report each component of the relevance level — the lexical coverage and the dense cosine of that same leading row — so that a decision to split the single level into per-branch thresholds can be made on measured evidence rather than on preference.

Because the lexical component is weighted by corpus term statistics, the sweep SHALL additionally report the statistics that produced the weights: the document total the weights were computed against, and, for the leading row of each query, the document frequency of every query term. Without them a reader cannot tell a level that moved because the row changed from one that moved because the corpus did, and the grid stops being reproducible from the committed corpus alone.

A change to the definition of the relevance level SHALL be justified by a sweep run against an UNCHANGED corpus and query set, and SHALL cite the previous committed grid as its before. Changing the corpus and the level function in one change makes the comparison uninterpretable, so the two SHALL land as separate changes.

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

#### Scenario: The weighting behind a level is readable from the grid

- **WHEN** the sweep output is read for any one query
- **THEN** it SHALL contain the document total and the per-term document frequencies that produced that query's leading level, so the level can be recomputed by hand from the committed corpus

#### Scenario: A level-function change is measured against the same fixtures

- **GIVEN** a change that alters how the relevance level is computed
- **WHEN** its sweep is reviewed
- **THEN** it SHALL have been produced against the same corpus and query set as the grid it cites as its before, and a change that alters both the fixtures and the level function SHALL be rejected
