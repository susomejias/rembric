# dashboard — delta for align-consolidation-dashboard-with-sweep

## MODIFIED Requirements

### Requirement: Consolidation runs MUST be inspectable and reversible from the dashboard

The dashboard SHALL list consolidation runs at `/dashboard/consolidation` and SHALL show per-run details at `/dashboard/consolidation/:id` including each op with its recorded reasoning. Each op SHALL have an "Undo" action; each run SHALL have an "Undo entire run" action. The run detail SHALL render a model indicator only for runs whose `llm_model` is non-null (legacy LLM-era runs); the runs listing SHALL NOT include a model column. The run detail SHALL render sweep summaries (`{"archives":N,"orphaned":M}`) as legible text and SHALL fall back to the raw stored text for runs whose summary does not match that shape. Scope cells in the runs listing and the run detail SHALL render the project slug when the scope refers to an existing project, falling back to the raw scope string otherwise.

#### Scenario: Undoing an op from the dashboard

- **WHEN** the operator clicks "Undo" on a merge op
- **THEN** the server SHALL execute the undo, the page SHALL update to show the op as reverted, and the affected memories SHALL be visible at `/dashboard/memories` in their restored state

#### Scenario: Reverted run is marked

- **GIVEN** every op of a run has been undone
- **WHEN** the operator visits `/dashboard/consolidation`
- **THEN** the run SHALL be visually marked as reverted in the listing

#### Scenario: Legacy LLM run keeps its provenance visible

- **GIVEN** a historical run with `llm_model = 'qwen2.5:7b-instruct-q4_K_M'`
- **WHEN** the operator opens its detail page
- **THEN** the model indicator SHALL be rendered with that value

#### Scenario: Sweep run renders no model indicator

- **GIVEN** a post-LLM sweep run (`llm_model IS NULL`)
- **WHEN** the operator opens its detail page
- **THEN** no model indicator SHALL be rendered

#### Scenario: Sweep summary renders legibly

- **GIVEN** a run whose summary is `{"archives":2,"orphaned":1}`
- **WHEN** the operator opens its detail page
- **THEN** the summary SHALL render as legible text stating 2 archived and 1 orphaned, not raw JSON

#### Scenario: Run scope shows the project slug

- **GIVEN** a run that swept scope `project:<id>` for an existing project with slug `my-app`
- **WHEN** the operator views the runs listing or that run's detail
- **THEN** the scope SHALL display `my-app` rather than the raw `project:<ULID>` string

## ADDED Requirements

### Requirement: The home consolidation-health section MUST describe the lazy sweep truthfully

The dashboard home SHALL describe the consolidation trigger model as it exists — lazy sweep on session start, throttled per scope, with a manual trigger — and SHALL NOT render scheduling or model information sourced from removed configuration (`CONSOLIDATION_CRON`) or from always-null columns. Threshold copy for pending-relation aging SHALL be derived from the configured `JUDGMENT_ORPHAN_AFTER_MS` and `JUDGMENT_ORPHAN_DEADLINE_MS` values, not hardcoded literals. The last-run scope SHALL be rendered as the project slug when the scope refers to an existing project.

#### Scenario: No cron or model copy on the home

- **WHEN** the operator views the dashboard home after at least one sweep run
- **THEN** the consolidation-health section SHALL NOT contain a next-run schedule time nor an LLM model cell, and SHALL state that the sweep triggers on session start

#### Scenario: Orphaning thresholds reflect configuration

- **GIVEN** `JUDGMENT_ORPHAN_DEADLINE_MS` configured to a non-default value
- **WHEN** the operator views the dashboard home
- **THEN** the orphaned-pendings caption SHALL reflect the configured deadline, not a stale literal

#### Scenario: Last-run scope shows the project slug

- **GIVEN** the most recent run swept scope `project:<id>` for an existing project with slug `my-app`
- **WHEN** the operator views the dashboard home
- **THEN** the last-run cell SHALL display `my-app` rather than the raw `project:<ULID>` string

### Requirement: A manual sweep trigger MUST be available from the consolidation view

The dashboard SHALL provide a manual sweep trigger at `/dashboard/consolidation` that posts to a dashboard route gated by the dashboard session and CSRF verification, executes a forced sweep across all scopes, and returns to the consolidation listing. The form SHALL use the confirmation modal with `warn` tone (the sweep's ops are journaled and reversible). The admin endpoint `POST /admin/consolidation/run` SHALL remain unchanged as the automation surface.

#### Scenario: Operator forces a sweep from the dashboard

- **WHEN** the operator confirms the manual sweep action at `/dashboard/consolidation`
- **THEN** the server SHALL execute a forced sweep (bypassing the throttle), a new `consolidation_runs` row SHALL exist per swept scope, and the operator SHALL land back on the runs listing showing them

#### Scenario: Manual sweep requires CSRF

- **WHEN** a POST to the dashboard sweep route arrives without a valid CSRF token
- **THEN** the server SHALL reject the request and no sweep SHALL run

#### Scenario: Manual sweep requires a dashboard session

- **WHEN** an unauthenticated POST hits the dashboard sweep route
- **THEN** the server SHALL redirect to the login page and no sweep SHALL run
