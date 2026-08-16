## ADDED Requirements

### Requirement: Session rows MUST carry the four nudge-gate timestamps, three of them monotone and the turn anchor free to follow the clock

`sessions` SHALL carry `last_work_at`, `last_summary_at`, `last_nudge_at` and `last_turn_report_at`, all `timestamp_ms`, all NULLABLE, all defaulting to NULL. `session-nudges` owns which write sets each and what the gate reads from them; this requirement owns their presence, their nullability, WHICH of them are monotone, and the migrations that add them.

**NULL means "never", and it is a load-bearing value rather than a missing one.** Every row that predates the columns reads NULL on all four, and the gate is specified so that a NULL row behaves as a silent one until a client reports work. A NULL `last_turn_report_at` means "no turn has been reported yet", and the first report of a session therefore anchors on `started_at`. No backfill SHALL be performed. In particular `last_summary_at` SHALL NOT be inferred from `session_summary_versions.created_at`: a byte-identical curated re-write appends no version row (see "Every curated session-summary write MUST append a version row in the same transaction"), so the newest version's timestamp is not the moment the column was last written, and a later change retires that table.

**Three of them SHALL move forward only** — `last_work_at`, `last_summary_at` and `last_nudge_at`. A write SHALL NOT set one of those three to a value earlier than the value already stored. **No path SHALL clear ANY of the four to NULL once it holds a timestamp**, including `resume`, which clears `ended_at` and SHALL leave them alone: a session that is resumed keeps the moment its summary was last written, because that is still when it was last written.

**`last_turn_report_at` SHALL be stamped with the current instant on every report, and SHALL NOT be clamped forward.** It is the one exception and the exception is load-bearing rather than an oversight. The other three are cumulative observations — the latest moment at which work happened, a summary was stored, a notice was sent — and for those "the highest value seen" IS the value. `last_turn_report_at` is not an observation but an ANCHOR: it marks where the turn now being reported began, and the report that reads it is the same report that replaces it. Clamping it forward would leave a host whose clock steps backwards with an anchor AHEAD of a curated summary written after the step, so `last_work_at` would land later than `last_summary_at`, the gate's condition (2) would hold, and the notice would fire on exactly the turn that had just complied — the defect this column was added to remove. Measured on this tree with the clamp in place: the report following a mid-turn `memory.session_summary` returns one notice line where it must return none. Correctness here comes from the column having exactly ONE writer, not from moving forward only. The asymmetry of the two failures is what settles it: a backwards step costs at most one over-suppressed notice, bounded by the floor, while the clamped reading costs a notice fired at a model that did what it was asked.

The migration SHALL be a plain `ALTER TABLE sessions ADD COLUMN` per column. No table rebuild is required — no `CHECK`, no `NOT NULL`, no foreign key is introduced — so the rebuild dance and its `DROP TABLE` foreign-key hazard do not apply, and `PRAGMA foreign_key_check` passes trivially before `COMMIT`.

These columns SHALL be exempt from the summary/title `final` precedence machinery. They are not model-authored values and there is no writer whose claim on them could lose to another's.

#### Scenario: A populated table migrates without rewriting a row

- **GIVEN** a `sessions` table carrying rows with curated summaries, terminal statuses and soft-deletes
- **WHEN** the migration runs
- **THEN** every existing row SHALL be preserved verbatim with the new columns NULL
- **AND** `PRAGMA foreign_key_check` SHALL report no violations before `COMMIT`
- **AND** no table rebuild SHALL have occurred

#### Scenario: Resume does not reset the timestamps

- **GIVEN** session `<S>` with `status = 'ended'` and all four timestamps set
- **WHEN** `resume(<S>, { tokenId })` succeeds
- **THEN** `ended_at` SHALL be NULL and `status` SHALL be `'active'`
- **AND** `last_work_at`, `last_summary_at`, `last_nudge_at` and `last_turn_report_at` SHALL be byte-identical to their pre-resume values

#### Scenario: A stale write cannot move a timestamp backwards

- **GIVEN** session `<S>` whose `last_work_at` is `T`
- **WHEN** a write attempts to set `last_work_at` to a value earlier than `T`
- **THEN** the stored value SHALL remain `T`

#### Scenario: The turn anchor follows a clock that steps backwards, and the other three do not

- **GIVEN** session `<S>` whose `last_turn_report_at` is `T`, with `last_work_at` and `last_nudge_at` set
- **WHEN** a turn report is handled at an instant `E` earlier than `T`, because the host clock stepped backwards between two reports
- **THEN** `last_turn_report_at` SHALL be `E`
- **AND** `last_work_at` SHALL NOT have moved backwards and `last_nudge_at` SHALL be unchanged

#### Scenario: A turn that refreshes the summary after a backwards clock step is still not reminded

- **GIVEN** session `<S>` past the floor whose `last_turn_report_at` was stamped after a backwards clock step, so it reads earlier than the highest value the column has ever held
- **WHEN** the session's next turn writes a curated summary mid-turn and then reports itself with `usedTools: true`
- **THEN** no notice SHALL be returned, because `last_work_at` anchors on that earlier report and lands before `last_summary_at`
- **AND** the control SHALL pass in the same run: the identical timeline with the curated write removed SHALL return a notice, so the silence above is suppression and not an unreachable gate

#### Scenario: A report lost to an interrupted turn suppresses more, never less

- **GIVEN** two identical session timelines that differ only in that one report is never issued, as happens on a Hermes turn the user interrupts
- **WHEN** both are driven through the same turns
- **THEN** the lost-report timeline's `last_work_at` SHALL never be later than the kept-report timeline's at the same turn
- **AND** the control SHALL pass in the same run: there SHALL be a turn on which the kept-report timeline returns a notice and the lost-report one returns none

## MODIFIED Requirements

### Requirement: Sessions MUST be append-only

The system SHALL never physically delete a session row and SHALL never mutate the `agent`, `token_id`, `started_at`, or `project_id` of an existing session, EXCEPT through the operator-only physical-purge escape hatch defined in "Sessions MAY be physically purged when empty". Lifecycle changes are otherwise expressed exclusively by transitioning the `status` column among `active`, `ended`, and `abandoned`, by writing the `ended_at` column at most once **per terminal transition**, and by writing the `summary` and `title` columns subject to the `summary_final` / `title_final` precedence flags.

`ended_at` is write-once per terminal transition rather than write-once per row. It SHALL be written exactly when a row leaves `active` (`end`'s active branch, `markAbandoned`, `abandonInactiveSince`), SHALL be cleared to NULL exactly when a row re-enters `active` through `resume` (see "`AgentSessionsService.resume()` MUST return a terminal session to `active`"), and SHALL NOT be written by any other path. The invariant a reader may rely on is therefore `ended_at IS NOT NULL` if and only if `status <> 'active'`. The instant of a _previous_ terminal transition is NOT retained after a resume; a caller that needs it SHALL read `previousEndedAt` from the resume response, which is the only place it is reported.

The `deleted_at` column is exempt from immutability: it SHALL transition from NULL to a timestamp (soft-delete) or from a timestamp back to NULL (undelete) any number of times. Both transitions SHALL be guarded by the cross-token rule that already protects `end` and `writeSummary`, unless the caller is an operator-facing surface (CLI or dashboard) that sets `adminBypass: true`.

The `id` column is set exactly once at insert time. It MAY originate from a client (via `POST /api/<slug>/sessions` or `start({id})`) or be server-minted (via `memory.session_start` without an explicit id). Once written it SHALL NOT be UPDATEd.

The `summary` and `title` columns are exempt from one-write-per-lifetime immutability: they MAY be written multiple times subject to the `final` precedence rules (a `final:true` write locks against `final:false` writes; non-final writes can overwrite each other). This exemption SHALL apply irrespective of `status`, with one narrowing on terminal rows where an already-`final` column becomes immutable — see "Terminal session rows MUST accept late summary and title writes, and MUST NOT change status except through `resume`".

**A fourth class of column exists and SHALL be named rather than left implicit: the OBSERVATION TIMESTAMPS** — `last_activity_at`, `last_work_at`, `last_summary_at`, `last_nudge_at` and `last_turn_report_at`. They record when something was last observed rather than what the session contains, and they are written by many paths and locked by none. **The first four are MONOTONE and move forward only; `last_turn_report_at` is not, and follows the clock**, for the reason its own requirement states (see "Session rows MUST carry the four nudge-gate timestamps, three of them monotone and the turn anchor free to follow the clock") — it is a turn anchor rather than a cumulative observation, and clamping it forward re-arms the gate against the turn that just complied. None of the five is lifecycle state: writing one SHALL NOT transition `status`, SHALL NOT write or clear `ended_at`, and SHALL NOT be treated by any reader as evidence that a lifecycle event occurred. This class was previously unenumerated even though `last_activity_at` already belonged to it, which made an append-only reading of this requirement quietly false; naming the class is what lets the nudge-gate columns join it without weakening anything.

#### Scenario: Code path attempts to physically delete a session

- **WHEN** any service or migration emits a `DELETE FROM agent_sessions` statement from any file OTHER than `apps/server/src/services/agent-sessions.ts`
- **THEN** a CI invariant test SHALL fail and the build SHALL be rejected

#### Scenario: Code path attempts to mutate an immutable session column

- **WHEN** any service emits an `UPDATE agent_sessions SET agent = ?`, `UPDATE agent_sessions SET started_at = ?`, or `UPDATE agent_sessions SET id = ?` statement
- **THEN** a CI invariant test SHALL fail and the build SHALL be rejected

#### Scenario: Two `memory.session_end` (or `/api/.../end`) calls for the same session id

- **WHEN** `memory.session_end` (MCP) or `POST /api/<slug>/sessions/:id/end` (HTTP) is called twice on the same `(token_id, id)`
- **THEN** the second call SHALL succeed as an idempotent no-op (status already `ended`, returns the current row) and SHALL NOT mutate `ended_at`. Summary/title write attempts in the second call SHALL be honoured only if they pass the `final` precedence check.

#### Scenario: `memory.session_end` (or `/api/.../end`) on a row the sweep already abandoned

- **GIVEN** session `<S>` was flipped to `status='abandoned'` with `ended_at = E` by stale-active retirement while its client was still running
- **WHEN** that client calls `memory.session_end` (MCP) or `POST /api/<slug>/sessions/:id/end` (HTTP), with or without summary/title fields
- **THEN** the call SHALL succeed as an idempotent no-op with respect to lifecycle: `status` SHALL remain `'abandoned'` and `ended_at` SHALL remain `E`
- **AND** any summary/title fields in the body SHALL be applied subject to the `final` precedence check
- **AND** the call SHALL NOT be rejected with `session_already_ended`

#### Scenario: deleted_at transitions are tracked

- **WHEN** an operator soft-deletes a session and later undeletes it
- **THEN** `deleted_at` SHALL transition NULL → timestamp → NULL and SHALL be the only column (alongside `summary`/`title`) that may revisit its initial value

#### Scenario: Summary may be updated mid-session subject to final precedence

- **GIVEN** session `<S>` is `active` and `summary` has been written once with `final:false`
- **WHEN** another write lands with `final:false`
- **THEN** the second write SHALL overwrite `summary`
- **AND** `summary_final` SHALL remain `false`

#### Scenario: `ended_at` is cleared when a row re-enters `active`

- **GIVEN** session `<S>` with `status='ended'` and `ended_at = E`
- **WHEN** `resume(<S>, { tokenId })` succeeds
- **THEN** the row SHALL have `status='active'` and `ended_at IS NULL`
- **AND** `E` SHALL NOT be retained on any column of the row
- **AND** a later `end(<S>)` SHALL write a fresh `ended_at` rather than restoring `E`

#### Scenario: A monotone observation timestamp is not a lifecycle write

- **GIVEN** an `active` session `<S>`
- **WHEN** a per-turn report stamps `last_activity_at`, `last_work_at` and `last_nudge_at`
- **THEN** `status` SHALL still be `'active'` and `ended_at` SHALL still be NULL
- **AND** no version row SHALL be appended and no `summary` or `title` SHALL be written by that stamping alone

### Requirement: A session that ends without a curated summary MUST still leave grounded, checkable facts

When no curated summary was written, the fallback written on the agent's behalf SHALL consist of facts extracted deterministically from the session's own transcript, NOT a slice of that transcript.

The extraction SHALL emit only what is checkable without a model, and SHALL name at minimum: the files created, written or edited; the commands run, with the ones that failed identified as having failed; and the final exchange. It SHALL NOT include file diffs — the cap cannot hold them and version control already does.

Three properties are contracted. The output SHALL be traceable: every line SHALL correspond to an event in the transcript, so the fallback cannot assert something that did not happen. It SHALL be dense relative to prose, so that a fixed character budget carries more of a long session's substance. And it SHALL degrade gracefully under truncation: removing the beginning SHALL cost individual facts and SHALL NOT change the meaning of what remains.

Where a session's transcript cannot be parsed, the fallback SHALL degrade to the previous behaviour rather than fail, and SHALL NOT block or error the host.

**The extraction SHALL run on the session-close path, and SHALL NOT run per turn.** Its call site was previously the per-turn transcript sync, which `session-nudges` removes on the shell clients; the requirement is about the summary written when the agent never cooperated, which is a session-close event, so the call belongs there. Two consequences follow and are normative rather than incidental. First, the extraction is no longer on a per-turn synchronous path, where it measured ~0.5 s of `jq` per firing and 790 ms on an 8.36 MB transcript. Second, where a host allows the close event a budget tighter than every other event, the extraction SHALL be attempted inside that budget and SHALL fall through to the existing transcript formatter on any failure — an unparsed or over-budget extraction SHALL cost the facts, never the fallback.

#### Scenario: A session ends with edits and a failed command and no curated summary

- **GIVEN** a session in which two files were edited and one command exited non-zero, and `summary_final = false`
- **WHEN** the fallback is written on the agent's behalf
- **THEN** the persisted `summary` SHALL name both files and SHALL identify the failed command as having failed

#### Scenario: The fallback does not overwrite a curated summary

- **GIVEN** a session whose `summary_final = true`
- **WHEN** the fallback is written
- **THEN** the existing curated `summary` SHALL be unchanged, under the existing `final` precedence rules

#### Scenario: An unparseable transcript does not fail the host

- **GIVEN** a transcript the parser cannot read
- **WHEN** the fallback runs
- **THEN** it SHALL exit successfully, SHALL NOT block the host, and SHALL NOT write a malformed body

#### Scenario: The extraction runs once, at session close, not once per turn

- **WHEN** every call site of the fact extractor is enumerated at HEAD
- **THEN** it SHALL be reachable only from the session-close path
- **AND** no per-turn handler SHALL call it
- **AND** a host whose extractor is not implemented SHALL fall through to the transcript formatter, exactly as before this clause
