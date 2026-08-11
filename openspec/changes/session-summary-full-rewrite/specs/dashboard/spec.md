## ADDED Requirements

### Requirement: The session detail view MUST list the summary version history

`/dashboard/sessions/:id` SHALL render a `SUMMARY HISTORY` section below the existing `Summary` block, listing every `session_summary_versions` row for that session **newest first**. Without a reader the table is storage nobody consumes; with one, a summary displaced by a later curated write is recoverable by an operator reading it and handing it back.

Each entry SHALL show its `version`, its `created_at` through the shared timestamp helper (`formatTs`, so the viewer's timezone applies), its content length in characters, and the FULL stored `content` — never a truncated preview. A history that shows only previews cannot serve the one purpose the section has.

The full content SHALL be collapsed by default using native HTML disclosure, so the initial view stays scannable without any JavaScript, consistent with the dashboard shipping no frontend build pipeline. Rendering SHALL use the shared Markdown body helper, matching how the current summary is rendered above it.

The section SHALL be present unconditionally and SHALL state plainly that no versions are recorded when the list is empty. An empty list is the correct state for every session curated before the version table existed, and for every session whose summary was only ever a raw transcript sync; hiding the section would make that indistinguishable from a missing feature.

The newest entry's content equals the `Summary` block above it by the storage invariant (`sessions`, "Every curated session-summary write MUST append a version row in the same transaction"); the duplication is deliberate, because the section's meaning is the sequence and the sequence needs its head.

The read SHALL be an unscoped `admin*` repository read invoked from `src/dashboard/`, and the page SHALL gain NO new form, action or route: there is no restore, edit or delete verb for a version, so no confirmation modal is involved.

#### Scenario: A session with three curated writes shows three versions, newest first

- **GIVEN** a session whose curated summary was written three times with different bodies
- **WHEN** an authenticated operator opens `/dashboard/sessions/:id`
- **THEN** the `SUMMARY HISTORY` section SHALL list three entries ordered `3, 2, 1`
- **AND** each SHALL show its version number, its formatted timestamp, its character count, and its full content
- **AND** entry `3`'s content SHALL equal the `Summary` block rendered above

#### Scenario: A session with no versions says so

- **GIVEN** a session with no `session_summary_versions` rows (curated before the table existed, or never curated)
- **WHEN** the detail view is opened
- **THEN** the section SHALL be present and SHALL state that no summary versions are recorded
- **AND** the page SHALL render without error

#### Scenario: The history exposes no mutation

- **WHEN** the rendered session detail page is inspected
- **THEN** it SHALL contain no form targeting a version row, and no route SHALL exist that edits, restores or deletes one

#### Scenario: Timestamps go through the shared helper

- **WHEN** the template source for the section is inspected
- **THEN** every version timestamp SHALL be emitted via `formatTs` and none SHALL be hand-formatted with `toISOString` or `toLocaleString`
