## ADDED Requirements

### Requirement: The Hermes provider SHALL emit unified per-turn save and summary reminders, plus a pre-compaction save reminder

The Hermes `MemoryProvider` (`apps/plugin/.hermes-plugin/__init__.py`) SHALL reinforce both saving and curation through `prefetch()` (whose return is injected as `<memory-context>` every turn) and `on_turn_start()` (which observes `remaining_tokens`), reusing the `_turn_number` counter. This is the only per-turn reinforcement Hermes has, since it does not consume the server's `initialize.instructions`.

- `on_turn_start(turn_number, message, **kwargs)` SHALL be listed in `plugin.yaml`'s `hooks:` array (the array gates override invocation). It SHALL record the turn number and, when `remaining_tokens` is an int below `_COMPACTION_TOKEN_FLOOR` and no urgent reminder has yet fired this session, arm an urgent flag.
- `prefetch()` SHALL return the cached recall context and SHALL additionally append, as separate lines:
  - the **save** hint when `_turn_number % _SAVE_HINT_EVERY == 0` (`_SAVE_HINT_EVERY = 5`);
  - the **summary** hint when `_turn_number == 1` OR `_turn_number % _SUMMARY_HINT_EVERY == 0` (`_SUMMARY_HINT_EVERY = 10`);
  - when the urgent flag is armed, the **urgent pre-compaction** save reminder INSTEAD of the normal save hint, then mark itself warned (fires at most once per session). The urgent reminder and the summary hint are independent — both MAY appear.
- The save, summary, and urgent reminders SHALL be mutually independent lines; none SHALL overwrite another.
- The summary hint text SHALL direct `memory.session_summary({title≤100, summary})` with the `Goal · Discoveries · Accomplished · Next Steps · Files` structure, byte-identical to the Claude/Codex and opencode copies.
- `prefetch()` SHALL remain inline (no network call) and SHALL return a non-empty hint even when the recall cache is empty.
- The urgent/warned flags and the turn counter SHALL reset on session end and session switch.

#### Scenario: prefetch appends the save hint every 5th turn

- **GIVEN** an initialized Hermes provider with an empty recall cache
- **WHEN** `prefetch` is called on the 5th turn with no low-token signal
- **THEN** it SHALL return a string containing the terse save hint even though the recall cache is empty

#### Scenario: prefetch appends the summary hint on turn 1 and every 10th turn

- **WHEN** `prefetch` is called on the 1st turn
- **THEN** it SHALL return a string containing the `memory.session_summary` hint
- **AND** SHALL append it again on the 10th turn and not on turns 2–9

#### Scenario: save and summary hints coexist as separate lines

- **GIVEN** a turn on which both the save cadence (`%5`) and the summary cadence (`%10`) apply
- **WHEN** `prefetch` is called
- **THEN** the returned string SHALL contain both the save hint line and the summary hint line, neither replacing the other

#### Scenario: on_turn_start arms the urgent reminder only below the floor

- **WHEN** `on_turn_start` is called with `remaining_tokens` above `_COMPACTION_TOKEN_FLOOR`
- **THEN** no urgent flag SHALL be armed
- **WHEN** it is later called with `remaining_tokens` below the floor
- **THEN** the urgent flag SHALL be armed

#### Scenario: The pre-compaction reminder fires once and does not suppress the summary hint

- **GIVEN** the urgent flag is armed
- **WHEN** `prefetch` is next called on a summary-firing turn
- **THEN** it SHALL return the urgent pre-compaction save reminder (in place of the normal save hint) AND MAY also include the summary hint
- **AND** a subsequent `prefetch` on a later low-token turn SHALL NOT repeat the urgent reminder (warned once per session)
