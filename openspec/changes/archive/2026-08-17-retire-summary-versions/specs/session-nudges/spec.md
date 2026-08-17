## MODIFIED Requirements

### Requirement: The session-summary reminder MUST be gated on the server by three timestamps, never by a turn counter

The decision to remind a model to refresh its session summary SHALL be taken by the server, from state on the session row, and SHALL NOT be taken by any client from a turn count. A turn count does not answer the question the reminder exists to ask — whether anything has happened since the summary was last written — and no client can answer it either, because no client knows when the stored summary was last written.

`sessions` SHALL carry four nullable timestamps, whose write rules are normative and whose meanings SHALL NOT be conflated with `last_activity_at`:

- **`last_turn_report_at`** — the moment the most recent turn report arrived. Written by the turn report and by NOTHING else, on every report regardless of `usedTools`. It exists so that `last_work_at` below has an anchor with a single writer; a column many paths write cannot answer "when did this turn begin".
- **`last_work_at`** — the START of the most recent turn a client reported as having used a tool, which is the row's `last_turn_report_at` as it stood BEFORE that report advanced it (`started_at` where it is NULL, i.e. on the session's first report). Set only by the turn report ("Every client MUST report each finished turn to the server and print what it is handed back"), and only when that report carries `usedTools: true`. **It SHALL NOT be stamped with the moment the report arrives.** The report is issued at the END of the turn, while a curated `memory.session_summary` written during that turn stamps `last_summary_at` MID-turn — and is itself an MCP call the client observes as tool use — so stamping `now` would make condition (2) below true forever after the first curated write, degrading the gate into a bare `NUDGE_FLOOR_MS` timer that fires on conversation-only turns too.

  **`last_activity_at` SHALL NOT be used as that anchor**, notwithstanding that it, too, sits on the row and is nominally "the turn's start". It is advanced by the per-turn transcript sync (which advances it even on a write precedence discards) and by `memory.save`, `memory.confirm`, `memory.save_prompt` and `memory.capture_passive` — so on a client that posts the raw transcript and then the report within one turn, as the Hermes provider does sequentially on every turn, it reads LATER than the mid-turn curated write and the notice fires on exactly the turn that complied. A dedicated column with one writer is immune to that by construction, and its failure mode is the safe direction: a report lost to an interrupted turn leaves the anchor further back, which suppresses more, never less.

- **`last_summary_at`** — the moment the session's curated summary was last STORED. Set by the same single site that folds per-field `final` precedence into an update `set`, on exactly those writes that store a `summary` carrying `final: true` (`sessions`, "Terminal session rows MUST accept late summary and title writes, and MUST NOT change status except through `resume`", which requires that place to be shared by all three write paths). It SHALL NOT be set by a `final: false` write and SHALL NOT be set by a write precedence discards.
- **`last_nudge_at`** — the moment the notice was last emitted to a client. Set when, and only when, the server returns notice lines in a turn-report response.

The notice SHALL be emitted for a turn report when ALL THREE hold:

1. `last_work_at IS NOT NULL`,
2. `last_summary_at IS NULL` OR `last_work_at > last_summary_at`,
3. `now - COALESCE(last_nudge_at, started_at) >= NUDGE_FLOOR_MS`.

Condition (2)'s comparison is STRICT, and that is load-bearing rather than incidental: the curated write is normally the last activity of the turn that made it, so the state such a turn produces is `last_work_at == last_summary_at`, and a `>=` there would fire on exactly the turn that just complied.

The NULL readings are normative rather than incidental, because they decide the first firing of every session: an absent `last_summary_at` means "never written" and satisfies (2); an absent `last_work_at` means "no work has been reported" and fails (1), so a session that only converses is never reminded; an absent `last_nudge_at` measures the floor from `started_at`, so the earliest a notice can fire is one floor after the session began.

`NUDGE_FLOOR_MS` SHALL be a single exported constant and SHALL be a MINIMUM INTERVAL rather than a period: condition (2) means nothing fires without new work, so the floor bounds the notice from above and work bounds it from below. **At most one notice SHALL be emitted per floor.** A notice the model does not act on SHALL NOT be repeated before the next floor elapses — condition (3) alone guarantees this, because `last_nudge_at` advances on emission and not on compliance.

The gate SHALL be a pure function of the row and the current time. It SHALL NOT consult the model's messages, any LLM, any similarity measure, or Rembric's own MCP call volume. Ranking a session's memory traffic as a proxy for work is the failure mode this rule exists to avoid: a turn that edits eight files without calling a memory tool is, to the server, identical to a turn of conversation, so a server-side proxy goes quiet exactly when the reminder is most needed.

#### Scenario: A session that only converses is never reminded

- **GIVEN** a session whose every turn report carried `usedTools: false`, over three hours
- **WHEN** each report is handled
- **THEN** `last_work_at` SHALL remain `NULL`
- **AND** no report SHALL return notice lines

#### Scenario: Work followed by a summary re-arms only on further work

- **GIVEN** a session with `last_work_at` set, `last_summary_at` set later than it, and `last_nudge_at` older than `NUDGE_FLOOR_MS`
- **WHEN** a turn report arrives carrying `usedTools: false`
- **THEN** no notice SHALL be returned, because condition (2) fails
- **WHEN** a later report carries `usedTools: true` and the floor is still elapsed
- **THEN** a notice SHALL be returned

#### Scenario: The turn that refreshes the summary does not then remind itself

- **GIVEN** an `active` session past the floor whose current turn called `memory.session_summary`, so `last_summary_at` is that mid-turn moment
- **WHEN** that turn's report arrives carrying `usedTools: true`, as it must, since the curated call is itself tool use
- **THEN** `last_work_at` SHALL be the turn's start and therefore no later than `last_summary_at`
- **AND** no notice SHALL be returned
- **WHEN** the next turn is conversation only
- **THEN** no notice SHALL be returned
- **WHEN** a later turn does work without refreshing the summary and reports it
- **THEN** a notice SHALL be returned

#### Scenario: A notice the model ignores is not repeated inside the floor

- **GIVEN** a session that has just been returned a notice, so `last_nudge_at` is `now`
- **WHEN** the next ten turn reports arrive, every one carrying `usedTools: true`, all inside `NUDGE_FLOOR_MS`
- **THEN** none SHALL return notice lines
- **AND** `last_work_at` SHALL still advance on each of them

#### Scenario: The first notice of a session cannot fire before one floor has elapsed

- **GIVEN** a session created `NUDGE_FLOOR_MS - 1` milliseconds ago, with `last_nudge_at IS NULL`
- **WHEN** a turn report carrying `usedTools: true` arrives
- **THEN** no notice SHALL be returned
- **WHEN** a further report arrives after `started_at + NUDGE_FLOOR_MS`
- **THEN** a notice SHALL be returned

#### Scenario: A pre-existing session upgraded into this capability starts silent

- **GIVEN** a session row that predates the three columns, so all three are `NULL`, and whose stored `summary` is a curated six-section document
- **WHEN** the server evaluates the gate before any turn report has arrived
- **THEN** no notice SHALL be emitted, because `last_work_at IS NULL`

#### Scenario: A `final: false` write does not count as a summary

- **GIVEN** a session with `last_work_at` set
- **WHEN** a `final: false` transcript write stores a `summary`
- **THEN** `last_summary_at` SHALL be unchanged
- **AND** the gate's condition (2) SHALL still hold

#### Scenario: A raw transcript write between the curated one and the report does not re-arm the gate

- **GIVEN** an `active` session past the floor whose current turn called `memory.session_summary`, so `last_summary_at` is that mid-turn moment
- **WHEN** the client then stores its raw transcript with a `final: false` write, advancing `last_activity_at` past `last_summary_at`
- **AND** the turn's report arrives carrying `usedTools: true`
- **THEN** `last_work_at` SHALL be the previous report's arrival, which is before the curated write
- **AND** no notice SHALL be returned
