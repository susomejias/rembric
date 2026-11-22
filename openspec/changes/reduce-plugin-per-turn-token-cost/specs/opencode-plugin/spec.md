## ADDED Requirements

### Requirement: The V2 plugin SHALL replace its cached block with each prompt's block, an empty one included

The V2 plugin caches the block a `prompt` hook computes and pushes it on every `context` request of that session, because a V2 system part lives for one model request. The block a prompt computes SHALL replace the cached one even when it is empty. Before this requirement an empty block left the previous turn's block cached, so a one-shot line from an earlier turn — the first-prompt nudge, the sessionId line or the session-opening nudge ("before you finish this turn, call `memory.session_summary`…") — was sent again on every request of every later turn until compaction or close, while a non-empty block replaced it. Which block a request carried therefore depended on whether the current turn happened to have something to say.

An empty cached block SHALL push nothing. The rehydration path for a `context` request whose session has no cached block is unchanged.

#### Scenario: A turn with nothing to inject sends nothing

- **GIVEN** a registered V2 session whose first prompt injected the first-prompt nudge
- **WHEN** the next prompt computes an empty block
- **THEN** every `context` request of that turn SHALL push no system part
- **AND** the control — a `context` request of the first turn — SHALL carry the first-prompt nudge
