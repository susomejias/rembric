## MODIFIED Requirements

### Requirement: Sessions MUST be append-only

The system SHALL never physically delete a session row and SHALL never mutate the `agent`, `token_id`, `started_at`, or `project_id` of an existing session, EXCEPT through the operator-only physical-purge escape hatch defined in "Sessions MAY be physically purged when empty". Lifecycle changes are otherwise expressed exclusively by transitioning the `status` column among `active`, `ended`, and `abandoned`, by writing the `ended_at` column at most once **per terminal transition**, and by writing the `summary` and `title` columns subject to the `summary_final` / `title_final` precedence flags.

`ended_at` is write-once per terminal transition rather than write-once per row. It SHALL be written exactly when a row leaves `active` (`end`'s active branch, `markAbandoned`, `abandonInactiveSince`), SHALL be cleared to NULL exactly when a row re-enters `active` through `resume` (see "`AgentSessionsService.resume()` MUST return a terminal session to `active`"), and SHALL NOT be written by any other path. The invariant a reader may rely on is therefore `ended_at IS NOT NULL` if and only if `status <> 'active'`. The instant of a *previous* terminal transition is NOT retained after a resume; a caller that needs it SHALL read `previousEndedAt` from the resume response, which is the only place it is reported.

The `deleted_at` column is exempt from immutability: it SHALL transition from NULL to a timestamp (soft-delete) or from a timestamp back to NULL (undelete) any number of times. Both transitions SHALL be guarded by the cross-token rule that already protects `end` and `writeSummary`, unless the caller is an operator-facing surface (CLI or dashboard) that sets `adminBypass: true`.

The `id` column is set exactly once at insert time. It MAY originate from a client (via `POST /api/<slug>/sessions` or `start({id})`) or be server-minted (via `memory.session_start` without an explicit id). Once written it SHALL NOT be UPDATEd.

The `summary` and `title` columns are exempt from one-write-per-lifetime immutability: they MAY be written multiple times subject to the `final` precedence rules (a `final:true` write locks against `final:false` writes; non-final writes can overwrite each other). This exemption SHALL apply irrespective of `status`, with one narrowing on terminal rows where an already-`final` column becomes immutable — see "Terminal session rows MUST accept late summary and title writes, and MUST NOT change status except through `resume`".

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

## REMOVED Requirements

### Requirement: Terminal session rows MUST accept late summary and title writes

**Reason**: The requirement's FSM paragraph states "No path SHALL transition a session back to `active`", and it carries a published scenario titled "No path revives a terminal session" whose body enumerates exactly three updates permitted against a non-`active` row. This change adds a fourth (`resume`) and one path back to `active`, so both the paragraph and that scenario title become false. A published scenario cannot be dropped inside a `MODIFIED` block — `scripts/check-delta-freshness.mjs` fails on it and `openspec archive` refuses the merge (documented in `openspec/changes/archive/2026-08-09-retire-the-summarize-wrapper/specs/sessions/spec.md`) — so the requirement is removed and re-added below under a header that names the single exception. Every other clause is carried over verbatim: the unbounded-lateness rule, the first-final-wins deviation on terminal rows, the precondition-ordering rule, the single-`set`-composition rule, the empty-update rule, and eight of the ten scenarios. The scenario "`ended_at` cannot be rewritten by a late write" is carried over under its own title with its enumeration of `ended_at` write sites corrected, since `resume` is now one of them.

## ADDED Requirements

### Requirement: Terminal session rows MUST accept late summary and title writes, and MUST NOT change status except through `resume`

A session row whose `status` is `ended` or `abandoned` SHALL accept `summary` and `title` writes for the remainder of its life, with no time limit relative to `ended_at`. This SHALL hold for every write path that mutates those columns — `AgentSessionsService.writeSummary`, `AgentSessionsService.end`, and therefore `POST /api/<slug>/sessions/:id/summary`, `POST /api/<slug>/sessions/:id/end`, `memory.session_summary` and `memory.session_end` — so that no two of them disagree about the same row. (`memory.session_end` carries no summary/title arguments of its own, so on a terminal row it is a pure no-op rather than a write; it is listed because it must not reject either.)

Late writes SHALL be subject to the existing `summary_final` / `title_final` precedence rules with ONE deviation: on a terminal row an already-`final` column SHALL NOT be replaced, not even by a `final:true` write. On an `active` row last-final-wins is unchanged. The deviation exists because unbounded lateness makes the alternative lossy in a way sessions cannot recover from: a resumed host session reuses its id, its agent's obligatory `memory.session_summary` sends `final:true`, and sessions have no `replaces` chain or `consolidation_ops` journal, so the displaced handoff is gone with no audit trail. Before late writes were permitted the same call was rejected and the text survived; the first curated value therefore stands. A `final:false` write against an already-`final` column remains a silent no-op and is NOT an error.

The asymmetry is deliberate and interacts with `resume`: a row returned to `active` is governed by last-final-wins again, so the resumed conversation's curated handoff replaces the previous one. That is the intended outcome and requires no separate rule — it follows from the row no longer being terminal.

The cap precondition (`SUMMARY_MAX_CHARS`), the `NUL`-byte rejection, the `title` length bound and the cross-token mask (`session_not_found`) SHALL be evaluated in the service exactly as on an `active` row and BEFORE any column is written. The project-mismatch mask (`session_not_found`) SHALL be evaluated at the HTTP-handler and MCP-tool boundary. The soft-delete rejection (`session_deleted`) SHALL be evaluated at that boundary AND in the service, and the service's evaluation SHALL be the binding one: the boundary check runs before the request body is awaited and can therefore be stale by the time the write happens, so the service re-reads and decides. That service check is NOT specific to terminal rows — it sits ahead of the `status` branch and covers the `active` path identically; the full rule is stated once, under "Sessions MAY be soft-deleted while preserving the audit trail" in this capability. It exists because removing the `status !== 'active'` rejection also removed the backstop that incidentally protected a soft-deleted terminal row from a caller that forgot the gate, and because the gate a caller does remember is not fresh.

A late write SHALL NOT mutate `status`, `ended_at`, or `last_activity_at`. In particular `end()` on an `abandoned` row SHALL apply the summary/title writes and SHALL NOT flip `status` to `'ended'` and SHALL NOT write `ended_at`: the retirement sweep's classification of how the session died stands, and nothing about a summary write is a lifecycle event. `last_activity_at` is deliberately excluded because it exists solely to drive stale-active retirement and transport resolution, both of which filter `status = 'active'`.

Per-field precedence SHALL be folded into an update `set` in exactly ONE place, shared by all three write paths (the terminal write, `writeSummary`'s active path, `end`'s active path), so the three cannot drift. `resume` composes its own `set` and SHALL NOT call into that place, because it writes no precedence-governed column.

The status FSM SHALL be `active → ended | abandoned → active`, where the only edge back to `active` is the explicit `resume` verb specified in "`AgentSessionsService.resume()` MUST return a terminal session to `active`". `resume` SHALL be the ONLY path that writes `status: 'active'` outside the two row inserts, and the ONLY path that clears `ended_at`. No implicit path — `ensure`, `touchActivity`, `writeSummary`, `end`, `markAbandoned`, `abandonInactiveSince`, `softDelete`, `undelete` — SHALL move a row back to `active`, and none SHALL write `ended_at` on a row that already has one.

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

#### Scenario: Only `resume` revives a terminal session

- **WHEN** a revival is added to any mutating verb of `AgentSessionsService` other than `resume` — the late summary/title write, `end`, `writeSummary`, `markAbandoned`, `abandonStale`, `touchActivity`, `softDelete`, `undelete`
- **THEN** a CI runtime test SHALL fail and the build SHALL be rejected
- **AND** the enforcement SHALL be that runtime test, which drives each of those verbs against a row in each terminal state and asserts `status` and `ended_at` are unmoved — NOT a grep over the source files, because a mutation test has already shown that a counting or text invariant over that surface passes while a revival is added inside a write path it does not read
- **AND** the test's coverage is bounded by its verb list, which is enumerated in the test rather than derived: a NEW mutating verb is not covered until it is added there, so adding one obliges extending the list in the same change

#### Scenario: `ended_at` cannot be rewritten by a late write

- **GIVEN** the paths that write `ended_at` to a timestamp (`end`'s active branch, `markAbandoned`, `abandonInactiveSince`) all match on `status = 'active'` in the `UPDATE` itself, while the one path that clears it (`resume`) issues an unguarded `UPDATE` (`requireActive: false`) behind an in-process early return on `status === 'active'` — sound because the connection is a single synchronous one, so the read and the write cannot interleave, and unsound to copy into any path that does not hold that property
- **WHEN** a late summary/title write lands on a row whose `ended_at` is already set
- **THEN** `ended_at` SHALL NOT appear in the update `set` and the stored value SHALL be unchanged
- **AND** a further update site able to write `ended_at` against a non-`active` row SHALL fail the CI test above

### Requirement: `AgentSessionsService.resume()` MUST return a terminal session to `active`

The service method `resume(sessionId: string, input: { tokenId: string }): AgentSession` SHALL be the sole path by which a session row re-enters `status = 'active'`. It SHALL evaluate, in this order:

1. **Row lookup.** `SELECT` the row by `id`. If no row matches, throw `DomainError('session_not_found', <message naming the id>)`.
2. **Cross-token mask.** If the row's `token_id` does not equal `input.tokenId`, throw `DomainError('session_not_found', …)` — never `forbidden`, matching the mask every other session verb applies, so a caller cannot probe for the existence of another token's session.
3. **Soft-delete gate.** If `deleted_at IS NOT NULL`, throw `DomainError('session_deleted', <message naming the deleted-at timestamp>)`. This check SHALL be taken against the row read in step 1, in the same synchronous tick as the write, for the reason stated under "Sessions MAY be soft-deleted while preserving the audit trail".
4. **Already-active no-op.** If `status` is already `'active'`, return the existing row unchanged and SHALL NOT emit an `UPDATE`. This is a success, not an error: a defensive caller must not be penalised for resuming a session that is already live.
5. **Revive.** Otherwise — `status IN ('ended','abandoned')` — emit exactly one `UPDATE` setting `status = 'active'`, `ended_at = NULL`, and `last_activity_at = now()`, and return the post-update row.

`resume` SHALL treat `ended` and `abandoned` identically. There SHALL be no branch, no differing error, and no configuration that admits one and refuses the other: `abandoned` is the documented steady state for the clients that never post `/end` and the outcome of stale-active retirement on every other client, so a resume that refused it would refuse the majority of the rows it exists to serve.

`resume` SHALL NOT write `agent`, `token_id`, `project_id`, `started_at`, `summary`, `summary_final`, `title`, `title_final` or `deleted_at`. The only columns written are `status`, `ended_at` and `last_activity_at`.

`last_activity_at` is REQUIRED, not incidental: `abandonInactiveSince` compares `COALESCE(last_activity_at, started_at)` against its cutoff, so a row revived without the stamp is already past the retirement window and would be re-abandoned by the next sweep pass.

`resume` SHALL NOT be reachable from `ensure`, `start`, `touchActivity`, `writeSummary` or `end`. It SHALL be reachable only from a caller that names the row's id explicitly: the `memory.session_resume` MCP tool (`mcp-api` capability) and the `POST /api/<slug>/sessions/:id/resume` route (`http-api` capability). Both carry the id in the request itself and neither infers it, so no idempotent per-turn path can revive a row as a side effect.

Nothing SHALL persist the fact that a resume occurred, the count of resumes, or the discarded `ended_at`. That history is deliberately not recorded in this capability; the values are reported once, in the resume response, and are not recoverable afterwards.

#### Scenario: Resuming an ended session

- **GIVEN** session `<S>` owned by token `T` with `status='ended'`, `ended_at = E`, `deleted_at IS NULL`
- **WHEN** `resume(<S>, { tokenId: 'T' })` is called at instant `N`
- **THEN** the row SHALL have `status='active'`, `ended_at IS NULL`, and `last_activity_at = N`
- **AND** `started_at`, `agent`, `token_id`, `project_id`, `summary`, `summary_final`, `title` and `title_final` SHALL be byte-identical to their values before the call

#### Scenario: Resuming an abandoned session behaves identically

- **GIVEN** session `<S>` owned by token `T` with `status='abandoned'`, `ended_at = E` written by the retirement sweep
- **WHEN** `resume(<S>, { tokenId: 'T' })` is called at instant `N`
- **THEN** the row SHALL have `status='active'`, `ended_at IS NULL`, and `last_activity_at = N`
- **AND** the outcome SHALL be indistinguishable from the ended case above in every column

#### Scenario: A resumed row survives the next retirement sweep

- **GIVEN** session `<S>` was abandoned by `abandonStale` because its `last_activity_at` was older than the abandon window
- **WHEN** `resume(<S>, { tokenId: 'T' })` succeeds and `abandonStale({ olderThanMs })` runs immediately afterwards with the same window
- **THEN** `<S>` SHALL remain `status='active'` with `ended_at IS NULL`, because its `last_activity_at` was re-stamped by the resume

#### Scenario: A resumed row leaves the purgeable-empty set

- **GIVEN** session `<S>` with no memories, no prompts and no curated summary, `status='ended'` and `ended_at` older than the purge grace, so it is returned by the purgeable-empty query
- **WHEN** `resume(<S>, { tokenId: 'T' })` succeeds
- **THEN** `<S>` SHALL NOT be returned by the purgeable-empty query, because that query requires `status IN ('ended','abandoned')`
- **AND** no change to the purge query itself SHALL be required for this to hold

#### Scenario: Resume on an already-active row is a no-op success

- **GIVEN** session `<S>` with `status='active'` and `last_activity_at = L`
- **WHEN** `resume(<S>, { tokenId: 'T' })` is called
- **THEN** the call SHALL return the existing row without error
- **AND** no `UPDATE` SHALL be emitted, so `last_activity_at` SHALL still be `L`

#### Scenario: Resume for a different token is masked

- **GIVEN** session `<S>` owned by token `T1` with `status='ended'`
- **WHEN** token `T2` calls `resume(<S>, { tokenId: 'T2' })`
- **THEN** it SHALL be rejected with `session_not_found` (never `forbidden`) and the row SHALL NOT be mutated

#### Scenario: Resume on a soft-deleted row is refused

- **GIVEN** session `<S>` with `status='abandoned'` and `deleted_at IS NOT NULL`
- **WHEN** `resume(<S>, { tokenId: 'T' })` is called
- **THEN** it SHALL be rejected with `session_deleted` naming the deleted-at timestamp
- **AND** `status`, `ended_at` and `last_activity_at` SHALL be unchanged

#### Scenario: An ended row can reach `abandoned` only through a real live span

- **GIVEN** session `<S>` with `status='ended'` and `ended_at = E`
- **WHEN** `markAbandoned(<S>, …)` is called directly
- **THEN** it SHALL still throw `session_already_ended` — `resume` SHALL NOT weaken that guard
- **AND** the two-call sequence `resume(<S>)` followed by `markAbandoned(<S>)` SHALL succeed, producing `status='abandoned'` with a fresh `ended_at`, because between the two calls the row was genuinely `active`

### Requirement: A resumed session keeps its original `started_at`, and recent-session ordering is unchanged

`resume` SHALL NOT write `started_at`. The column records when the logical conversation first began, which a resume does not change, and it is immutable under "Sessions MUST be append-only".

The consequence SHALL be accepted rather than worked around: `recentForContext` orders by `started_at DESC` and applies no `status` filter, so a resumed conversation appears in `memory.context` exactly once — with its stable id, its curated summary, and its current `status` — but it does NOT re-sort to the head of the list on resume. A long-running resumed conversation MAY therefore rank below a newer, shorter one. No requirement in this capability SHALL claim that a resumed session is ordered by recency of activity.

Search ranking SHALL remain independent of session lifecycle: no memory's rank SHALL change because the session it is attached to was resumed.

#### Scenario: A resumed session appears once in `memory.context`, not twice

- **GIVEN** session `<S>` with a curated summary, resumed after being `ended`
- **WHEN** `memory.context` resolves the same scope
- **THEN** `<S>` SHALL appear exactly once among `recentSessions`, carrying its original `id` and `startedAt`
- **AND** no second row SHALL exist for the same logical conversation

#### Scenario: A resumed session is not re-dated to the head of the context list

- **GIVEN** session `<A>` started at `T0` and resumed at `T2`, and session `<B>` started at `T1` where `T0 < T1 < T2`, both with curated summaries in the same scope
- **WHEN** `memory.context` resolves that scope
- **THEN** `<B>` SHALL be ordered ahead of `<A>`, because ordering keys on `started_at`
- **AND** `<A>`'s `startedAt` SHALL still be `T0`
