## ADDED Requirements

### Requirement: The `memory.save` description MUST describe save-time detection truthfully

The `memory.save` tool description is the only account of save-time candidate detection that an agent reads. It previously stated that `candidates[]` appear "when the save matches existing memories above the configured similarity threshold". That was false in two ways: no threshold is configurable (see the `memory` capability, "Retrieval and lifecycle constants MUST be named and bounded in one place"), and the entity channel admits a pair on a shared rare identifier, whatever the two texts' overlap.

The description SHALL therefore state where candidates come from, channel by channel and without naming internal constants:

- similar wording;
- similar meaning;
- a shared rare identifier, such as a file path or URL. The description SHALL say that this source can surface a pair with little shared wording, because that is the pair most likely to look like a false positive to an agent and most likely to be a real contradiction.

It SHALL NOT describe any candidate source as gated by a configurable or operator-set threshold.

This requirement adds to the obligations of "`memory.save` MUST report how many candidates its detection produced" and does not replace them: every statement that requirement obliges the description to make SHALL still be made. The description SHALL stay within `DESCRIPTION_MAX_LENGTH`, including the appended redaction note.

The operator documentation SHALL agree with the code on the same point: the only save-time candidate setting it documents SHALL be `CANDIDATES_PER_SAVE_MAX`, and it SHALL NOT document a threshold variable that the server does not read.

#### Scenario: The description does not claim a configurable threshold

- **WHEN** the registered `memory.save` description is read
- **THEN** it SHALL NOT state that candidates matched above a configured similarity threshold

#### Scenario: The description names the identifier source

- **WHEN** the registered `memory.save` description is read
- **THEN** it SHALL state that a candidate can come from a shared rare identifier such as a file path or URL, and that such a pair can share little wording

#### Scenario: The candidate-count obligations survive the rewrite

- **WHEN** the registered `memory.save` description is read
- **THEN** it SHALL still state what `candidatesDetected` counts and that it is a lower bound, that only `candidates[]` entries carry `judgmentId`s, the `topic_key` convergence advice, and the `memory.search` / `memory.compare` route for the unsurfaced remainder, and it SHALL name `CANDIDATES_PER_SAVE_MAX` as the bound

#### Scenario: The operator documentation lists no unread threshold variable

- **WHEN** the README's configuration tables are compared with the environment variables the server reads
- **THEN** `CANDIDATES_PER_SAVE_MAX` SHALL be the only save-time candidate variable documented, and neither `CANDIDATE_VEC_THRESHOLD` nor `CANDIDATE_FTS_THRESHOLD` SHALL appear
