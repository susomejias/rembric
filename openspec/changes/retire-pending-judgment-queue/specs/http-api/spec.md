## ADDED Requirements

### Requirement: The learnings route MUST NOT record pending relations while the judgment queue is disabled

While `JUDGMENT_QUEUE_ENABLED` is `0`, `POST /api/<slug>/sessions/:id/learnings` SHALL save the extracted learnings through the same core capture function as before and SHALL write no `pending` `memory_relations` row for any of them. Its caller is a hook with no agent to judge a candidate, so nothing detected there is handed to anyone.

The response SHALL be unchanged: `200 { ok: true, saved, skipped, ids, candidatesDetected }`, with `reason` when `saved` is `0`, and no candidate list. `candidatesDetected` SHALL still be the sum detected over the saves performed.

This overrides, for the disabled setting only, the sentence of "`POST /api/<slug>/sessions/:id/learnings` MUST capture the Key Learnings of a subagent report into session `:id`" that says the pending relations recorded at save time reach an agent through `memory.context.pendingJudgments[]`. While the setting is `1` that requirement applies unchanged.

#### Scenario: A forwarded report adds no pending judgment

- **GIVEN** `JUDGMENT_QUEUE_ENABLED=0` and a report whose two learnings each resemble an active memory
- **WHEN** the hook posts the report to the learnings route
- **THEN** the response SHALL be `200` with `saved: 2` and `candidatesDetected` of at least `2`
- **AND** the project's count of `pending` `memory_relations` rows SHALL be the same as before the request

#### Scenario: The enabled setting keeps recording them

- **GIVEN** `JUDGMENT_QUEUE_ENABLED=1` and the same report
- **WHEN** the hook posts it
- **THEN** a `pending` row SHALL be written for each detected candidate within the per-save cap
