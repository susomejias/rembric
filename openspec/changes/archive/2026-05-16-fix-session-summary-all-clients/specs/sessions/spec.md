## ADDED Requirements

### Requirement: Session rows MUST carry a title column with write-once-final precedence

The `sessions` table SHALL gain a nullable `title TEXT` column and two boolean precedence columns: `summary_final` and `title_final` (default `false`). The title SHALL be initialised at row creation with a placeholder of the form `basename(cwd) · HH:MM UTC` (or `session · HH:MM UTC` when `cwd` is unavailable), stored with `title_final = false`.

`AgentSessionsService.ensure(...)` (the HTTP-path constructor) SHALL compute and write the placeholder title atomically with the row insert. `AgentSessionsService.start(...)` (the MCP-path constructor) SHALL do the same.

Writes that update `summary` or `title` carrying `final:true` SHALL flip the corresponding `_final` column to `true`. A subsequent write carrying `final:false` SHALL be a no-op for the corresponding field. A subsequent write carrying `final:true` SHALL replace the value (last-final-wins for admin/manual edits in future scope).

#### Scenario: Row insert writes placeholder title

- **WHEN** `ensure({id, cwd: '/Users/jane/projects/rembric', ...})` is called at 22:14 UTC and the row does not exist
- **THEN** the inserted row SHALL have `title = 'rembric · 22:14 UTC'` and `title_final = false`

#### Scenario: Final summary write blocks later non-final summary write

- **GIVEN** session `<S>` whose `summary` was written with `final:true` and `summary_final = true`
- **WHEN** another call attempts to write `summary` with `final:false`
- **THEN** the `summary` column SHALL remain unchanged
- **AND** `summary_final` SHALL remain `true`

#### Scenario: Non-final overwrite of placeholder title

- **GIVEN** session `<S>` with the placeholder title and `title_final = false`
- **WHEN** another call writes `title` with `final:false`
- **THEN** the `title` column SHALL be overwritten with the new value
- **AND** `title_final` SHALL remain `false`

## MODIFIED Requirements

### Requirement: Sessions MUST be append-only

The system SHALL never physically delete a session row and SHALL never mutate the `agent`, `token_id`, `started_at`, or `project_id` of an existing session. Lifecycle changes are expressed exclusively by transitioning the `status` column among `active`, `ended`, and `abandoned`, by writing the `ended_at` column at most once, and by writing the `summary` and `title` columns subject to the `summary_final` / `title_final` precedence flags.

The `deleted_at` column is exempt from immutability: it SHALL transition from NULL to a timestamp (soft-delete) or from a timestamp back to NULL (undelete) any number of times. Both transitions SHALL be guarded by the cross-token rule that already protects `end` and `summarize`, unless the caller is an operator-facing surface (CLI or dashboard) that sets `adminBypass: true`.

The `id` column is set exactly once at insert time. It MAY originate from a client (via `POST /api/<slug>/sessions` or `start({id})`) or be server-minted (via `memory.session_start` without an explicit id). Once written it SHALL NOT be UPDATEd.

The `summary` and `title` columns are exempt from one-write-per-lifetime immutability: they MAY be written multiple times subject to the `final` precedence rules (a `final:true` write locks against `final:false` writes; non-final writes can overwrite each other).

#### Scenario: Code path attempts to physically delete a session

- **WHEN** any service or migration emits a `DELETE FROM agent_sessions` statement
- **THEN** a CI invariant test SHALL fail and the build SHALL be rejected

#### Scenario: Code path attempts to mutate an immutable session column

- **WHEN** any service emits an `UPDATE agent_sessions SET agent = ?`, `UPDATE agent_sessions SET started_at = ?`, or `UPDATE agent_sessions SET id = ?` statement
- **THEN** a CI invariant test SHALL fail and the build SHALL be rejected

#### Scenario: Two `memory.session_end` (or `/api/.../end`) calls for the same session id

- **WHEN** `memory.session_end` (MCP) or `POST /api/<slug>/sessions/:id/end` (HTTP) is called twice on the same `(token_id, id)`
- **THEN** the second call SHALL succeed as an idempotent no-op (status already `ended`, returns the current row) and SHALL NOT mutate `ended_at`. Summary/title write attempts in the second call SHALL be honoured only if they pass the `final` precedence check.

#### Scenario: deleted_at transitions are tracked

- **WHEN** an operator soft-deletes a session and later undeletes it
- **THEN** `deleted_at` SHALL transition NULL → timestamp → NULL and SHALL be the only column (alongside `summary`/`title`) that may revisit its initial value

#### Scenario: Summary may be updated mid-session subject to final precedence

- **GIVEN** session `<S>` is `active` and `summary` has been written once with `final:false`
- **WHEN** another write lands with `final:false`
- **THEN** the second write SHALL overwrite `summary`
- **AND** `summary_final` SHALL remain `false`

### Requirement: A session summary MUST follow the documented structure

When `memory.session_summary` is called, the submitted `summary` SHALL be persisted in the session row's `summary` column. The tool description SHALL document the canonical structure (Goal / Discoveries / Accomplished / Next Steps / Relevant Files), but the server SHALL NOT enforce the layout — agents may submit free-form text.

The `memory.session_summary` tool SHALL NOT transition the session to `ended`. The tool writes `summary` (and optionally `title`) only, marking both as `final:true`. The dedicated `memory.session_end` tool (or `POST /sessions/<id>/end`) is the sole transition.

The tool SHALL accept an optional `title?: string` (≤100 chars) which when present SHALL be written to the `title` column with `final:true` precedence.

#### Scenario: `memory.session_summary` is called with a non-empty summary

- **WHEN** the agent submits `{summary: "Goal: …"}` (no title)
- **THEN** the server SHALL set `summary` and `summary_final = true` atomically; `ended_at` and `status` SHALL remain unchanged; the response SHALL be `{ ok: true, sessionId }`

#### Scenario: `memory.session_summary` is called with summary and title

- **WHEN** the agent submits `{summary: "Goal: …", title: "Fix login bug"}`
- **THEN** the server SHALL set `summary`, `summary_final = true`, `title`, and `title_final = true` atomically; `ended_at` and `status` SHALL remain unchanged

#### Scenario: `memory.session_summary` is called with an empty summary

- **WHEN** the agent submits a `summary` string of length 0 or only whitespace
- **THEN** the call SHALL be rejected with code `invalid_input` and SHALL NOT mutate the row

#### Scenario: `memory.session_summary` is called with a title longer than 100 chars

- **WHEN** the agent submits `{summary: "…", title: "A".repeat(101)}`
- **THEN** the call SHALL be rejected with code `invalid_input` and SHALL NOT mutate the row

#### Scenario: `memory.session_summary` is called twice; the second call wins because both are final

- **GIVEN** session `<S>` is `active` with summary "A" written via a prior `memory.session_summary` (final:true)
- **WHEN** the agent calls `memory.session_summary({summary: "B"})` again
- **THEN** `summary` SHALL be replaced with "B" (last-final-wins among final writes)
- **AND** the response SHALL succeed
