## MODIFIED Requirements

### Requirement: Session rows MUST carry the four nudge-gate timestamps, three of them monotone and the turn anchor free to follow the clock

`sessions` SHALL carry `last_work_at`, `last_summary_at`, `last_nudge_at` and `last_turn_report_at`, all `timestamp_ms`, all NULLABLE, all defaulting to NULL. `session-nudges` owns which write sets each and what the gate reads from them; this requirement owns their presence, nullability and monotonicity.

NULL SHALL mean never observed. A pre-existing row SHALL remain silent without a completed report. The first incoming completed report SHALL capture `last_turn_report_at ?? started_at` as its ephemeral activity anchor before advancing `last_turn_report_at`, whether or not tools ran. No new column, migration, backfill or historical content rewrite SHALL be required for conversational eligibility. In particular, `last_summary_at` SHALL NOT be inferred from summary text, `started_at`, `ended_at`, `last_activity_at` or the retired `session_summary_versions` table: none establishes the latest stored curated write, including byte-identical rewrites.

`last_work_at`, `last_summary_at` and `last_nudge_at` SHALL move forward only. No path SHALL clear any of the four timestamps to NULL once set, including `resume`. `last_work_at` SHALL remain tool-only; a conversational report SHALL NOT advance it to make the session eligible.

`last_turn_report_at` SHALL be stamped with the current instant on every active report and SHALL NOT be clamped forward. The captured pre-update anchor SHALL be used directly for activity eligibility, independently of monotone `last_work_at`. After a clock rollback, retaining a future high-water anchor could place activity after a complying curated write; conservative suppression is preferred to that false reminder. No other write SHALL stamp `last_turn_report_at`.

The original column-add migrations SHALL remain plain `ALTER TABLE sessions ADD COLUMN`, with no table rebuild, new CHECK, NOT NULL or foreign key, and with the existing pre-commit foreign-key check. They SHALL NOT be rerun or rewritten by this policy change. These columns SHALL remain exempt from summary/title `final` precedence because they are observations, not model-authored fields.

#### Scenario: A populated table migrates without rewriting a row

- **GIVEN** a sessions table carrying curated summaries, terminal statuses and soft-deletes
- **WHEN** the original column-add migrations run
- **THEN** existing values SHALL be preserved and the new columns SHALL be NULL
- **AND** `PRAGMA foreign_key_check` SHALL report no violations before COMMIT and no table rebuild SHALL occur

#### Scenario: Resume does not reset the timestamps

- **GIVEN** an ended session with all four timestamps set
- **WHEN** authorized resume succeeds
- **THEN** status SHALL be active and `ended_at` NULL
- **AND** all four observation timestamps SHALL be unchanged

#### Scenario: A stale write cannot move a timestamp backwards

- **GIVEN** `last_work_at` is T
- **WHEN** a write attempts to set it earlier than T
- **THEN** it SHALL remain T

#### Scenario: The turn anchor follows a clock that steps backwards, and the other three do not

- **GIVEN** `last_turn_report_at` is T with work and nudge timestamps set
- **WHEN** a report arrives at E earlier than T
- **THEN** `last_turn_report_at` SHALL become E
- **AND** `last_work_at` SHALL NOT move backwards and `last_nudge_at` SHALL remain unchanged while the floor is not elapsed

#### Scenario: A turn that refreshes the summary after a backwards clock step is still not reminded

- **GIVEN** a previous report stamped the post-rollback instant and the nudge floor permits emission
- **WHEN** the next turn stores a curated summary mid-turn and reports itself
- **THEN** no notice SHALL be returned because the captured activity anchor is no later than that summary
- **AND** the same timeline without the curated write SHALL return a notice, independent of `usedTools`

#### Scenario: A report lost to an interrupted turn suppresses more, never less

- **GIVEN** identical timelines differing only by one lost report and no differing prior notice emission
- **WHEN** the next report is evaluated against the same stored summary and elapsed floor
- **THEN** the lost-report timeline SHALL have an activity anchor no later than the kept-report timeline
- **AND** a control SHALL demonstrate a kept-report notice and lost-report silence when the stored summary lies between those anchors

#### Scenario: Conversation eligibility requires no schema or provenance mutation

- **GIVEN** an existing active session with `last_work_at` NULL
- **WHEN** its completed conversational report earns a notice
- **THEN** `last_work_at` SHALL remain NULL and no summary SHALL be fabricated
- **AND** the existing schema SHALL suffice without migration or backfill
