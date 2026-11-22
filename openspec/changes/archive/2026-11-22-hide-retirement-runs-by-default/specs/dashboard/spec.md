## MODIFIED Requirements

### Requirement: Consolidation runs MUST be inspectable and reversible from the dashboard

The dashboard SHALL list consolidation runs at `/dashboard/consolidation` and SHALL show per-run details at `/dashboard/consolidation/:id` including each op with its recorded reasoning. Each op SHALL have an "Undo" action; each run SHALL have an "Undo entire run" action. The run detail SHALL render sweep summaries (`{"archives":N,"orphaned":M}`, optionally carrying a nested `drain` object) as legible text and SHALL fall back to the raw stored text for runs whose summary does not match that shape. When the nested `drain` object is present, the legible text SHALL also state how many relations the drain orphaned in that run (see the `consolidation` capability, "The drain's outcome MUST be visible to the operator"). When an undo leaves a relation untouched because a verdict was written after the op, the page SHALL say that the undo was partial and why. Scope cells in the runs listing and the run detail SHALL render the project slug when the scope refers to an existing project, falling back to the raw scope string otherwise.

By default the runs listing SHALL leave out retirement runs: runs with scope `maintenance` whose summary is a JSON object with `kind` equal to `retirement_orphan`. The listing SHALL offer a "Show maintenance runs" toggle that keeps its state in the URL query parameter `show-maintenance=1`, so the view can be shared; the listing's pagination links SHALL carry that parameter while it is set. The toggle SHALL only filter the listing and its run count: retirement runs SHALL stay journaled, their detail page and each op's "Undo" SHALL be unchanged, and every other run, including `maintenance` runs of any other kind and runs whose summary is not JSON, SHALL be listed whether or not the toggle is set.

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

#### Scenario: A summary with a drain object shows the drained count

- **GIVEN** a run whose summary holds `archives` 0, `orphaned` 1 and a `drain` object recording two rules drains and one retired-endpoint drain
- **WHEN** the operator opens its detail page
- **THEN** the summary SHALL render as legible text stating 0 archived, 1 orphaned and 3 drained, not raw JSON

#### Scenario: An undo that keeps a later verdict says so

- **GIVEN** a drain op whose relation was later judged through `memory.compare`
- **WHEN** the operator undoes that op from the dashboard
- **THEN** the page SHALL state that the relation was not restored because a later verdict exists, and SHALL show the op as reverted
#### Scenario: Retirement runs are hidden by default

- **GIVEN** a sweep run and a `maintenance` run whose summary is `{"kind":"retirement_orphan","orphaned":1}`
- **WHEN** the operator visits `/dashboard/consolidation` without query parameters
- **THEN** the listing SHALL show the sweep run, SHALL NOT show the retirement run, and its run count SHALL exclude it
- **AND** the page SHALL offer a "Show maintenance runs" link to `/dashboard/consolidation?show-maintenance=1`

#### Scenario: The toggle shows retirement runs

- **GIVEN** the same two runs
- **WHEN** the operator visits `/dashboard/consolidation?show-maintenance=1`
- **THEN** the listing SHALL show both runs, its run count SHALL include the retirement run, and the page SHALL offer a "Hide maintenance runs" link to `/dashboard/consolidation`
- **AND** the retirement run's detail page SHALL still list its ops, each with its "Undo" action

#### Scenario: Pagination keeps the toggle in the URL

- **GIVEN** more runs than fit on one page of the listing
- **WHEN** the operator visits `/dashboard/consolidation?show-maintenance=1`
- **THEN** the "Next" link SHALL point to `/dashboard/consolidation?show-maintenance=1&page=1`
- **AND** without the parameter the "Next" link SHALL point to `/dashboard/consolidation?page=1`

#### Scenario: Other maintenance runs stay listed by default

- **GIVEN** `maintenance` runs whose summaries name the kinds `session_purge`, `archived_memory_purge` and `project_archive_orphan`
- **WHEN** the operator visits `/dashboard/consolidation` without query parameters
- **THEN** the listing SHALL show every one of those runs
