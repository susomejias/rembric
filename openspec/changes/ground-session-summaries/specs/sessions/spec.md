## MODIFIED Requirements

### Requirement: A session summary MUST follow the documented structure

When `memory.session_summary` is called, the submitted `summary` SHALL be persisted in the session row's `summary` column. The server SHALL NOT enforce the layout — agents may submit free-form text — but the canonical structure SHALL be documented, and it SHALL be documented from ONE definition.

The canonical structure SHALL name, at minimum: the goal the session was pursuing; the work actually accomplished; the decisions taken and the reason for each; what was verified and by what means; what was left unfinished or blocked, and why; and the files that matter. A structure that names only outcomes produces a summary a later reader cannot act on: the reason a decision was taken and the evidence a claim rests on are the parts that do not survive in the code.

The canonical structure SHALL have a single source of truth in the server, exported as a named constant, and every surface that states it to a model SHALL derive its text from that constant rather than restate it. A test SHALL enumerate those surfaces and SHALL fail when one of them carries text the constant does not. This requirement exists because the structure was previously restated in six places and five of them named five sections while the sixth named seven, with nothing detecting the divergence.

One surface is exempt from carrying the long form and SHALL carry a terse pointer to it instead: the `memory.session_summary` tool description, which is bounded by the host truncation ceiling documented in `mcp-api` and has no room for it. The long form SHALL instead be delivered at the moment the model can still act on it (see `plugin-session-protocol`).

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

### Requirement: Session summary writes MUST be capped at `SUMMARY_MAX_CHARS`

The `AgentSessionsService` SHALL expose a single canonical constant `SUMMARY_MAX_CHARS` and SHALL reject any `summary` argument whose `String.prototype.length` exceeds it. The cap SHALL be enforced **solely in the server** — there SHALL be no SQLite `CHECK` constraint that pins `summary` length to the cap value. The `CHECK (length(summary) <= 2000)` previously introduced in migration `0011` SHALL be removed by a table-rebuild migration. A database `CHECK` MAY remain only as a generous pathological-size guard (a value far above any plausible `SUMMARY_MAX_CHARS`, e.g. 1 MB) that does NOT track or pin the operative cap; changing `SUMMARY_MAX_CHARS` SHALL NOT require a database migration.

`SUMMARY_MAX_CHARS` SHALL be set high enough to carry a rich handoff summary (the design records the chosen value). The constant SHALL remain the single source of truth, exported and imported by the MCP zod schema (`apps/server/src/mcp/session-tools.ts`) and by the HTTP-layer truncation helper, so no layer can drift from the service-level cap. The server SHALL be the sole authoritative trimmer and the sole writer of the truncation marker. A client MAY bound its own wire payload above the server's cap — it cannot know a given server's cap at runtime, and a client hard-bounded to one version's value would silently under-deliver against a server whose cap is higher. What a client SHALL NOT do is trim the OPPOSITE side from the server: a payload selected as a tail and then re-cut as a head yields a middle window, which is neither. An invariant test SHALL assert that every client-side trim and the server's trim keep the same side.

Where the HTTP layer truncates an oversized body rather than rejecting it, it SHALL **retain the END of the text and discard the beginning**, and SHALL place the truncation marker at the FRONT of the result. Two reasons, and both are load-bearing:

- A session's conclusions, final state and unfinished items are at its end; its setup is at its beginning. Truncation that keeps the head discards exactly what a handoff exists to carry.
- A leading marker is what lets a reader distinguish a complete summary from the tail of a long one. A trailing marker cannot serve that purpose on a head-truncated body, because the text a reader sees begins at a real beginning and gives no signal that anything is missing.

Truncation MAY therefore happen more than once for a given payload, and that is safe precisely because the sides agree: two successive tail-cuts are idempotent in their result — the last `min(bounds)` characters of the original — whereas a tail-cut followed by a head-cut is not. A client that bounds its own payload SHALL prefer cutting at a record boundary over cutting mid-record, so the persisted artefact remains parseable.

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

## ADDED Requirements

### Requirement: A session that ends without a curated summary MUST still leave grounded, checkable facts

When no curated summary was written, the fallback written on the agent's behalf SHALL consist of facts extracted deterministically from the session's own transcript, NOT a slice of that transcript.

The extraction SHALL emit only what is checkable without a model, and SHALL name at minimum: the files created, written or edited; the commands run, with the ones that failed identified as having failed; and the final exchange. It SHALL NOT include file diffs — the cap cannot hold them and version control already does.

Three properties are contracted. The output SHALL be traceable: every line SHALL correspond to an event in the transcript, so the fallback cannot assert something that did not happen. It SHALL be dense relative to prose, so that a fixed character budget carries more of a long session's substance. And it SHALL degrade gracefully under truncation: removing the beginning SHALL cost individual facts and SHALL NOT change the meaning of what remains.

Where a session's transcript cannot be parsed, the fallback SHALL degrade to the previous behaviour rather than fail, and SHALL NOT block or error the host.

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
