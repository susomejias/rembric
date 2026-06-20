## MODIFIED Requirements

### Requirement: Consolidation runs MUST be inspectable and reversible from the dashboard

The dashboard SHALL list consolidation runs at `/dashboard/consolidation` and SHALL show per-run details at `/dashboard/consolidation/:id` including each op with its recorded reasoning. Each op SHALL have an "Undo" action; each run SHALL have an "Undo entire run" action. The run detail SHALL render sweep summaries (`{"archives":N,"orphaned":M}`) as legible text and SHALL fall back to the raw stored text for runs whose summary does not match that shape. Scope cells in the runs listing and the run detail SHALL render the project slug when the scope refers to an existing project, falling back to the raw scope string otherwise.

#### Scenario: Undoing an op from the dashboard

- **WHEN** the operator clicks "Undo" on a merge op
- **THEN** the server SHALL execute the undo, the page SHALL update to show the op as reverted, and the affected memories SHALL be visible at `/dashboard/memories` in their restored state

#### Scenario: Reverted run is marked

- **GIVEN** every op of a run has been undone
- **WHEN** the operator visits `/dashboard/consolidation`
- **THEN** the run SHALL be visually marked as reverted in the listing

#### Scenario: Sweep summary renders legibly

- **GIVEN** a run whose summary is `{"archives":2,"orphaned":1}`
- **WHEN** the operator opens its detail page
- **THEN** the summary SHALL render as legible text stating 2 archived and 1 orphaned, not raw JSON

#### Scenario: Run scope shows the project slug

- **GIVEN** a run that swept scope `project:<id>` for an existing project with slug `my-app`
- **WHEN** the operator views the runs listing or that run's detail
- **THEN** the scope SHALL display `my-app` rather than the raw `project:<ULID>` string
