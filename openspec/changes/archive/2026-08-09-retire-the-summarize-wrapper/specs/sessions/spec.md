## MODIFIED Requirements

### Requirement: Sessions MUST be append-only

The system SHALL never physically delete a session row and SHALL never mutate the `agent`, `token_id`, `started_at`, or `project_id` of an existing session, EXCEPT through the operator-only physical-purge escape hatch defined in "Sessions MAY be physically purged when empty". Lifecycle changes are otherwise expressed exclusively by transitioning the `status` column among `active`, `ended`, and `abandoned`, by writing the `ended_at` column at most once, and by writing the `summary` and `title` columns subject to the `summary_final` / `title_final` precedence flags.

The `deleted_at` column is exempt from immutability: it SHALL transition from NULL to a timestamp (soft-delete) or from a timestamp back to NULL (undelete) any number of times. Both transitions SHALL be guarded by the cross-token rule that already protects `end` and `writeSummary`, unless the caller is an operator-facing surface (CLI or dashboard) that sets `adminBypass: true`.

The `id` column is set exactly once at insert time. It MAY originate from a client (via `POST /api/<slug>/sessions` or `start({id})`) or be server-minted (via `memory.session_start` without an explicit id). Once written it SHALL NOT be UPDATEd.

The `summary` and `title` columns are exempt from one-write-per-lifetime immutability: they MAY be written multiple times subject to the `final` precedence rules (a `final:true` write locks against `final:false` writes; non-final writes can overwrite each other). This exemption SHALL apply irrespective of `status`, with one narrowing on terminal rows where an already-`final` column becomes immutable — see "Terminal session rows MUST accept late summary and title writes".

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

## REMOVED Requirements

### Requirement: Session summary writes MUST be capped at `SUMMARY_MAX_CHARS`

**Reason**: The requirement enumerated three write paths, the third being `summarize({ summary })`, a back-compat wrapper on `AgentSessionsService` that rejected an empty summary, applied the cap, then delegated to `end({ summary, final: true })`. That wrapper is retired: it has zero production callers (`grep -rn 'summarize' apps/server/src --include='*.ts'` finds only its own definition, its own error string, a prose mention in the class docstring, and two unrelated English words), and its own docstring scheduled its removal once callers were migrated. Removing the bullet is not enough on its own — the requirement also carried a scenario titled "`summarize` (legacy wrapper) inherits the cap", and a published scenario cannot be dropped inside a `MODIFIED` block (`scripts/check-delta-freshness.mjs` fails on it and `openspec archive` refuses the merge). The requirement is therefore removed and re-added below under a header that states the remaining enumeration is exhaustive. Every other clause — the cap value's single source of truth, the no-value-pinning-`CHECK` rule, the tail-truncation and leading-marker rules, the pre-precedence and pre-`status` ordering, the `DomainError('invalid_input')` contract — is carried over verbatim.

**Migration**: None for operators: no schema change, no migration, no data touched, no observable behaviour change on any wire. For in-tree callers: `summarize(id, { tokenId, summary })` becomes `end(id, { tokenId, summary, final: true })`, which is exactly what the wrapper did. `final: true` is required rather than optional in that rewrite — `recentForContext` filters on `sessionHasContentSql('sessions', { requireCuratedSummary: true })`, so a rewrite that omits it writes `summary_final = 0` and changes which sessions surface in `memory.context`. The successor requirement is "Session summary writes MUST be capped at `SUMMARY_MAX_CHARS` on every write path that mutates `sessions.summary`".

## ADDED Requirements

### Requirement: Session summary writes MUST be capped at `SUMMARY_MAX_CHARS` on every write path that mutates `sessions.summary`

The `AgentSessionsService` SHALL expose a single canonical constant `SUMMARY_MAX_CHARS` and SHALL reject any `summary` argument whose `String.prototype.length` exceeds it. The cap SHALL be enforced **solely in the server** — there SHALL be no SQLite `CHECK` constraint that pins `summary` length to the cap value. The `CHECK (length(summary) <= 2000)` previously introduced in migration `0011` SHALL be removed by a table-rebuild migration. A database `CHECK` MAY remain only as a generous pathological-size guard (a value far above any plausible `SUMMARY_MAX_CHARS`, e.g. 1 MB) that does NOT track or pin the operative cap; changing `SUMMARY_MAX_CHARS` SHALL NOT require a database migration.

`SUMMARY_MAX_CHARS` SHALL be set high enough to carry a rich handoff summary (the design records the chosen value). The constant SHALL remain the single source of truth, exported and imported by the MCP zod schema (`apps/server/src/mcp/session-tools.ts`) and by the HTTP-layer truncation helper, so no layer can drift from the service-level cap. The server SHALL be the sole authoritative trimmer and the sole writer of the truncation marker. A client MAY bound its own wire payload above the server's cap — it cannot know a given server's cap at runtime, and a client hard-bounded to one version's value would silently under-deliver against a server whose cap is higher. What a client SHALL NOT do is trim the OPPOSITE side from the server: a payload selected as a tail and then re-cut as a head yields a middle window, which is neither. An invariant test SHALL assert that every client-side trim and the server's trim keep the same side.

Where the HTTP layer truncates an oversized body rather than rejecting it, it SHALL **retain the END of the text and discard the beginning**, and SHALL place the truncation marker at the FRONT of the result. Two reasons, and both are load-bearing:

- A session's conclusions, final state and unfinished items are at its end; its setup is at its beginning. Truncation that keeps the head discards exactly what a handoff exists to carry.
- A leading marker is what lets a reader distinguish a complete summary from the tail of a long one. A trailing marker cannot serve that purpose on a head-truncated body, because the text a reader sees begins at a real beginning and gives no signal that anything is missing.

Truncation MAY therefore happen more than once for a given payload, and that is safe precisely because the sides agree: two successive tail-cuts are idempotent in their result — the last `min(bounds)` characters of the original — whereas a tail-cut followed by a head-cut is not. A client that bounds its own payload SHALL prefer cutting at a record boundary over cutting mid-record, so the persisted artefact remains parseable.

The cap precondition SHALL be enforced before the `summary_final` precedence rule is evaluated, and before the row's `status` is consulted, by every write path that mutates `sessions.summary`, of which there are exactly two:

- `writeSummary({ summary, ... })`
- `end({ summary, ... })`

The enumeration is exhaustive and normative: `writeSummary` and `end` SHALL be the only service methods that write `sessions.summary`. Any further method that writes that column SHALL apply this same precondition in the same position and SHALL be enumerated here; a write path absent from this list is a defect in the list or in the path, never a licensed exception to the cap.

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

### Requirement: An empty or whitespace-only session summary MUST be rejected before the row is read

`AgentSessionsService.writeSummary` and `AgentSessionsService.end` SHALL reject a `summary` argument that is present but whose `String.prototype.trim()` yields the empty string, throwing `DomainError('invalid_input', message)` whose `message` names the rejecting method and states that the summary must be non-empty. Whitespace-only input SHALL be treated identically to `''`: a summary consisting solely of spaces, tabs or newlines carries no handoff and SHALL NOT be persisted.

This precondition SHALL be evaluated FIRST in both methods — before the `NUL`-byte check, before the `SUMMARY_MAX_CHARS` cap check, before the `title` length bound, and therefore before the row is read at all. Two consequences are normative, not incidental: a rejected call SHALL NOT read or mutate any row, and the error SHALL be `invalid_input` even when the `sessionId` names no existing session (the emptiness verdict precedes the `session_not_found` mask, the cross-token mask, the `session_deleted` check, the `status` branch and the `summary_final` precedence rule).

An ABSENT `summary` (`undefined`) SHALL NOT be rejected by this rule. `end({ tokenId })` with no summary is the ordinary close-without-summary path and SHALL succeed, leaving `summary` as it was; `writeSummary({ tokenId, title })` SHALL likewise be accepted as a title-only write.

This requirement states the SERVICE-level precondition. The tool-level rejections already specified for `memory.session_summary` (in this capability under "A session summary MUST follow the documented structure", and in `mcp-api`) are the same verdict observed from a caller; they are consistent with this rule and neither replaces it. The service check is the binding one, because it is the only one every write path passes through.

#### Scenario: `end` rejects a whitespace-only summary and leaves the session active

- **GIVEN** an active session row owned by token `T` with `summary IS NULL`
- **WHEN** `agentSessions.end(sessionId, { tokenId: 'T', summary: '   ' })` is called
- **THEN** the call SHALL throw `DomainError('invalid_input', <message>)` whose message states that the summary must be non-empty
- **AND** the row SHALL remain `status='active'` with `ended_at=NULL` and `summary IS NULL` — the rejection precedes the transition

#### Scenario: `writeSummary` rejects a whitespace-only summary

- **GIVEN** an active session row owned by token `T`
- **WHEN** `agentSessions.writeSummary(sessionId, { tokenId: 'T', summary: '\n\t ' })` is called
- **THEN** the call SHALL throw `DomainError('invalid_input', <message>)` whose message states that the summary must be non-empty
- **AND** `summary`, `title`, `summary_final` and `last_activity_at` SHALL all be unchanged

#### Scenario: The emptiness verdict precedes the row lookup

- **GIVEN** a `sessionId` that matches no row
- **WHEN** `agentSessions.end(sessionId, { tokenId: 'T', summary: '   ' })` or `agentSessions.writeSummary(sessionId, { tokenId: 'T', summary: '   ' })` is called
- **THEN** the call SHALL throw `DomainError('invalid_input', <message>)` and SHALL NOT throw `session_not_found`

#### Scenario: An absent summary is not an empty summary

- **GIVEN** an active session row owned by token `T`
- **WHEN** `agentSessions.end(sessionId, { tokenId: 'T' })` is called with no `summary` field
- **THEN** the call SHALL succeed, the row SHALL become `status='ended'` with `ended_at` set, and `summary` SHALL be unchanged
