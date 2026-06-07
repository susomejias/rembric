## MODIFIED Requirements

### Requirement: Session summary writes MUST be capped at `SUMMARY_MAX_CHARS`

The `AgentSessionsService` SHALL expose a single canonical constant `SUMMARY_MAX_CHARS` and SHALL reject any `summary` argument whose `String.prototype.length` exceeds it. The cap SHALL be enforced **solely in the server** — there SHALL be no SQLite `CHECK` constraint that pins `summary` length to the cap value. The `CHECK (length(summary) <= 2000)` previously introduced in migration `0011` SHALL be removed by a table-rebuild migration. A database `CHECK` MAY remain only as a generous pathological-size guard (a value far above any plausible `SUMMARY_MAX_CHARS`, e.g. 1 MB) that does NOT track or pin the operative cap; changing `SUMMARY_MAX_CHARS` SHALL NOT require a database migration.

`SUMMARY_MAX_CHARS` SHALL be set high enough to carry a rich handoff summary (the design records the chosen value). The constant SHALL remain the single source of truth, exported and imported by the MCP zod schema (`apps/server/src/mcp/sessions-tools.ts`) and by the HTTP-layer truncation helper, so no layer can drift from the service-level cap.

The cap precondition SHALL be enforced before the `summary_final` precedence rule is evaluated, by every write path that mutates `sessions.summary`:

- `writeSummary({ summary, ... })`
- `end({ summary, ... })`
- `summarize({ summary })` (back-compat wrapper)

When `summary.length > SUMMARY_MAX_CHARS`, the service SHALL throw `DomainError('invalid_input', message)` where `message` SHALL contain the decimal string of `SUMMARY_MAX_CHARS` so callers (including the MCP tool envelope and HTTP handler) can surface the cap to the client without re-encoding it. The row SHALL NOT be mutated and `summary_final` SHALL NOT be lifted by a rejected call.

The auto-curate path (`composeDerivedSummary` invoked for sessions with anchored content but no curated summary) SHALL produce output well under `SUMMARY_MAX_CHARS` (the existing template `[auto] N memorias[, P prompts[, C confirmaciones]][ — última: '<80-char snippet>']` already fits in ~120 chars) and SHALL NOT be modified by this requirement.

#### Scenario: `writeSummary` rejects a summary of `SUMMARY_MAX_CHARS + 1`

- **GIVEN** an active session row owned by token `T`
- **WHEN** `agentSessions.writeSummary(sessionId, { tokenId: 'T', summary: 'a'.repeat(SUMMARY_MAX_CHARS + 1) })` is called
- **THEN** the call SHALL throw `DomainError('invalid_input', <message>)` whose message contains the decimal string of `SUMMARY_MAX_CHARS`
- **AND** the row in `sessions` SHALL remain unchanged (no summary written, `summary_final` unchanged)

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

### Requirement: `memory.session_get` returns a session's full summary by id

The MCP surface SHALL expose a `memory.session_get` tool that returns a single session, identified by `sessionId`, including its **full, untruncated** `summary` (in contrast to `memory.context`, which returns a bounded snippet). The handler SHALL resolve scope using the documented session-tool scope-resolution precedence (`ctx.project` via path-scoping, then `SessionRouter`, via `resolveEffectiveProject` / `scopeFromContext`) and SHALL treat a session whose `project_id` does not match the resolved scope as `not_found`. A soft-deleted session (`deleted_at IS NOT NULL`) SHALL be returned as `not_found`. The tool SHALL be read-only and SHALL NOT mutate any row.

`memory.context` SHALL continue to return the bounded snippet for `recentSessions[].summary`; `memory.session_get` is the on-demand path for the full text (the multi-agent / cross-client handoff use case).

#### Scenario: Returns the full summary for an in-scope session

- **GIVEN** a session `S` in the caller's scope with a stored `summary` longer than the `memory.context` snippet bound
- **WHEN** the agent calls `memory.session_get({ sessionId: S.id })`
- **THEN** the response SHALL include `S`'s full, untruncated `summary`

#### Scenario: A cross-scope session id is not found

- **GIVEN** a session `S` that belongs to a different project than the caller's resolved scope
- **WHEN** the agent calls `memory.session_get({ sessionId: S.id })`
- **THEN** the tool SHALL return a structured `not_found` error and SHALL NOT reveal `S`'s contents

#### Scenario: A soft-deleted session is not found

- **GIVEN** a session `S` in the caller's scope with `deleted_at IS NOT NULL`
- **WHEN** the agent calls `memory.session_get({ sessionId: S.id })`
- **THEN** the tool SHALL return a structured `not_found` error
