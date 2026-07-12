## ADDED Requirements

### Requirement: The opencode plugin SHALL emit unified per-turn save and summary nudges on `chat.message`

`apps/plugin/.opencode-plugin/plugin.ts` SHALL push save- and session-summary-reminder text parts into `chat.message`'s `output.parts` on a per-session turn cadence, using the same model-facing channel already used for the recall nudge, driven by a single per-session turn counter.

- A per-session user-turn counter (in-memory `Map<sessionId, number>`) SHALL increment on each non-subagent user message the handler already processes.
- The handler SHALL push the **save** nudge part when `turn % SAVE_NUDGE_EVERY === 0` (`SAVE_NUDGE_EVERY = 5`).
- The handler SHALL push the **summary** nudge part when `turn === 1 || turn % SUMMARY_NUDGE_EVERY === 0` (`SUMMARY_NUDGE_EVERY = 10`).
- The save, summary, and recall nudges SHALL be mutually independent — any combination MAY fire on the same turn, each pushed as its own separate `output.parts` text part (none replaces another).
- The summary nudge text SHALL direct `memory.session_summary({title≤100, summary})` with the `Goal · Discoveries · Accomplished · Next Steps · Files` structure, byte-identical to the Claude/Codex and Hermes copies.
- Subagent sessions SHALL NOT be nudged (the handler's existing subagent guard covers this).
- The counter entry SHALL be evicted in the existing `session.deleted` cleanup.

#### Scenario: Save nudge fires every 5th user turn

- **GIVEN** a non-subagent opencode session
- **WHEN** the user submits their 5th message of the session
- **THEN** `chat.message` SHALL push the save-reminder text part into `output.parts`
- **AND** SHALL NOT push it on turns 1–4

#### Scenario: Summary nudge fires on turn 1 and every 10th user turn

- **WHEN** the user submits their 1st message of the session
- **THEN** `chat.message` SHALL push the summary-reminder text part
- **AND** SHALL push it again on the 10th turn and not on turns 2–9

#### Scenario: Save, summary, and recall nudges coexist as separate parts

- **WHEN** the 10th user message also matches the recall keyword regex
- **THEN** the recall, save, and summary nudges SHALL each be pushed as separate parts, none replacing another

#### Scenario: Subagent sessions are never nudged

- **WHEN** the message belongs to a sub-agent session
- **THEN** neither the counter nor any nudge SHALL run (early return, as today)
