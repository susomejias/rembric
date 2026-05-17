## MODIFIED Requirements

### Requirement: The consolidation MUST run automatically on a schedule

The server SHALL run a background consolidation on the cron schedule defined by `CONSOLIDATION_CRON` (default `0 3 * * *`) when `CONSOLIDATION_ENABLED = true`. A manually triggered run via HTTP SHALL be possible at any time.

#### Scenario: Scheduled consolidation fires at the configured time

- **WHEN** the configured cron expression matches the current time and `CONSOLIDATION_ENABLED = true`
- **THEN** the consolidation runner SHALL be invoked and a new `consolidation_runs` row SHALL be created with `started_at` set

#### Scenario: Manual run via HTTP

- **WHEN** an operator submits `POST /admin/consolidation/run` with a valid admin bearer token (or clicks the equivalent action in the dashboard at `/dashboard/consolidation`, which posts the same endpoint with a CSRF token)
- **THEN** the consolidation SHALL execute against a running server and SHALL produce a `consolidation_runs` row regardless of the cron schedule

#### Scenario: Disabled consolidation

- **WHEN** `CONSOLIDATION_ENABLED = false`
- **THEN** the cron SHALL NOT fire and no `consolidation_runs` rows SHALL be created automatically
