## MODIFIED Requirements

### Requirement: The consolidation sweep MUST run lazily on session start, throttled per scope

The server SHALL run the deterministic consolidation sweep (decay + deadline orphaning + empty-session purge) as a side effect of session creation — both `POST /api/sessions` / `POST /api/<slug>/sessions` and MCP `memory.session_start` SHALL funnel through the same service method. The sweep SHALL be throttled: it SHALL short-circuit when the most recent `consolidation_runs` row for the target scope is younger than the internal minimum interval (24h). Sweep execution SHALL happen off the request's critical path: a sweep failure SHALL be logged and SHALL NOT fail the session call. A manually triggered run via `POST /admin/consolidation/run` (or the dashboard equivalent) SHALL remain possible at any time and SHALL bypass the throttle.

The sweep's empty-session purge step SHALL invoke `AgentSessionsService.purgeEmpty` — the same method already reachable manually from `/dashboard/maintenance` — using the session capability's `sessionHasContent` predicate to decide eligibility. It SHALL introduce no new scheduling primitive, admin-bypass surface, or throttle beyond the sweep's own; a purge performed this way SHALL journal to `consolidation_ops` identically to a manually-triggered one.

#### Scenario: First session start after the throttle window triggers a sweep

- **GIVEN** the newest `consolidation_runs` row for the scope is older than the minimum interval (or absent)
- **WHEN** a session is started in that scope
- **THEN** the sweep SHALL run for that scope and a new `consolidation_runs` row SHALL be created with `started_at` set

#### Scenario: Session start within the throttle window skips the sweep

- **GIVEN** a `consolidation_runs` row for the scope younger than the minimum interval
- **WHEN** a session is started in that scope
- **THEN** no sweep SHALL run and no new `consolidation_runs` row SHALL be created

#### Scenario: Sweep failure does not break session start

- **WHEN** the sweep throws after a session has been created
- **THEN** the session call SHALL still succeed and the failure SHALL be logged

#### Scenario: Manual run bypasses the throttle

- **WHEN** an operator submits `POST /admin/consolidation/run` with a valid admin bearer token
- **THEN** the sweep SHALL execute immediately regardless of the throttle and SHALL produce a `consolidation_runs` row

#### Scenario: A noise session is purged automatically without operator action

- **GIVEN** a session `S` that fails `sessionHasContent` (a raw uncurated summary and nothing else anchored to it) and is older than the existing purge-eligibility age floor
- **WHEN** the consolidation sweep next runs for `S`'s scope, subject to the existing throttle
- **THEN** `S` SHALL be physically deleted by the same code path `purgeEmpty` already uses when triggered manually
- **AND** a `consolidation_ops` row SHALL record the purge, identical in shape to a manually-triggered one

#### Scenario: The manual dashboard trigger is unaffected

- **WHEN** an operator clicks the existing purge button on `/dashboard/maintenance`
- **THEN** behavior SHALL be unchanged — this requirement only adds an additional, automatic invocation site inside the existing sweep
