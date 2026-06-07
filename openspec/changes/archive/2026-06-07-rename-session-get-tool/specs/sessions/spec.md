## REMOVED Requirements

### Requirement: `memory.get_session` returns a session's full summary by id

**Reason**: Renamed to `memory.session_get` for consistency with the `memory.session_*` tool family (`memory.session_start` / `memory.session_end` / `memory.session_summary`). Behavior, arguments, scope-resolution, and `not_found` semantics are unchanged — only the tool name changes.

**Migration**: Callers invoke `memory.session_get({ sessionId })` instead of `memory.get_session({ sessionId })`. The argument shape and response are identical. No data migration. The old name was released in server-v0.21.7 with no adopters; no plugin client referenced it.

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
