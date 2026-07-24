## ADDED Requirements

### Requirement: Save-time lexical candidate scoring MUST increase with match quality

FTS5's bm25 score is negative and unbounded, and a better match is *more* negative. Any similarity derived from it SHALL be monotonically **increasing** in match quality, and SHALL be bounded to `[0, 1]` so that the value reported to the agent as `similarity` is truthful against its documented range and comparable with the cosine similarity produced by the dense detector.

Because bm25 magnitudes scale with corpus size and term IDF, the system SHALL NOT gate lexical candidates on an absolute threshold over the raw bm25 value: no such threshold is stable across corpus sizes. Admission SHALL instead be by rank position within the already-correctly-ordered candidate pool, and the reported `similarity` SHALL be computed as a corpus-independent lexical overlap measure between the saved text and the candidate.

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

### Requirement: The rank window MUST be wide enough for the rank constant it uses

Reciprocal Rank Fusion with rank constant `k` only preserves the intended ordering when the rank window is wide enough that a bottom-of-window row present in both branches cannot outscore a rank-1 row present in one branch. That condition is `2/(k + window) <= 1/(k + 1)`, i.e. the window must be at least `k + 2`. With `k = 60` and the default result limit the window is currently 38, well below the crossover, so the invariant is violated on the default path.

The rank window SHALL be floored at or above the crossover implied by the rank constant, so that a single-branch rank-1 match is never displaced by rows whose only advantage is appearing in both branches' windows. Both retrievers already over-fetch and the dense kNN cost is flat in `k`, so the floor SHALL be implemented by widening the window rather than by lowering the rank constant.

#### Scenario: An exact single-branch match outranks a both-branches pair

- **GIVEN** a query whose exact-token match is returned at rank 1 by the lexical branch and is absent from the dense branch's window
- **AND** two rows that appear near the bottom of both branches' windows
- **WHEN** the ranked lists are fused at the default result limit
- **THEN** the exact match SHALL outrank both of those rows

#### Scenario: An identifier query returns the memory naming it

- **GIVEN** an active memory whose content contains a rare identifier, and at least eight topically-adjacent memories that both branches surface
- **WHEN** `memory.search` is called with that identifier at the default limit
- **THEN** the memory containing the identifier SHALL appear in the returned page

#### Scenario: Large-limit behavior is unchanged

- **WHEN** `memory.search` is called with a limit whose derived window already exceeds the crossover
- **THEN** the window SHALL be unchanged by the floor

### Requirement: The post-fusion boost's documented guarantee MUST match its behavior

The post-fusion boost is applied before results are truncated to the requested limit, so it can and does change which rows are returned — reordering near-ties is its purpose. The implementation currently documents the opposite, claiming the clamp prevents it from overriding fusion order, while a neighbouring test asserts that it reorders. Its reachable multiplier range is `[0.9, 1.35]`, so the declared clamp bounds are unreachable.

The documented guarantee SHALL state the boost's actual intended effect, including that it may change page membership, and SHALL be accompanied by a test whose inputs are inside the range fusion can actually produce. A guard test whose inputs exceed the maximum achievable fused score SHALL NOT be treated as coverage.

#### Scenario: The boost guarantee is tested within the reachable domain

- **WHEN** the boost's ordering guarantee is tested
- **THEN** the test inputs SHALL be scores achievable by the fusion function over ranked lists, not values above its arithmetic ceiling

#### Scenario: The documented bound matches the reachable range

- **WHEN** the boost's documented range is compared against the sum of its reachable terms
- **THEN** the documentation SHALL not claim bounds the implementation cannot reach
