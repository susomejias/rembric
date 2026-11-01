## MODIFIED Requirements

### Requirement: `POST /api/<slug>/sessions/:id/turn` MUST accept a per-turn report and return the notice lines, if any

The endpoint SHALL accept `{ usedTools: boolean, title?: string }`. `usedTools` SHALL remain required; omission SHALL return `400 { ok:false, code:'invalid_input', message }`, never default a missing observation. It SHALL continue to describe observed tool invocation (including the documented unknown-observation fail-open), not conversational eligibility. `title`, when present, SHALL be nonempty and hard-cut to `TITLE_MAX_LENGTH` rather than rejected for excess length, matching the summary route.

Authentication, path-slug resolution, cross-token masking, soft-delete refusal and archived-project refusal SHALL remain identical to existing session routes through shared middleware and guards.

In one service call the handler SHALL:

1. Capture `activityStartedAt = existing.last_turn_report_at ?? started_at` before advancing the report anchor.
2. Stamp `last_activity_at` and `last_turn_report_at` with the current instant on each active report, keeping the stale-active retirement signal alive.
3. Advance monotone `last_work_at` to the captured anchor only when `usedTools:true`; leave it untouched on false.
4. Write any provisional title under existing `final:false` precedence.
5. Evaluate `session-nudges` with the captured activity anchor regardless of `usedTools`; when it fires, stamp `last_nudge_at` and compose the existing notice.

The response SHALL be `200 { ok:true, sessionId:string, lines:string[] }`. A suppressed gate SHALL return `lines:[]`, never null or omission. A `usedTools:false` report SHALL return notice lines when conversational activity satisfies the gate. The response SHALL NOT expose summary text, section bodies or timestamps; the inventory remains the only stored-state view on this endpoint, and full reads remain MCP session retrieval.

The endpoint SHALL NOT transition status or write summary. Terminal reports SHALL succeed with `lines:[]` and stamp only `last_activity_at`, not `last_turn_report_at`, without reviving the row or altering `ended_at`. A row going terminal between read and write SHALL be refused with `session_already_ended`, not evaluated from stale state.

A repeated report inside the floor after emission SHALL NOT emit another notice because `last_nudge_at` advanced. Clients SHALL still report at most once per finished turn; no new turn identifier or stronger deduplication guarantee is introduced.

#### Scenario: A work-bearing report at a firing moment returns the notice

- **GIVEN** an active session satisfying the activity and floor conditions
- **WHEN** the client POSTs `{ usedTools:true }`
- **THEN** the response SHALL be 200 with nonempty lines
- **AND** work, activity, report and nudge timestamps SHALL be updated under their existing rules

#### Scenario: A conversation-only report can return a notice without claiming tool work

- **GIVEN** an active session with no curated summary and an elapsed floor
- **WHEN** the client POSTs `{ usedTools:false }`
- **THEN** the response SHALL be 200 with nonempty lines
- **AND** activity, report and nudge timestamps SHALL advance while `last_work_at` remains unchanged

#### Scenario: A conversation-only report below the floor returns an empty array

- **GIVEN** a session just returned a notice
- **WHEN** another conversational report arrives inside the floor
- **THEN** the response SHALL contain `lines:[]`, not null or a missing key
- **AND** activity and report timestamps SHALL update without changing work or nudge timestamps

#### Scenario: A body without usedTools is refused rather than defaulted

- **WHEN** the client POSTs `{}` or `{ title:'x' }`
- **THEN** the server SHALL return 400 invalid_input naming the missing field
- **AND** no timestamp SHALL be written

#### Scenario: An over-long title is cut, not rejected

- **WHEN** the client sends `usedTools:true` and a 400-character title
- **THEN** the response SHALL be 200 and the stored title SHALL be 100 characters

#### Scenario: A report against a terminal row is accepted and silent

- **GIVEN** an ended session
- **WHEN** a report with either boolean arrives
- **THEN** the response SHALL be 200 with `lines:[]`
- **AND** status, ended_at and all nudge-gate timestamps SHALL remain unchanged

#### Scenario: A report against a soft-deleted session is refused like every other session route

- **GIVEN** a session with deleted_at set
- **WHEN** the client POSTs a turn
- **THEN** the code and status SHALL match the existing summary route's refusal

#### Scenario: The report keeps a live session out of the stale-active sweep

- **GIVEN** an active session contacting the server only through this endpoint
- **WHEN** reports continue past the abandonment window
- **THEN** periodic retirement SHALL NOT abandon it
- **AND** an otherwise-identical session that stops reporting SHALL be retired in the same test
