## MODIFIED Requirements

### Requirement: Memory detail MUST display the history chain

The `/dashboard/memories/:id` view SHALL display the memory's title, content, status, tags, scope, project, source, current confirmation count, `last_seen_at` (rendered via the shared timestamp helper), and a visualization of the `replaces` chain showing all predecessors with their titles, content snapshots, and timestamps. The page heading SHALL be the memory's `title` (not its id); the id SHALL remain available as a secondary metadata chip. For an `active` head whose type has a review TTL, the view SHALL additionally display the derived `reviewState` and `reviewAfter` (the latter rendered via the shared timestamp helper); these fields SHALL be omitted when the head is not `active` or its type has no TTL. When the memory has been superseded (`status = 'superseded'`), the view SHALL additionally render a forward link to its successor (the memory that superseded it, resolved via the existing successor lookup) labelled "Superseded by", pointing to that memory's detail page; this link SHALL be omitted for memories that are not `superseded` or whose successor cannot be resolved.

#### Scenario: Viewing a merged memory

- **GIVEN** memory M was created by merging predecessors A and B via consolidation
- **WHEN** an operator opens `/dashboard/memories/M`
- **THEN** the page SHALL show M's title as its heading, M's content, M's predecessor ids with their titles and content snapshots ordered chronologically, and an "Archive" action

#### Scenario: An active memory needing review shows its review state

- **GIVEN** an `active` memory whose derived `reviewState = 'needs_review'`
- **WHEN** the operator opens its detail view
- **THEN** the metadata block SHALL show `reviewState = needs_review` and the `reviewAfter` timestamp (via the shared timestamp helper)

#### Scenario: A superseded memory links forward to its successor

- **GIVEN** memory M has `status = 'superseded'` and memory N is the row that superseded it
- **WHEN** an operator opens `/dashboard/memories/M`
- **THEN** the page SHALL render a "Superseded by" link pointing to `/dashboard/memories/N`

#### Scenario: An active memory shows no successor link

- **GIVEN** memory M has `status = 'active'`
- **WHEN** an operator opens `/dashboard/memories/M`
- **THEN** the page SHALL NOT render a "Superseded by" link

#### Scenario: last_seen_at is always shown

- **GIVEN** any memory regardless of status or type
- **WHEN** an operator opens its detail view
- **THEN** the metadata block SHALL show `last_seen_at` rendered via the shared timestamp helper

### Requirement: The dashboard MUST surface a maintenance view at `/dashboard/maintenance`

The page SHALL contain five regions:

1. **DB breakdown.** A summary card showing the SQLite file size (computed as `page_count × page_size`), the freelist size (`freelist_count × page_size`), and a per-table breakdown of allocated bytes (computed via `dbstat` aggregated by name) sorted descending by size.
2. **Empty sessions card.** A card titled "Purge empty sessions" with the current count of rows matching the predicate in the sessions spec's "Sessions MAY be physically purged when empty" requirement. When the count is zero, the action button SHALL be disabled and copy SHALL read "No empty sessions to purge."
3. **Disconnected archived memories card.** A card titled "Purge disconnected archived memories" with the current count of rows matching the predicate in the memory spec's "Memories MAY be physically purged when archived and disconnected" requirement. When the count is zero, the action button SHALL be disabled and copy SHALL read "No disconnected archived memories to purge."
4. **Deleted prompts card.** A card titled "Purge deleted prompts" with the current count of `prompts` rows whose `deleted_at IS NOT NULL`. When the count is zero, the action button SHALL be disabled and copy SHALL read "No deleted prompts to purge."
5. **Backup card.** A card titled "Backup database" with a single admin-gated action that triggers an online, WAL-safe snapshot of the SQLite file (reusing the same `VACUUM INTO` mechanism already used internally by the self-update flow) to a timestamped file under the server's data directory, then offers it as an authenticated download. The action SHALL be a form protected by the dashboard's `data-confirm` modal with `data-confirm-tone="warn"` (reversible — it only reads and writes a new file, it never mutates existing data). The card SHALL display the timestamp and size of the most recent on-demand backup, if one exists.

#### Scenario: An operator triggers an on-demand backup

- **WHEN** an admin-scoped operator submits the "Backup database" form
- **THEN** the server SHALL produce a consistent snapshot of the current database via the existing online-backup mechanism
- **AND** the response SHALL offer the resulting file for authenticated download
- **AND** the maintenance page SHALL subsequently show the new backup's timestamp and size

#### Scenario: A non-admin token cannot trigger a backup

- **GIVEN** a dashboard session authenticated with a non-admin-scoped token
- **WHEN** that session requests `/dashboard/maintenance`
- **THEN** the backup card SHALL NOT be rendered, consistent with the existing admin-only gating of the other three action cards

## ADDED Requirements

### Requirement: The Memories sidebar entry MUST surface a needs-review count badge

The dashboard sidebar's `MEMORIES` navigation entry SHALL display a count badge showing the number of `active` memories in the operator's visible scope whose derived `reviewState = 'needs_review'`, mirroring the existing badge pattern on the `JUDGMENTS` sidebar entry (pending-relation count). The badge SHALL be omitted (not rendered as `0`) when the count is zero. This SHALL NOT introduce a new stat card on the `/dashboard` overview page — the overview's six-card stat strip and its deliberate exclusion of backlog-style counters (see "The dashboard home page MUST include a sessions counter") are unchanged.

#### Scenario: Sidebar badge reflects the needs-review count

- **GIVEN** 3 `active` memories in scope whose derived `reviewState = 'needs_review'`
- **WHEN** any authenticated operator loads any dashboard page
- **THEN** the sidebar's `MEMORIES` entry SHALL display a badge reading `3`

#### Scenario: Sidebar badge is omitted when there is nothing to review

- **GIVEN** zero `active` memories in scope with `reviewState = 'needs_review'`
- **WHEN** any authenticated operator loads any dashboard page
- **THEN** the sidebar's `MEMORIES` entry SHALL render with no badge

### Requirement: Paginated list views MUST surface the total page count

Every paginated dashboard list view (`/dashboard/memories`, `/dashboard/sessions`, `/dashboard/prompts`, `/dashboard/judgments`) SHALL render, alongside its existing PREV/NEXT pager controls, a "PAGE X OF Y" indicator computed from the view's existing true filtered total (see "Dashboard list headers MUST report the true filtered total") and the shared `PAGE_SIZE` constant. `Y` SHALL be `ceil(total / PAGE_SIZE)`, with a minimum of 1 even when `total` is 0.

#### Scenario: Page indicator reflects the filtered total

- **GIVEN** a filtered result set of 123 rows and `PAGE_SIZE = 50`
- **WHEN** an operator views page 2 of `/dashboard/memories` with that filter applied
- **THEN** the pager SHALL display "PAGE 2 OF 3"

#### Scenario: Empty result set still shows page 1 of 1

- **GIVEN** a filter that matches zero rows
- **WHEN** an operator views the resulting list
- **THEN** the pager SHALL display "PAGE 1 OF 1"
