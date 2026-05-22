## ADDED Requirements

### Requirement: Session summary writes MUST be capped at `SUMMARY_MAX_CHARS`

The `AgentSessionsService` SHALL expose a single canonical constant `SUMMARY_MAX_CHARS = 2000` and SHALL reject any `summary` argument whose `String.prototype.length` exceeds it. This precondition SHALL be enforced before the `summary_final` precedence rule is evaluated, by every write path that mutates `sessions.summary`:

- `writeSummary({ summary, ... })`
- `end({ summary, ... })`
- `summarize({ summary })` (back-compat wrapper)

When `summary.length > SUMMARY_MAX_CHARS`, the service SHALL throw `DomainError('invalid_input', message)` where `message` SHALL contain the substring `'2000'` so callers (including the MCP tool envelope and HTTP handler) can surface the cap to the client without re-encoding it. The row SHALL NOT be mutated and `summary_final` SHALL NOT be lifted by a rejected call.

The constant SHALL be exported and imported by the MCP zod schema (`apps/server/src/mcp/sessions-tools.ts`) and by the HTTP-layer truncation helper, so no layer can drift from the service-level cap.

The auto-curate path (`composeDerivedSummary` invoked from `end()` / `abandonStale()` for sessions with anchored content but no curated summary) SHALL produce output well under `SUMMARY_MAX_CHARS` (the existing template `[auto] N memorias[, P prompts[, C confirmaciones]][ — última: '<80-char snippet>']` already fits in ~120 chars) and SHALL NOT be modified by this requirement.

#### Scenario: `writeSummary` rejects a summary of exactly `SUMMARY_MAX_CHARS + 1`

- **GIVEN** an active session row owned by token `T`
- **WHEN** `agentSessions.writeSummary(sessionId, { tokenId: 'T', summary: 'a'.repeat(2001) })` is called
- **THEN** the call SHALL throw `DomainError('invalid_input', /.*2000.*/)`
- **AND** the row in `sessions` SHALL remain unchanged (no summary written, `summary_final` unchanged)

#### Scenario: `end` rejects an oversized summary atomically with the transition

- **GIVEN** an active session row owned by token `T`
- **WHEN** `agentSessions.end(sessionId, { tokenId: 'T', summary: 'a'.repeat(2001) })` is called
- **THEN** the call SHALL throw `DomainError('invalid_input', /.*2000.*/)`
- **AND** the row SHALL remain `status='active'`, `ended_at=NULL`, summary unchanged (the rejection precedes the transition)

#### Scenario: `summarize` (legacy wrapper) inherits the cap

- **GIVEN** an active session row owned by token `T`
- **WHEN** `agentSessions.summarize(sessionId, { tokenId: 'T', summary: 'a'.repeat(2001) })` is called
- **THEN** the call SHALL throw `DomainError('invalid_input', /.*2000.*/)` and the row SHALL remain unchanged

#### Scenario: `writeSummary` accepts a summary of exactly `SUMMARY_MAX_CHARS`

- **GIVEN** an active session row owned by token `T`, `summary_final = false`
- **WHEN** `agentSessions.writeSummary(sessionId, { tokenId: 'T', summary: 'a'.repeat(2000), final: true })` is called
- **THEN** the call SHALL succeed and the row SHALL have `summary` of length 2000 and `summary_final = true`

#### Scenario: Auto-curate output is well under the cap

- **GIVEN** an active session with 1 anchored memory whose `content` ends with a 200-character paragraph
- **WHEN** `end()` is called with no `summary` argument, triggering `composeDerivedSummary`
- **THEN** the derived `summary` SHALL be of the shape `[auto] 1 memorias — última: '<80-char snippet>'`
- **AND** `summary.length` SHALL be less than `SUMMARY_MAX_CHARS` (well under, by ~1800 chars)
