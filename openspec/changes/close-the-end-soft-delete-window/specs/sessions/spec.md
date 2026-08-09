## MODIFIED Requirements

### Requirement: Sessions MAY be soft-deleted while preserving the audit trail

The `agent_sessions` table SHALL gain a nullable column `deleted_at TIMESTAMP`. A row with `deleted_at IS NOT NULL` is _soft-deleted_: it remains physically present, its `id` continues to satisfy every existing `memory.session_id` foreign-key reference, but it is hidden from default-visible listings.

`AgentSessionsService` SHALL expose:

- `softDelete(sessionId, {tokenId?, adminBypass?})`: sets `deleted_at` to `now()`. Calling this on an already-deleted row SHALL be a no-op that returns the existing row (idempotent). Without `adminBypass`, the caller's `tokenId` SHALL match the row's `token_id`; mismatches SHALL be rejected with `forbidden`.
- `undelete(sessionId, {adminBypass?})`: clears `deleted_at`. Only admin (operator-facing) callers may invoke this; agent-facing callers SHALL NOT have access.

`AgentSessionsService.list(...)` SHALL apply `WHERE deleted_at IS NULL` by default. `list(...)` SHALL accept an `includeDeleted: true` option to surface deleted rows. `AgentSessionsService.recentForContext(...)` SHALL apply BOTH `WHERE deleted_at IS NULL` AND the `sessionHasContent` predicate defined below; it SHALL NOT accept any option that bypasses either filter — memory-context callers SHALL never see deleted sessions and SHALL never see empty sessions.

`AgentSessionsService.findById(...)` SHALL NOT filter on `deleted_at` or on `sessionHasContent`. The detail surface must still be able to open and act on (e.g. undelete) any row regardless of content.

Every service write path that mutates a session's own columns SHALL refuse a soft-deleted row. Specifically `AgentSessionsService.end` and `AgentSessionsService.writeSummary` SHALL throw `DomainError('session_deleted', <message>)` when the row they resolved has `deleted_at IS NOT NULL`, on the `active` branch and the terminal branch alike, and SHALL evaluate that condition against the row read inside the same synchronous tick as the `UPDATE` — after the cross-token mask and before the `status` branch, so that exactly one evaluation covers both branches.

The placement is load-bearing, not stylistic. Both HTTP callers await the request body between their own soft-delete gate and the service call (`POST /api/<slug>/sessions/:id/summary` and `.../end`), and that body may carry up to `SUMMARY_MAX_CHARS`, so a check taken on an earlier tick can be invalidated before the write lands. A caller-side gate is therefore advisory — it exists to produce the operator-facing message early — and the service's own re-read is the evaluation that decides. A row soft-deleted after a caller's gate passed SHALL be rejected rather than mutated.

`softDelete` and `undelete` are exempt, being the paths by which `deleted_at` moves. The status-only reconciliation paths `abandonInactiveSince` and `markAbandoned` are also outside this requirement: they write `status` and `ended_at` only, and whether they should additionally skip soft-deleted rows is not decided here.

#### Scenario: softDelete sets deleted_at and hides the row from default list

- **GIVEN** an active session with `id = <S>` whose `deleted_at` is NULL
- **WHEN** the operator calls `softDelete(<S>, {adminBypass: true})`
- **THEN** the row's `deleted_at` SHALL be set to the current timestamp
- **AND** a subsequent `list()` SHALL NOT include the row
- **AND** a subsequent `list({includeDeleted: true})` SHALL include the row
- **AND** `findById(<S>)` SHALL still return the row

#### Scenario: softDelete is idempotent

- **GIVEN** a session whose `deleted_at` is already set
- **WHEN** the operator calls `softDelete` on it again
- **THEN** the call SHALL succeed and SHALL NOT modify `deleted_at`
- **AND** the returned row SHALL be the existing soft-deleted row

#### Scenario: undelete clears deleted_at

- **GIVEN** a soft-deleted session
- **WHEN** the operator calls `undelete` on it with `adminBypass: true`
- **THEN** `deleted_at` SHALL transition back to NULL
- **AND** the row SHALL re-appear in the default list

#### Scenario: Memories anchored to a soft-deleted session preserve their session_id

- **GIVEN** a memory whose `session_id` references session `<S>`
- **WHEN** session `<S>` is soft-deleted
- **THEN** the memory's `session_id` SHALL remain unchanged and SHALL continue to point at `<S>`

#### Scenario: `end()` refuses a soft-deleted active row

- **GIVEN** session `<S>` with `status='active'`, `ended_at IS NULL` and `deleted_at IS NOT NULL`
- **WHEN** `agentSessions.end(<S>, { tokenId: <owning token> })` is called
- **THEN** the call SHALL throw `DomainError('session_deleted', <message>)`
- **AND** the row SHALL NOT be mutated: `status` SHALL remain `'active'`, `ended_at` SHALL remain NULL, and `summary`/`title` SHALL be unchanged

#### Scenario: `writeSummary()` refuses a soft-deleted active row

- **GIVEN** session `<S>` with `status='active'` and `deleted_at IS NOT NULL`
- **WHEN** `agentSessions.writeSummary(<S>, { tokenId: <owning token>, summary: 'anything' })` is called
- **THEN** the call SHALL throw `DomainError('session_deleted', <message>)`
- **AND** `summary`, `title` and `last_activity_at` SHALL all be unchanged

#### Scenario: The refusal is identical on a terminal row

- **GIVEN** session `<S>` with `deleted_at IS NOT NULL` and `status` of either `'ended'` or `'abandoned'`
- **WHEN** `agentSessions.end(<S>, …)` or `agentSessions.writeSummary(<S>, …)` is called by the owning token
- **THEN** the call SHALL throw `DomainError('session_deleted', <message>)` and SHALL NOT emit an `UPDATE`

#### Scenario: A soft-delete landing between a caller's gate and the write is still rejected

- **GIVEN** session `<S>` whose `deleted_at` is NULL at the moment a caller runs its own soft-delete gate
- **WHEN** `<S>` is soft-deleted before that caller reaches `end()` or `writeSummary()`, and the call then proceeds
- **THEN** the service SHALL reject with `session_deleted` on the strength of its own re-read
- **AND** the row SHALL NOT be mutated, whatever its `status` was

### Requirement: Terminal session rows MUST accept late summary and title writes

A session row whose `status` is `ended` or `abandoned` SHALL accept `summary` and `title` writes for the remainder of its life, with no time limit relative to `ended_at`. This SHALL hold for every write path that mutates those columns — `AgentSessionsService.writeSummary`, `AgentSessionsService.end`, and therefore `POST /api/<slug>/sessions/:id/summary`, `POST /api/<slug>/sessions/:id/end`, `memory.session_summary` and `memory.session_end` — so that no two of them disagree about the same row. (`memory.session_end` carries no summary/title arguments of its own, so on a terminal row it is a pure no-op rather than a write; it is listed because it must not reject either.)

Late writes SHALL be subject to the existing `summary_final` / `title_final` precedence rules with ONE deviation: on a terminal row an already-`final` column SHALL NOT be replaced, not even by a `final:true` write. On an `active` row last-final-wins is unchanged. The deviation exists because unbounded lateness makes the alternative lossy in a way sessions cannot recover from: a resumed host session reuses its id, its agent's obligatory `memory.session_summary` sends `final:true`, and sessions have no `replaces` chain or `consolidation_ops` journal, so the displaced handoff is gone with no audit trail. Before late writes were permitted the same call was rejected and the text survived; the first curated value therefore stands. A `final:false` write against an already-`final` column remains a silent no-op and is NOT an error.

The cap precondition (`SUMMARY_MAX_CHARS`), the `NUL`-byte rejection, the `title` length bound and the cross-token mask (`session_not_found`) SHALL be evaluated in the service exactly as on an `active` row and BEFORE any column is written. The project-mismatch mask (`session_not_found`) SHALL be evaluated at the HTTP-handler and MCP-tool boundary. The soft-delete rejection (`session_deleted`) SHALL be evaluated at that boundary AND in the service, and the service's evaluation SHALL be the binding one: the boundary check runs before the request body is awaited and can therefore be stale by the time the write happens, so the service re-reads and decides. That service check is NOT specific to terminal rows — it sits ahead of the `status` branch and covers the `active` path identically; the full rule is stated once, under "Sessions MAY be soft-deleted while preserving the audit trail" in this capability. It exists because removing the `status !== 'active'` rejection also removed the backstop that incidentally protected a soft-deleted terminal row from a caller that forgot the gate, and because the gate a caller does remember is not fresh.

A late write SHALL NOT mutate `status`, `ended_at`, or `last_activity_at`. In particular `end()` on an `abandoned` row SHALL apply the summary/title writes and SHALL NOT flip `status` to `'ended'` and SHALL NOT write `ended_at`: `ended_at` remains write-once and the retirement sweep's classification of how the session died stands. `last_activity_at` is deliberately excluded because it exists solely to drive stale-active retirement and transport resolution, both of which filter `status = 'active'`.

Per-field precedence SHALL be folded into an update `set` in exactly ONE place, shared by all three write paths (the terminal write, `writeSummary`'s active path, `end`'s active path), so the three cannot drift.

The status FSM SHALL remain `active → ended | abandoned` with both non-`active` states terminal. No path SHALL transition a session back to `active`, and no path SHALL write `ended_at` on a row that already has one. `ended_at`'s write-once property is structural: every path that writes it (`end`'s active branch, `markAbandoned`, `abandonInactiveSince`) matches on `status = 'active'`, and the late-write path never places `status` or `ended_at` in its update `set`. Two CI invariant tests bound that structure — see the scenarios below — so widening it is a build failure rather than a review oversight.

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
- **WHEN** a `summary` write arrives on any of the four request paths (`/summary`, `/end`, `memory.session_summary`, `memory.session_end`)
- **THEN** it SHALL be rejected with `session_deleted` and the row SHALL NOT be mutated

#### Scenario: A late write for a different token is still masked

- **GIVEN** session `<S>` with `status='abandoned'` owned by token `T1`
- **WHEN** token `T2` attempts a `summary` write on `<S>`
- **THEN** it SHALL be rejected with `session_not_found` (never `forbidden`, never `session_already_ended`) and the row SHALL NOT be mutated

#### Scenario: No path revives a terminal session

- **WHEN** a session update that is not one of the three permitted to run against a non-`active` row (the late summary/title write, `softDelete`, `undelete`) is added, or `status: 'active'` is written in `services/agent-sessions.ts` or `db/repositories/agent-sessions-repository.ts` anywhere other than the two row inserts
- **THEN** a CI invariant test SHALL fail and the build SHALL be rejected
- **AND** those two files SHALL suffice as the scanned surface, because the data-access invariant already confines every session `UPDATE` to `db/` and the service is the only composer of a session update `set`

#### Scenario: `ended_at` cannot be rewritten by a late write

- **GIVEN** every path that writes `ended_at` (`end`'s active branch, `markAbandoned`, `abandonInactiveSince`) matches on `status = 'active'`
- **WHEN** a late summary/title write lands on a row whose `ended_at` is already set
- **THEN** `ended_at` SHALL NOT appear in the update `set` and the stored value SHALL be unchanged
- **AND** a fourth update site able to run against a non-`active` row SHALL fail the CI invariant test above
