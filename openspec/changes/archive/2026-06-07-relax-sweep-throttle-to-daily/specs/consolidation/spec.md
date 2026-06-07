# consolidation — delta for relax-sweep-throttle-to-daily

## MODIFIED Requirements

### Requirement: The consolidation sweep MUST run lazily on session start, throttled per scope

The server SHALL run the deterministic consolidation sweep (decay + deadline orphaning) as a side effect of session creation — both `POST /api/sessions` / `POST /api/<slug>/sessions` and MCP `memory.session_start` SHALL funnel through the same service method. The sweep SHALL be throttled: it SHALL short-circuit when the most recent `consolidation_runs` row for the target scope is younger than the internal minimum interval (24h). Sweep execution SHALL happen off the request's critical path: a sweep failure SHALL be logged and SHALL NOT fail the session call. A manually triggered run via `POST /admin/consolidation/run` (or the dashboard equivalent) SHALL remain possible at any time and SHALL bypass the throttle.

#### Scenario: First session start after the throttle window triggers a sweep

- **GIVEN** the newest `consolidation_runs` row for the scope is older than the minimum interval (or absent)
- **WHEN** a session is started in that scope
- **THEN** the sweep SHALL run for that scope and a new `consolidation_runs` row SHALL be created with `started_at` set and `llm_provider`/`llm_model` NULL

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
