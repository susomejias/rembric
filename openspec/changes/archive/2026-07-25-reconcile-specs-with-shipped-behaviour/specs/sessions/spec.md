## MODIFIED Requirements

### Requirement: Server restart MUST mark in-flight sessions as abandoned

In-process session routing state (`mcp-session-id` → active Rembric session id) is not persisted, so a restart loses every route into a live session and the rows it pointed at can never be closed by their own client.

Stale-active retirement SHALL therefore run at startup **and** periodically thereafter (see "Session rows MUST record last activity, and stale-active retirement MUST be periodic"), and BOTH passes SHALL use the same single retirement query so they cannot diverge. That query SHALL key on `COALESCE(last_activity_at, started_at)` — not on `started_at` alone: a genuinely long-running session that is still being written to would otherwise be retired out from under its client at the 24-hour mark, and a row predating the `last_activity_at` column would otherwise never be retired at all. Rows whose effective last activity is older than the configured `SESSION_ABANDON_AFTER_MS` (default `24h`) SHALL be transitioned to `status = 'abandoned'` with `ended_at = now`.

#### Scenario: Server restarts while a session is active

- **WHEN** the server process exits while a session has `status = 'active'` and the next startup reads an effective last activity older than 24 hours
- **THEN** the session SHALL be flipped to `status = 'abandoned'` and a row in the startup log SHALL record the transition

#### Scenario: Server restarts within the abandon window

- **WHEN** the server restarts and an `active` session's effective last activity is younger than 24h
- **THEN** the row SHALL be left `active`; the next tool call referencing it SHALL be accepted (the agent can `session_end` it explicitly or continue)

#### Scenario: A long-running session is not retired on its start time

- **GIVEN** an `active` session started 3 days ago whose `last_activity_at` is 10 minutes old
- **WHEN** either retirement pass runs
- **THEN** the row SHALL be left `active`

#### Scenario: A row predating the activity column is still retired

- **GIVEN** an `active` session with `last_activity_at IS NULL` and a `started_at` older than the abandon window
- **WHEN** either retirement pass runs
- **THEN** the row SHALL be flipped to `abandoned`
