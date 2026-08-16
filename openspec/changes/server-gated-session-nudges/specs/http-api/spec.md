## ADDED Requirements

### Requirement: `POST /api/<slug>/sessions/:id/turn` MUST accept a per-turn report and return the notice lines, if any

The endpoint SHALL accept a JSON body `{ usedTools: boolean, title?: string }`. `usedTools` is REQUIRED; a body that omits it SHALL be rejected with `400 { ok: false, code: 'invalid_input', message }` rather than defaulted, because a defaulted value would make an old or miswired client indistinguishable from one reporting a conversation-only turn. `title`, when present, SHALL be a non-empty string; the server SHALL hard-cut it to `TITLE_MAX_LENGTH` rather than reject it, matching `POST /api/<slug>/sessions/:id/summary`'s treatment of an over-long title, because a hook script cannot react to a rejection.

Authentication, path-slug scope resolution, the soft-delete refusal and the archived-project refusal SHALL be identical to the three existing `/api/<slug>/sessions/:id/*` routes; this endpoint SHALL reuse the same middleware and the same guard helper rather than restate them.

The handler SHALL, in one service call:

1. Stamp `last_activity_at`. **This is required, not cosmetic.** It replaces the per-turn `POST /summary` that the shell clients performed before this endpoint existed, and `abandonInactiveSince` compares `COALESCE(last_activity_at, started_at)` against its cutoff — without the stamp a live session would be retired by the stale-active sweep mid-conversation.
2. Stamp `last_turn_report_at` with the current instant, on every report.
3. Stamp `last_work_at` when `usedTools` is `true`, with the reported turn's START — the row's `last_turn_report_at` as read before step 2 advances it, or `started_at` on the session's first report (`session-nudges`) — and leave it untouched when it is `false`.
4. Write `title` under the existing `final: false` precedence when the body carries one, so a model-authored title is never displaced.
5. Evaluate the notice gate (`session-nudges`) and, when it fires, stamp `last_nudge_at` and compose the notice.

The response SHALL be `200 OK` with body `{ ok: true, sessionId: string, lines: string[] }`. `lines` SHALL be an empty array when the gate does not fire — never `null` and never an omitted key, so a client can print unconditionally without a presence check. The response SHALL NOT carry the stored summary, the section bodies, or any timestamp: the notice's inventory is the only view of stored state this endpoint exposes, and a client that wants the text has `memory.session_get` over MCP.

The endpoint SHALL NOT transition `status` and SHALL NOT write `summary`. A report against a terminal row SHALL succeed, SHALL stamp nothing but `last_activity_at` — not even `last_turn_report_at`, which anchors a gate that can no longer fire — and SHALL return `lines: []` — a report is not a lifecycle event and SHALL NOT be a second path back to `active`. A row that goes terminal BETWEEN the read and the write SHALL be refused with `session_already_ended`, as `writeSummary` and `end` already are: evaluating the gate against the row the read returned would judge stale state and stamp `last_nudge_at` onto a closed session.

The endpoint SHALL be idempotent in effect for a repeated report of the same turn: two reports differ only in that the second re-stamps timestamps, and the second SHALL NOT return a notice, because the first advanced `last_nudge_at`.

#### Scenario: A work-bearing report at a firing moment returns the notice

- **GIVEN** an `active` session whose gate conditions are all satisfied
- **WHEN** a client POSTs `{ usedTools: true }` to `/api/<slug>/sessions/<S>/turn`
- **THEN** the response SHALL be `200` with `lines` of length ≥1
- **AND** `last_work_at`, `last_activity_at`, `last_turn_report_at` and `last_nudge_at` SHALL all have advanced

#### Scenario: A conversation-only report returns an empty array, not a missing key

- **GIVEN** the same session
- **WHEN** a client POSTs `{ usedTools: false }`
- **THEN** the response SHALL be `200` with `lines: []`
- **AND** `last_activity_at` and `last_turn_report_at` SHALL have advanced while `last_work_at` and `last_nudge_at` SHALL be unchanged

#### Scenario: A body without `usedTools` is refused rather than defaulted

- **WHEN** a client POSTs `{}` or `{ title: 'x' }`
- **THEN** the server SHALL respond `400` with `{ ok: false, code: 'invalid_input', message }` naming the missing field
- **AND** no timestamp SHALL be written

#### Scenario: An over-long title is cut, not rejected

- **WHEN** a client POSTs `{ usedTools: true, title: 'A'.repeat(400) }`
- **THEN** the response SHALL be `200`
- **AND** the stored `title` SHALL be 100 characters

#### Scenario: A report against a terminal row is accepted and silent

- **GIVEN** session `<S>` with `status = 'ended'`
- **WHEN** a client POSTs `{ usedTools: true }`
- **THEN** the response SHALL be `200` with `lines: []`
- **AND** `status` SHALL still be `'ended'` and `ended_at` SHALL be unchanged

#### Scenario: A report against a soft-deleted session is refused like every other session route

- **GIVEN** session `<S>` with `deleted_at` set
- **WHEN** a client POSTs to its `/turn`
- **THEN** the response SHALL carry the same code and status the existing `/summary` route returns for a soft-deleted session

#### Scenario: The report keeps a live session out of the stale-active sweep

- **GIVEN** an `active` session whose only per-turn contact with the server is this endpoint
- **WHEN** turns continue past the abandonment window with a report on each
- **THEN** the periodic retirement pass SHALL NOT mark the row `abandoned`
- **AND** the control SHALL pass in the same run: an otherwise-identical session that stops reporting SHALL be retired
