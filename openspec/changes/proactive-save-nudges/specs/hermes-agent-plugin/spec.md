## ADDED Requirements

### Requirement: The Hermes provider SHALL emit per-turn and pre-compaction save reminders

The Hermes `MemoryProvider` (`apps/plugin/.hermes-plugin/__init__.py`) SHALL reinforce saving through `prefetch()` (whose return is injected as `<memory-context>` every turn) and `on_turn_start()` (which observes `remaining_tokens`). This is the only per-turn save reinforcement Hermes has, since it does not consume the server's `initialize.instructions`.

- `on_turn_start(turn_number, message, **kwargs)` SHALL be added AND listed in `plugin.yaml`'s `hooks:` array (the array gates override invocation). It SHALL record the turn number and, when `remaining_tokens` is an int below `_COMPACTION_TOKEN_FLOOR` and no urgent reminder has yet fired this session, arm an urgent flag.
- `prefetch()` SHALL continue to return the cached recall context and SHALL additionally:
  - when the urgent flag is armed, emit a pre-compaction save reminder instead of the normal hint, then mark itself warned (fires at most once per session);
  - otherwise, append a terse save-hint line every 3rd turn.
- `prefetch()` SHALL remain inline (no network call), and SHALL return a non-empty hint even when the recall cache is empty.
- The urgent/warned flags and the turn counter SHALL reset on session end and session switch.

#### Scenario: prefetch appends the normal save hint on cadence

- **GIVEN** an initialized Hermes provider with an empty recall cache
- **WHEN** `prefetch` is called on the 3rd turn with no low-token signal
- **THEN** it SHALL return a string containing the terse save-hint even though the recall cache is empty

#### Scenario: on_turn_start arms the urgent reminder only below the floor

- **WHEN** `on_turn_start` is called with `remaining_tokens` above `_COMPACTION_TOKEN_FLOOR`
- **THEN** no urgent flag SHALL be armed
- **WHEN** it is later called with `remaining_tokens` below the floor
- **THEN** the urgent flag SHALL be armed

#### Scenario: The pre-compaction reminder fires once

- **GIVEN** the urgent flag is armed
- **WHEN** `prefetch` is next called
- **THEN** it SHALL return the urgent pre-compaction save reminder and clear the armed flag
- **AND** a subsequent `prefetch` on a later low-token turn SHALL NOT repeat the urgent reminder (warned once per session)
