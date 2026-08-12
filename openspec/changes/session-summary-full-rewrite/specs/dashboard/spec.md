## ADDED Requirements

### Requirement: The session detail view MUST list the summary version history, capped

`/dashboard/sessions/:id` SHALL render a `SUMMARY HISTORY` section below the existing `Summary` block, listing the `session_summary_versions` rows for that session **newest first**. Without a reader the table is storage nobody consumes; with one, a summary displaced by a later curated write is recoverable by an operator reading it and handing it back.

Each entry SHALL show its `version`, its OWN `title` (the value in effect on `sessions.title` when that version was written — see `sessions`, revising D6 — never the session's CURRENT title, which would misleadingly pair old content with a label minted later), its `created_at` through the shared timestamp helper (`formatTs`, so the viewer's timezone applies), its content length in characters, and the FULL stored `content` — never a truncated preview. A history that shows only previews cannot serve the one purpose the section has.

The full content SHALL be collapsed by default using native HTML disclosure, so the initial view stays scannable without any JavaScript, consistent with the dashboard shipping no frontend build pipeline. Rendering SHALL use the shared Markdown body helper, matching how the current summary is rendered above it.

The section SHALL be present unconditionally and SHALL state plainly that no versions are recorded when the list is empty. An empty list is the correct state for every session curated before the version table existed, and for every session whose summary was only ever a raw transcript sync; hiding the section would make that indistinguishable from a missing feature.

The newest entry's content equals the `Summary` block above it by the storage invariant (`sessions`, "Every curated session-summary write MUST append a version row in the same transaction"); the duplication is deliberate, because the section's meaning is the sequence and the sequence needs its head.

**The section SHALL render at most `SUMMARY_HISTORY_MAX` entries (20), the NEWEST ones.** At the every-10th-turn cadence, a 1000-turn session carries roughly 101 version rows, each up to `SUMMARY_MAX_CHARS` (10 000) characters; rendered unbounded that is a page of several hundred KB to ~1 MB. The section's heading SHALL instead show the TOTAL version count for the session (an unscoped count read, not the length of the rendered page), and when the total exceeds what is shown, the section SHALL state plainly how many are shown and how many exist in total; the OMITTED versions SHALL NOT be inferred as deleted or lost — they remain in the table, simply not rendered on this page load. No pagination control SHALL be added: the newest entries are what a recovery reads first, and a fixed cap needs no new route or query parameter, consistent with this section gaining no new route or form.

The read SHALL be an unscoped `admin*` repository read invoked from `src/dashboard/`, and the page SHALL gain NO new form, action or route: there is no restore, edit or delete verb for a version, so no confirmation modal is involved.

#### Scenario: A session with three curated writes shows three versions, newest first

- **GIVEN** a session whose curated summary was written three times with different bodies and titles
- **WHEN** an authenticated operator opens `/dashboard/sessions/:id`
- **THEN** the `SUMMARY HISTORY` section SHALL list three entries ordered `3, 2, 1`
- **AND** each SHALL show its version number, its OWN title, its formatted timestamp, its character count, and its full content
- **AND** entry `3`'s content SHALL equal the `Summary` block rendered above

#### Scenario: A session with no versions says so

- **GIVEN** a session with no `session_summary_versions` rows (curated before the table existed, or never curated)
- **WHEN** the detail view is opened
- **THEN** the section SHALL be present and SHALL state that no summary versions are recorded
- **AND** the page SHALL render without error

#### Scenario: A session with more versions than the cap shows the newest ones and says how many are omitted

- **GIVEN** a session with `SUMMARY_HISTORY_MAX + 5` version rows
- **WHEN** the detail view is opened
- **THEN** the section SHALL render exactly `SUMMARY_HISTORY_MAX` entries, the newest ones, in descending version order
- **AND** the section's heading SHALL show the TOTAL count, not the rendered count
- **AND** the page SHALL state that older versions exist and are not shown here

#### Scenario: The history exposes no mutation

- **WHEN** the rendered session detail page is inspected
- **THEN** it SHALL contain no form targeting a version row, and no route SHALL exist that edits, restores or deletes one

#### Scenario: Timestamps go through the shared helper

- **WHEN** the template source for the section is inspected
- **THEN** every version timestamp SHALL be emitted via `formatTs` and none SHALL be hand-formatted with `toISOString` or `toLocaleString`
