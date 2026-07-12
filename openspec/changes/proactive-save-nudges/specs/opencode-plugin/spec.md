## ADDED Requirements

### Requirement: The opencode plugin SHALL emit a periodic save nudge on `chat.message`

`apps/plugin/.opencode-plugin/plugin.ts` SHALL push a save-reminder text part into `chat.message`'s `output.parts` on a per-session turn cadence, using the same model-facing channel already used for the recall nudge.

- A per-session user-turn counter (in-memory `Map<sessionId, number>`) SHALL increment on each non-subagent user message the handler already processes.
- Every 5th such turn, the handler SHALL push `{type:'text', text:'<terse save nudge>'}`.
- The save nudge SHALL be independent of the recall nudge — both MAY fire on the same turn.
- Subagent sessions SHALL NOT be nudged (the handler's existing subagent guard covers this).
- The counter entry SHALL be evicted in the existing `session.deleted` cleanup.

#### Scenario: Save nudge fires every 5th user turn

- **GIVEN** a non-subagent opencode session
- **WHEN** the user submits their 5th message of the session
- **THEN** `chat.message` SHALL push the save-reminder text part into `output.parts`
- **AND** SHALL NOT push it on turns 1–4

#### Scenario: Recall and save nudges coexist

- **WHEN** the 5th user message also matches the recall keyword regex
- **THEN** both the recall nudge and the save nudge SHALL be pushed as separate parts

#### Scenario: Subagent sessions are never nudged

- **WHEN** the message belongs to a sub-agent session
- **THEN** neither the counter nor the nudge SHALL run (early return, as today)
