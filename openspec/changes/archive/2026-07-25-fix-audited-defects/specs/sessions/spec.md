## ADDED Requirements

### Requirement: Session rows MUST record last activity, and stale-active retirement MUST be periodic

Transport-based session resolution refuses to guess when two or more `active` rows match a `(token_id, project_id)` — a deliberate rule that MUST be preserved. But nothing currently makes that ambiguity transient: stale-active retirement runs only at process boot and no activity signal exists on the row, so a single client killed without a lifecycle call (SIGKILL, OOM, a closed terminal) leaves an `active` row for the entire process lifetime. Every subsequent write that does not carry an explicit session id then persists with a null session id, for as long as the server runs.

Session rows SHALL carry a `last_activity_at` timestamp, updated by the session-lifecycle HTTP writes and by MCP writes that resolve to the session. Stale-active retirement SHALL run periodically — not only at boot — and SHALL key on `last_activity_at`. Transport-based resolution SHALL exclude rows whose `last_activity_at` is older than a short staleness window, so a zombie row stops creating ambiguity **without** introducing a recency tiebreak among genuinely-concurrent sessions.

#### Scenario: A killed client no longer blocks auto-attach

- **GIVEN** one `active` session row whose `last_activity_at` is older than the staleness window, and one freshly-active session row for the same `(token_id, project_id)`
- **WHEN** a write without an explicit session id resolves its session
- **THEN** the fresh row SHALL be selected and the stale row SHALL be ignored

#### Scenario: Two genuinely-concurrent sessions still refuse to guess

- **GIVEN** two `active` session rows for the same `(token_id, project_id)` whose `last_activity_at` are both inside the staleness window
- **WHEN** a write without an explicit session id resolves its session
- **THEN** resolution SHALL return no session rather than choosing by recency

#### Scenario: Stale rows are retired without a restart

- **GIVEN** an `active` session row whose `last_activity_at` predates the abandonment window
- **WHEN** the periodic retirement pass runs while the process continues to serve requests
- **THEN** the row SHALL be marked abandoned without requiring a process restart

### Requirement: Confirmations MUST record their originating session when one is resolvable

`confirmations.session_id` exists as an indexed column that no write path populates, so it is permanently null and its index is dead weight. Recording a confirmation SHALL attach the resolved session id when one is available — by the same resolution rules as other session-attaching writes, including an explicit override — so the affirmation channel carries the same provenance as the save channel.

#### Scenario: A confirmation made inside a resolvable session

- **GIVEN** an unambiguous active session for the caller's `(token_id, project_id)`
- **WHEN** `memory.confirm` records a confirmation
- **THEN** the inserted confirmation row SHALL carry that session's id

#### Scenario: A confirmation made with no resolvable session

- **WHEN** `memory.confirm` records a confirmation and no session is resolvable
- **THEN** the confirmation SHALL still be recorded, with a null session id
