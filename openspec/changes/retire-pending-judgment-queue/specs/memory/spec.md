## ADDED Requirements

### Requirement: Save-time candidates MUST NOT be persisted while the judgment queue is disabled

The server SHALL read an operator setting `JUDGMENT_QUEUE_ENABLED` whose accepted values are `0` and `1` and whose default is `0`. As with the other integer settings, an unset, empty or non-integer value SHALL fall back to the default, and an integer outside `0..1` SHALL be clamped into that range.

While the setting is `0`, the candidate-detection step that runs after a save SHALL be unchanged in what it detects: the same channels, floors, confidence bands, ranking and `CANDIDATES_PER_SAVE_MAX` cap apply. It SHALL NOT insert a `memory_relations` row for any detected pair, SHALL NOT allocate a `judgment_id`, and SHALL NOT write a journal entry for the detection. The detected pairs SHALL be returned to the caller as specified in the `mcp-api` capability.

This overrides, for the disabled setting only, the clauses of "`memory.save` MUST surface candidate conflicts at save-time" that require a `pending` row per candidate. Every other clause of that requirement stays in force. While the setting is `1`, that requirement applies unchanged and this one imposes nothing.

The setting SHALL NOT change any stored row. Rows that are `pending` when the setting becomes `0` SHALL remain `pending`, SHALL remain judgeable, SHALL remain subject to the orphaning deadline and the drain, and SHALL keep appearing in the agent queue until one of those paths closes them.

A `memory_relations` row SHALL still be written, with `status = 'judged'`, by a `topic_key` upsert and by `memory.compare`, whatever the setting.

#### Scenario: A save with the queue disabled detects candidates and writes no row

- **GIVEN** `JUDGMENT_QUEUE_ENABLED` is unset
- **AND** an active memory T that the detection step admits as a middle-band candidate of a new memory S
- **WHEN** S is saved
- **THEN** the save response SHALL list T among its candidates
- **AND** no `memory_relations` row SHALL exist with `source_id = S` and `target_id = T`
- **AND** the count of `pending` rows in the project SHALL be the same as before the save

#### Scenario: Detection is the same on both settings

- **GIVEN** two databases with identical memories, one served with `JUDGMENT_QUEUE_ENABLED=0` and one with `JUDGMENT_QUEUE_ENABLED=1`
- **WHEN** the same memory is saved to each
- **THEN** both responses SHALL name the same candidate targets in the same order and the same `candidatesDetected`
- **AND** only the database served with `1` SHALL gain `pending` rows

#### Scenario: Enabling the queue restores the persisted candidates

- **GIVEN** `JUDGMENT_QUEUE_ENABLED=1`
- **WHEN** a memory with one middle-band candidate is saved
- **THEN** one `pending` `memory_relations` row SHALL be written for the pair and its `judgmentId` SHALL be returned

#### Scenario: Rows pending at the switch stay in the queue

- **GIVEN** a `pending` row P created while the setting was `1`
- **WHEN** the server restarts with the setting `0`
- **THEN** P SHALL still be `pending`
- **AND** P SHALL be returned by the agent queue and accepted by a verdict on its `judgmentId`
- **AND** P SHALL be orphaned by the deadline if no verdict arrives

#### Scenario: A topic_key upsert still records its supersession

- **GIVEN** `JUDGMENT_QUEUE_ENABLED=0` and an active memory under `topic_key` K
- **WHEN** a new memory is saved under K
- **THEN** a `judged` `supersedes` row marked `agent_topic_key` SHALL be written as before
