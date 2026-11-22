## ADDED Requirements

### Requirement: Save responses MUST carry candidates as unpersisted pairs while the judgment queue is disabled

While `JUDGMENT_QUEUE_ENABLED` is `0` (see the `memory` capability under "Save-time candidates MUST NOT be persisted while the judgment queue is disabled"), the responses of `memory.save`, `memory.capture_passive` and a confirmed `memory.merge` SHALL describe detected candidates as follows:

- Each `candidates[]` entry SHALL carry `sourceId`, the id of the memory whose save detected the pair, and `targetId`. It SHALL NOT carry `judgmentId`. Its other fields (`title`, `snippet`, `similarity`, `source`, `topicKey`, `entityValue`) are unchanged.
- A high-band entry SHALL carry `converge: true`. Middle-band entries SHALL omit the field.
- `convergeWith[]` SHALL be an empty array where the tool's response declares the field as required and SHALL be omitted where it is optional.
- `judgmentRequired` SHALL be `false` wherever the response carries it.
- `related[]` and `candidatesDetected` SHALL be exactly what they are with the queue enabled.

The output schemas SHALL declare `judgmentId` as optional on a candidate and SHALL declare `sourceId` and `converge` as optional, so one schema describes both settings.

This overrides, for the disabled setting only, the `judgmentId` and `convergeWith[]` clauses of "memory.save MUST accept a `topic_key` and surface candidates", of "Save responses MUST report low-band pairs as `related[]` and high-band candidates in `convergeWith[]`" and of "`memory.capture_passive` MUST use the same curation path as `memory.save`". While the setting is `1` those requirements apply unchanged and no entry SHALL carry `sourceId` or `converge`.

#### Scenario: memory.save returns a candidate without a judgment id

- **GIVEN** `JUDGMENT_QUEUE_ENABLED=0` and a save whose detection admits one middle-band candidate T
- **WHEN** `memory.save` returns
- **THEN** `candidates` SHALL have one entry with `targetId = T` and `sourceId` equal to the response `id`
- **AND** that entry SHALL have no `judgmentId` and no `converge`
- **AND** `convergeWith` SHALL be `[]` and `judgmentRequired` SHALL be `false`

#### Scenario: A high-band candidate is marked for convergence

- **GIVEN** `JUDGMENT_QUEUE_ENABLED=0` and a save whose detection admits a high-band candidate H
- **WHEN** `memory.save` returns
- **THEN** the `candidates[]` entry for H SHALL carry `converge: true`
- **AND** `convergeWith` SHALL be `[]`

#### Scenario: memory.capture_passive names the pair for each candidate

- **GIVEN** `JUDGMENT_QUEUE_ENABLED=0` and a capture that saves learnings L1 and L2, each resembling the same active memory T
- **WHEN** `memory.capture_passive` returns
- **THEN** `candidates` SHALL hold one entry with `sourceId = L1, targetId = T` and one with `sourceId = L2, targetId = T`
- **AND** neither SHALL carry `judgmentId`

#### Scenario: The enabled setting keeps the published shape

- **GIVEN** `JUDGMENT_QUEUE_ENABLED=1`
- **WHEN** `memory.save` detects one high-band candidate
- **THEN** its entry SHALL carry `judgmentId` and neither `sourceId` nor `converge`
- **AND** `convergeWith` SHALL hold that `judgmentId` and `judgmentRequired` SHALL be `true`

### Requirement: Agent guidance MUST ask for a verdict only when it changes a memory while the judgment queue is disabled

While `JUDGMENT_QUEUE_ENABLED` is `0`, the text the server ships to agents SHALL tell them to act on a save's `candidates[]` only in two cases and to do nothing otherwise:

- the saved memory replaces the candidate: call `memory.compare` with `relation: 'supersedes'`, the saved memory as the superseding side and the candidate as the superseded side;
- the two contradict each other: call `memory.compare` with `relation: 'conflicts_with'`.

That text is the `instructions` block and the descriptions of `memory.save`, `memory.capture_passive`, `memory.merge`, `memory.compare`, `memory.judge_batch`, `memory.context`, `memory.search` and `memory.archive`. Where the last two point at `memory.judge_batch` for a contradiction or a supersession, they SHALL point at `memory.compare` with `conflicts_with` or `supersedes` instead. It SHALL NOT ask for `related`, `compatible`, `scoped` or `not_conflict` verdicts on save candidates, and SHALL NOT describe `candidates[]` as a queue the save created. It SHALL say that `converge: true` marks a candidate likely to restate the saved fact, to be superseded or converged under one `topic_key`.

The descriptions of `memory.judge_batch` and of `memory.context` SHALL say that pending judgments exist only for pairs recorded before the queue was disabled.

The `instructions` block SHALL stay within the length limit set by "The MCP `initialize` response MUST ship a protocol-teaching `instructions` block" in every variant. While the setting is `1`, the shipped text SHALL be the text published before this requirement.

`memory.compare` itself SHALL be unchanged: its schema, the relations it accepts and the rows it writes are those of "The MCP server MUST expose `memory.compare`".

#### Scenario: The instructions block points at memory.compare

- **GIVEN** `JUDGMENT_QUEUE_ENABLED=0`
- **WHEN** a client reads the `instructions` field of the `initialize` response
- **THEN** it SHALL name `memory.compare` as the action for a candidate that the saved memory supersedes or contradicts
- **AND** it SHALL NOT contain `memory.judge_batch({judgments:[…]})` as the follow-up to `candidates[]`
- **AND** it SHALL be 1500 characters or fewer

#### Scenario: The enabled setting ships the previous guidance

- **GIVEN** `JUDGMENT_QUEUE_ENABLED=1`
- **WHEN** a client reads the `instructions` field
- **THEN** it SHALL tell the agent to close `candidates[]` with `memory.judge_batch`

#### Scenario: Superseding a candidate through memory.compare

- **GIVEN** `JUDGMENT_QUEUE_ENABLED=0`, a saved memory S and a returned candidate T
- **WHEN** the agent records `supersedes` for S over T with `memory.compare`
- **THEN** one `judged` `memory_relations` row SHALL be written for the pair
- **AND** T SHALL become `superseded` and S SHALL list T in `replaces`

#### Scenario: Ignoring a candidate writes nothing

- **GIVEN** `JUDGMENT_QUEUE_ENABLED=0` and a save that returned two candidates
- **WHEN** the agent makes no further call
- **THEN** no `memory_relations` row SHALL exist for either pair
- **AND** a later `memory.context` SHALL NOT list either pair in `pendingJudgments[]`
