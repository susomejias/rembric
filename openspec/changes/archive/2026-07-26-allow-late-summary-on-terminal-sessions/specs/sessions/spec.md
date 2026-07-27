## ADDED Requirements

### Requirement: Terminal session rows MUST accept late summary and title writes

A session row whose `status` is `ended` or `abandoned` SHALL accept `summary` and `title` writes for the remainder of its life, with no time limit relative to `ended_at`. This SHALL hold for every write path that mutates those columns — `AgentSessionsService.writeSummary`, `AgentSessionsService.end`, and therefore `POST /api/<slug>/sessions/:id/summary`, `POST /api/<slug>/sessions/:id/end`, `memory.session_summary` and `memory.session_end` — so that no two of them disagree about the same row.

Late writes SHALL be subject to the existing `summary_final` / `title_final` precedence rules, unchanged: a `final:true` write replaces the value and lifts the flag; a `final:false` write against an already-`final` column is silently skipped and is NOT an error. The cap precondition (`SUMMARY_MAX_CHARS`), the `NUL`-byte rejection, the `title` length bound, the cross-token mask (`session_not_found`), the project-mismatch mask (`session_not_found`) and the soft-delete rejection (`session_deleted`) SHALL all continue to be evaluated exactly as on an `active` row, and SHALL be evaluated BEFORE any column is written.

A late write SHALL NOT mutate `status`, `ended_at`, or `last_activity_at`. In particular `end()` on an `abandoned` row SHALL apply the summary/title writes and SHALL NOT flip `status` to `'ended'` and SHALL NOT write `ended_at`: `ended_at` remains write-once and the retirement sweep's classification of how the session died stands. `last_activity_at` is deliberately excluded because it exists solely to drive stale-active retirement and transport resolution, both of which filter `status = 'active'`.

The status FSM SHALL remain `active → ended | abandoned` with both non-`active` states terminal. No path SHALL transition a session back to `active`, and no path SHALL write `ended_at` on a row that already has one. Both SHALL be enforced by CI invariant tests, not by convention.

When a late write leaves every field unchanged (because precedence skipped all of them), the call SHALL return the existing row as a success and SHALL NOT emit an `UPDATE`.

#### Scenario: Late curated summary on an abandoned session

- **GIVEN** session `<S>` with `status='abandoned'`, `ended_at = E`, `last_activity_at = L`, `summary_final = false`
- **WHEN** `agentSessions.writeSummary(<S>, { tokenId: 'T', summary: 'Goal · Discoveries · …', title: 'Fix the reaper', final: true })` is called
- **THEN** the row SHALL have the new `summary` with `summary_final = true` and the new `title` with `title_final = true`
- **AND** `status` SHALL still be `'abandoned'`, `ended_at` SHALL still be `E`, and `last_activity_at` SHALL still be `L`
- **AND** the call SHALL return the updated row rather than throwing `session_already_ended`

#### Scenario: Late curated summary on an ended session

- **GIVEN** session `<S>` with `status='ended'`, `ended_at = E`, `last_activity_at = L`, `summary_final = false`
- **WHEN** `agentSessions.writeSummary(<S>, { tokenId: 'T', summary: 'late but curated', final: true })` is called
- **THEN** the row SHALL have `summary = 'late but curated'` and `summary_final = true`
- **AND** `status`, `ended_at` and `last_activity_at` SHALL be unchanged

#### Scenario: A per-turn raw transcript sync cannot clobber a curated summary on a terminal row

- **GIVEN** session `<S>` with `status='abandoned'` (or `'ended'`), `summary = 'curated'` and `summary_final = true`
- **WHEN** `writeSummary(<S>, { tokenId: 'T', summary: '<raw transcript>', final: false })` is called (the `Stop`-hook transcript sync)
- **THEN** the call SHALL succeed and the row's `summary` SHALL remain `'curated'` with `summary_final = true`
- **AND** no `UPDATE` SHALL be emitted for the row
- **AND** `status`, `ended_at` and `last_activity_at` SHALL be unchanged

#### Scenario: `end()` on an abandoned row writes the summary without changing the status

- **GIVEN** session `<S>` with `status='abandoned'` and `ended_at = E` set by the retirement sweep
- **WHEN** `agentSessions.end(<S>, { tokenId: 'T', summary: 'closing notes', final: true })` is called
- **THEN** the row SHALL have `summary = 'closing notes'` with `summary_final = true`
- **AND** `status` SHALL remain `'abandoned'` (NOT `'ended'`) and `ended_at` SHALL remain `E`
- **AND** the call SHALL NOT throw `session_already_ended`

#### Scenario: A late write is unbounded in time

- **GIVEN** session `<S>` with `status='abandoned'` whose `ended_at` is 30 days in the past
- **WHEN** a `summary` write arrives with `final:true`
- **THEN** it SHALL be applied — there SHALL be no lateness window, and no configuration value SHALL exist that can reject a write for being too late

#### Scenario: A late curated summary reaches the next session's context

- **GIVEN** session `<S>` with `status='abandoned'`, `deleted_at IS NULL`, and no curated summary
- **WHEN** a `summary` write lands with `final:true`, and a subsequent `memory.context` call resolves the same scope
- **THEN** `<S>` SHALL appear among the recent sessions, because the context-surfacing predicate keys on `summary IS NOT NULL AND summary_final = 1` and applies no `status` filter

#### Scenario: A late write on a soft-deleted terminal row is still rejected

- **GIVEN** session `<S>` with `status='abandoned'` and `deleted_at IS NOT NULL`
- **WHEN** a `summary` write arrives on any path
- **THEN** it SHALL be rejected with `session_deleted` and the row SHALL NOT be mutated

#### Scenario: A late write for a different token is still masked

- **GIVEN** session `<S>` with `status='abandoned'` owned by token `T1`
- **WHEN** token `T2` attempts a `summary` write on `<S>`
- **THEN** it SHALL be rejected with `session_not_found` (never `forbidden`, never `session_already_ended`) and the row SHALL NOT be mutated

#### Scenario: No path revives a terminal session

- **WHEN** any file under `apps/server/src/` emits an update that sets `sessions.status` to `'active'` on an existing row
- **THEN** a CI invariant test SHALL fail and the build SHALL be rejected

#### Scenario: No path rewrites `ended_at`

- **WHEN** any code path writes `ended_at` on a row whose `ended_at` is already non-NULL
- **THEN** a CI invariant test SHALL fail and the build SHALL be rejected

## MODIFIED Requirements

### Requirement: Sessions MUST be append-only

The system SHALL never physically delete a session row and SHALL never mutate the `agent`, `token_id`, `started_at`, or `project_id` of an existing session, EXCEPT through the operator-only physical-purge escape hatch defined in "Sessions MAY be physically purged when empty". Lifecycle changes are otherwise expressed exclusively by transitioning the `status` column among `active`, `ended`, and `abandoned`, by writing the `ended_at` column at most once, and by writing the `summary` and `title` columns subject to the `summary_final` / `title_final` precedence flags.

The `deleted_at` column is exempt from immutability: it SHALL transition from NULL to a timestamp (soft-delete) or from a timestamp back to NULL (undelete) any number of times. Both transitions SHALL be guarded by the cross-token rule that already protects `end` and `summarize`, unless the caller is an operator-facing surface (CLI or dashboard) that sets `adminBypass: true`.

The `id` column is set exactly once at insert time. It MAY originate from a client (via `POST /api/<slug>/sessions` or `start({id})`) or be server-minted (via `memory.session_start` without an explicit id). Once written it SHALL NOT be UPDATEd.

The `summary` and `title` columns are exempt from one-write-per-lifetime immutability: they MAY be written multiple times subject to the `final` precedence rules (a `final:true` write locks against `final:false` writes; non-final writes can overwrite each other). This exemption SHALL apply irrespective of `status` — see "Terminal session rows MUST accept late summary and title writes".

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

### Requirement: Session summary writes MUST be capped at `SUMMARY_MAX_CHARS`

The `AgentSessionsService` SHALL expose a single canonical constant `SUMMARY_MAX_CHARS` and SHALL reject any `summary` argument whose `String.prototype.length` exceeds it. The cap SHALL be enforced **solely in the server** — there SHALL be no SQLite `CHECK` constraint that pins `summary` length to the cap value. The `CHECK (length(summary) <= 2000)` previously introduced in migration `0011` SHALL be removed by a table-rebuild migration. A database `CHECK` MAY remain only as a generous pathological-size guard (a value far above any plausible `SUMMARY_MAX_CHARS`, e.g. 1 MB) that does NOT track or pin the operative cap; changing `SUMMARY_MAX_CHARS` SHALL NOT require a database migration.

`SUMMARY_MAX_CHARS` SHALL be set high enough to carry a rich handoff summary (the design records the chosen value). The constant SHALL remain the single source of truth, exported and imported by the MCP zod schema (`apps/server/src/mcp/session-tools.ts`) and by the HTTP-layer truncation helper, so no layer can drift from the service-level cap.

The cap precondition SHALL be enforced before the `summary_final` precedence rule is evaluated, and before the row's `status` is consulted, by every write path that mutates `sessions.summary`:

- `writeSummary({ summary, ... })`
- `end({ summary, ... })`
- `summarize({ summary })` (back-compat wrapper)

When `summary.length > SUMMARY_MAX_CHARS`, the service SHALL throw `DomainError('invalid_input', message)` where `message` SHALL contain the decimal string of `SUMMARY_MAX_CHARS` so callers (including the MCP tool envelope and HTTP handler) can surface the cap to the client without re-encoding it. The row SHALL NOT be mutated and `summary_final` SHALL NOT be lifted by a rejected call. This SHALL hold identically for `active` and terminal rows.

#### Scenario: `writeSummary` rejects a summary of `SUMMARY_MAX_CHARS + 1`

- **GIVEN** an active session row owned by token `T`
- **WHEN** `agentSessions.writeSummary(sessionId, { tokenId: 'T', summary: 'a'.repeat(SUMMARY_MAX_CHARS + 1) })` is called
- **THEN** the call SHALL throw `DomainError('invalid_input', <message>)` whose message contains the decimal string of `SUMMARY_MAX_CHARS`
- **AND** the row in `sessions` SHALL remain unchanged (no summary written, `summary_final` unchanged)

#### Scenario: `writeSummary` rejects an oversized summary on a terminal row too

- **GIVEN** a session row owned by token `T` with `status='abandoned'`
- **WHEN** `agentSessions.writeSummary(sessionId, { tokenId: 'T', summary: 'a'.repeat(SUMMARY_MAX_CHARS + 1) })` is called
- **THEN** the call SHALL throw `DomainError('invalid_input', <message>)` containing the cap value — the cap is checked before `status`, so admitting late writes SHALL NOT create an uncapped path
- **AND** the row SHALL remain unchanged

#### Scenario: `end` rejects an oversized summary atomically with the transition

- **GIVEN** an active session row owned by token `T`
- **WHEN** `agentSessions.end(sessionId, { tokenId: 'T', summary: 'a'.repeat(SUMMARY_MAX_CHARS + 1) })` is called
- **THEN** the call SHALL throw `DomainError('invalid_input', <message>)` containing the cap value
- **AND** the row SHALL remain `status='active'`, `ended_at=NULL`, summary unchanged (the rejection precedes the transition)

#### Scenario: `summarize` (legacy wrapper) inherits the cap

- **GIVEN** an active session row owned by token `T`
- **WHEN** `agentSessions.summarize(sessionId, { tokenId: 'T', summary: 'a'.repeat(SUMMARY_MAX_CHARS + 1) })` is called
- **THEN** the call SHALL throw `DomainError('invalid_input', <message>)` containing the cap value and the row SHALL remain unchanged

#### Scenario: `writeSummary` accepts a summary of exactly `SUMMARY_MAX_CHARS`

- **GIVEN** an active session row owned by token `T`, `summary_final = false`
- **WHEN** `agentSessions.writeSummary(sessionId, { tokenId: 'T', summary: 'a'.repeat(SUMMARY_MAX_CHARS), final: true })` is called
- **THEN** the call SHALL succeed and the row SHALL have `summary` of length `SUMMARY_MAX_CHARS` and `summary_final = true`

#### Scenario: A previously-stored 2000-char summary survives the CHECK-drop migration

- **GIVEN** a populated `sessions` table whose rows include summaries of length up to 2000 (the old cap)
- **WHEN** the table-rebuild migration that removes the `summary` `CHECK` runs
- **THEN** every existing row SHALL be preserved verbatim (the `INSERT … SELECT` copies all rows; relaxing the constraint rejects none)
- **AND** `PRAGMA foreign_key_check` SHALL report no violations before `COMMIT`

#### Scenario: Raising the cap requires no migration

- **GIVEN** the cap is enforced solely by `SUMMARY_MAX_CHARS` with no value-pinning DB `CHECK`
- **WHEN** an operator/maintainer changes `SUMMARY_MAX_CHARS` to a new value
- **THEN** the new cap SHALL take effect with no database migration or table rebuild
