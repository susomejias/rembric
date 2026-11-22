## REMOVED Requirements

### Requirement: The session-summary reminder MUST be gated on the server by three timestamps, never by a turn counter

**Reason**: The tool-work prerequisite and its conversation-exclusion scenarios are intentionally retired. Completed conversational activity now participates in reminder eligibility; retaining the old scenarios would contradict that approved behavior change.

**Migration**: Replace this requirement with the completed-activity gate below. Preserve the existing timestamps, strict summary comparison, minimum interval, RAW precedence and no-self-reminder controls; do not backfill rows or fabricate tool use.

## ADDED Requirements

### Requirement: The session-summary reminder MUST use completed activity and a minimum interval, never a turn counter

The server SHALL evaluate reminder eligibility on each completed-turn report for an active session, including `usedTools:false` conversational reports. Clients SHALL NOT decide cadence or memorability. A row without an incoming completed report SHALL NOT independently cause emission.

The four nullable persisted timestamps SHALL retain distinct meanings:

- `last_turn_report_at`: written only by active turn reports, on every report regardless of `usedTools`, with the current instant and without a forward clamp. The incoming report SHALL first capture `activityStartedAt = existing.last_turn_report_at ?? started_at`, before advancing this column. This ephemeral value is the activity anchor, not a new column.
- `last_work_at`: monotone tool-observation timestamp, advanced only on `usedTools:true`, to the later of its existing value and the captured activity anchor. `usedTools:false` SHALL leave it untouched. It SHALL NOT decide conversational reminder eligibility.
- `last_summary_at`: monotone timestamp written at the shared final-precedence write site only when a `summary` carrying `final:true` is actually stored. Neither RAW `final:false` writes nor precedence-discarded writes SHALL advance it.
- `last_nudge_at`: monotone timestamp advanced only when the server returns notice lines.

For the incoming active report, the server SHALL emit if and only if BOTH conditions hold:

1. `last_summary_at IS NULL` OR `activityStartedAt > last_summary_at`.
2. `now - COALESCE(last_nudge_at, started_at) >= NUDGE_FLOOR_MS`.

The pure gate SHALL receive the captured activity anchor explicitly under an activity-named input, not relabel it as tool work. The comparison SHALL be strict: equality suppresses. The server SHALL NOT use `last_activity_at` or report arrival as the activity anchor. Both can follow a mid-turn curated write because of transcript sync or other mutations and would incorrectly remind the complying turn.

`NUDGE_FLOOR_MS` SHALL remain one exported constant, 25 minutes, a minimum interval rather than a periodic timer. At most one notice SHALL be emitted per floor. An ignored notice SHALL NOT repeat before the floor elapses; continued completed conversation after the floor SHALL be eligible even without tools. No client counter, second cadence, model-message analysis, LLM, similarity measure or MCP-volume proxy SHALL govern this gate. Tool observation remains truthful; eligibility does not assert that anything is memorable.

An absent summary timestamp SHALL mean no known curated write; an absent tool-work timestamp SHALL no longer exclude conversation. An absent report timestamp SHALL anchor the first report at `started_at`; an absent nudge timestamp SHALL measure the first floor from `started_at`. Rows SHALL NOT be backfilled or evaluated by a timer. A lost report leaves an earlier anchor and can conservatively suppress a notice; it SHALL NOT be replaced by a fabricated report.

#### Scenario: A session that only converses is eligible without claiming tool work

- **GIVEN** an active session with no curated write whose reports all carry `usedTools:false` over three hours
- **WHEN** a completed report arrives at or after the floor
- **THEN** the server SHALL return notice lines and stamp `last_nudge_at`
- **AND** `last_work_at` SHALL remain NULL throughout
- **AND** reports inside the floor after each emission SHALL return no notice

#### Scenario: Work followed by a summary re-arms on further completed activity

- **GIVEN** a session whose curated summary is at or after the captured activity anchor and whose floor has elapsed
- **WHEN** that report is handled
- **THEN** it SHALL return no notice
- **WHEN** a later completed report has an anchor strictly after that summary and the floor has elapsed
- **THEN** it SHALL return a notice regardless of `usedTools`

#### Scenario: The turn that refreshes the summary does not then remind itself

- **GIVEN** an active session past the floor whose current turn stored a curated summary mid-turn
- **WHEN** the completed report arrives
- **THEN** the captured activity anchor SHALL be no later than `last_summary_at` and no notice SHALL be returned
- **AND** equality SHALL also suppress
- **WHEN** a later completed conversational turn has an anchor after the summary and the floor has elapsed
- **THEN** it SHALL be eligible without tool use

#### Scenario: A notice the model ignores is not repeated inside the floor

- **GIVEN** a session just returned notice lines
- **WHEN** ten further completed reports arrive inside the floor with either `usedTools` value
- **THEN** none SHALL return notice lines
- **AND** each SHALL still advance `last_turn_report_at`

#### Scenario: The first notice of a session cannot fire before one floor has elapsed

- **GIVEN** an uncurated session with no prior notice
- **WHEN** its completed report arrives at `started_at + NUDGE_FLOOR_MS - 1`
- **THEN** it SHALL return no notice
- **WHEN** a report arrives at `started_at + NUDGE_FLOOR_MS`
- **THEN** it SHALL return a notice, including with `usedTools:false`

#### Scenario: A pre-existing session upgraded into this capability starts silent

- **GIVEN** a pre-existing row whose observation timestamps are NULL
- **WHEN** no completed report arrives
- **THEN** no notice SHALL be emitted
- **WHEN** its first completed report arrives after the floor without a known curated timestamp
- **THEN** it SHALL be eligible using `started_at`, without rewriting historical summary content

#### Scenario: A `final: false` write does not count as a summary

- **GIVEN** an active session past the floor
- **WHEN** a RAW transcript is stored with `final:false` and its completed report arrives
- **THEN** `last_summary_at` SHALL remain unchanged
- **AND** the RAW write alone SHALL NOT suppress conversational eligibility

#### Scenario: A raw transcript write between the curated one and the report does not re-arm the gate

- **GIVEN** an active session past the floor whose current turn stored a curated summary
- **WHEN** its RAW sync advances `last_activity_at` after that curated write and the completed report arrives
- **THEN** the gate SHALL use the captured previous-report anchor, not `last_activity_at`
- **AND** no notice SHALL be returned
- **AND** the same timeline without the curated write SHALL return a notice when the floor permits
