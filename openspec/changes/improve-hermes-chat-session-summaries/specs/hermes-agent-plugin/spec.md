## ADDED Requirements

### Requirement: Conversational curation reinforcement MUST reuse server notices without falsifying tool observations

The provider SHALL retain last-turn tool observation, including the existing missing-messages fail-open, and SHALL NOT report `usedTools:true` merely because a chat should be summarized. Completed conversation SHALL reach the same `/turn` endpoint as other work. The server SHALL own conversational eligibility and the single floor (`session-nudges`). No provider-specific cadence, curation-complete state, summary-response inspection or new reminder wording SHALL be introduced.

`sync_turn` SHALL retain its supported `**kwargs` signature, context-preserving asynchronous worker, captured credential/session binding, RAW transcript POST and subsequent turn report. `prefetch` SHALL remain network-free and consume returned lines once, verbatim apart from the established wrapper, with the known explicit session ID before a write directive. Empty report responses SHALL NOT erase a pending notice. A report finishing after prefetch SHALL remain eligible for delivery at a later prefetch, without blocking the current user turn or forcing a continuation.

Opening, resumed-read, post-compaction and urgent instructions SHALL retain existing behavior. Lifecycle summaries SHALL remain `final:false`; only the model's successful curated MCP write supplies `final:true`. Primary registration and ensure/resume ordering before MCP writes SHALL remain intact. Suppressed subagent, cron and flush contexts SHALL remain suppressed; legitimate primary bot conversations SHALL NOT be blanket-suppressed.

#### Scenario: A chat-only completed turn delivers a server notice

- **GIVEN** an unsuppressed provider receiving a completed user/assistant turn without tools
- **WHEN** its report returns notice lines after the server floor permits
- **THEN** the report SHALL carry `usedTools:false` and RAW writes SHALL remain non-final
- **AND** a subsequent prefetch SHALL emit the exact server lines with the real session ID, once

#### Scenario: A late asynchronous response is delivered later, not lost or forced

- **GIVEN** a blocked turn-report response and an intervening prefetch
- **WHEN** the response later supplies notice lines
- **THEN** a later prefetch SHALL deliver them exactly once
- **AND** the early prefetch SHALL NOT block, invent lines or force another model turn

#### Scenario: Empty server lines do not erase an undelivered notice

- **GIVEN** cached nonempty notice lines
- **WHEN** a later report returns an empty array before consumption
- **THEN** the original pending lines SHALL survive and be printed once

### Requirement: Empty-session registration or flush changes MUST be gated by actual gateway evidence

A primary ensure before content SHALL NOT alone be treated as proof of the cause of reported empty bot sessions. Before changing registration or transcript flushing, acceptance evidence SHALL identify the actual host/gateway and plugin revisions and reproduce the failing route with synthetic content, hook dispatch, context, session IDs, request outcomes and stored rows. The same run SHALL include a completed-chat positive control and non-primary suppression control.

Any resulting adapter change SHALL use a supported hook demonstrated on that host, preserve ensure-before-MCP attribution, explicit IDs, scoped credentials and `final:false` fallback. Cache eviction, idle release, same-ID recreation and `shutdown` SHALL NOT be interpreted as a conversation boundary. A continuing session SHALL NOT receive `/end` merely because an agent object was discarded. No historical deletion, blanket bot suppression, server LLM or forced continuation SHALL be used to hide the symptom. Where no supported correction is demonstrated, the result SHALL remain an explicitly pending host limitation rather than a claimed fix.

#### Scenario: A provider-only probe does not establish the deployed empty-session cause

- **GIVEN** a mock showing primary initialize creates a row before content
- **WHEN** gateway acceptance is assessed without the actual deployment revision and hook trace
- **THEN** the empty-session cause and remedy SHALL remain unverified
- **AND** no registration or flush patch SHALL be justified by that mock alone

#### Scenario: Soft release is not end of conversation

- **GIVEN** the host soft-releases a cached agent and later recreates a provider for the same ID
- **WHEN** shutdown or recreation occurs without a real conversation boundary
- **THEN** the provider SHALL NOT invent a new session ID or end the continuing row for that reason
- **AND** normal ensure/resume and existing resumed-read guidance SHALL preserve attachment

#### Scenario: A registration change must protect the first MCP write

- **GIVEN** a reproduced registration-only path and a proposed registration change
- **WHEN** the completed-chat control makes its first MCP summary or memory write
- **THEN** the actual session row SHALL already be ensured/resumed and the write SHALL attach to that explicit ID
- **AND** failure of that control SHALL reject the registration change
