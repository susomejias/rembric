## MODIFIED Requirements

### Requirement: Memory detail MUST display the history chain

The `/dashboard/memories/:id` view SHALL display the memory's title, content, status, tags, scope, project, source, current confirmation count, and a visualization of the `replaces` chain showing all predecessors with their titles, content snapshots, and timestamps. The page heading SHALL be the memory's `title` (not its id); the id SHALL remain available as a secondary metadata chip. For an `active` head whose type has a review TTL, the view SHALL additionally display the derived `reviewState` and `reviewAfter` (the latter rendered via the shared timestamp helper); these fields SHALL be omitted when the head is not `active` or its type has no TTL.

The view SHALL additionally provide cross-entity navigation and a re-affirmation action:

- A "Judgments" section listing every relation touching the memory (as source or target): kind, status, the counterpart memory labelled by its title and linked to its detail, and the relevant timestamp via the shared timestamp helper; each row SHALL link to `/dashboard/judgments/:id`. The section SHALL render the unified empty state when no relations touch the memory.
- When the memory has a `session_id`, the metadata block SHALL link it to `/dashboard/sessions/:id`.
- The raw `replaces` ids SHALL render as links to the corresponding memory detail pages (matching the predecessor entries, which already link).
- A Confirm action (CSRF-protected POST) that records a confirmation event via the service layer with source `dashboard-operator`, refreshing the review TTL. The action is non-destructive and SHALL NOT use the destructive-confirmation modal. When `reviewState = 'needs_review'`, the action SHALL be visually associated with the review notice.

#### Scenario: Viewing a merged memory

- **WHEN** the operator opens the detail view for a merged memory M
- **THEN** the page SHALL show M's title as its heading, M's content, M's predecessor ids with their titles and content snapshots ordered chronologically, and an "Archive" action

#### Scenario: Viewing a memory that needs review

- **GIVEN** an `active` memory whose derived `reviewState = 'needs_review'`
- **WHEN** the operator opens its detail view
- **THEN** the metadata block SHALL show `reviewState = needs_review` and the `reviewAfter` timestamp (via the shared timestamp helper)

#### Scenario: The detail heading is the title, not the id

- **WHEN** the operator opens any memory's detail view
- **THEN** the page heading SHALL render the memory's `title`, and the memory id SHALL appear only as a secondary metadata chip

#### Scenario: The detail view shows the memory's source

- **GIVEN** a memory saved with a non-null `source`
- **WHEN** the operator opens its detail view
- **THEN** the metadata block SHALL display the `source` value

#### Scenario: Navigating from a memory to a judgment that touches it

- **GIVEN** a memory that is the source or target of at least one relation
- **WHEN** the operator opens the memory's detail view
- **THEN** the Judgments section SHALL list each such relation with its kind, status, and title-linked counterpart, and each entry SHALL link to the judgment detail view

#### Scenario: Operator confirms a needs-review memory from the dashboard

- **GIVEN** an `active` memory with `reviewState = 'needs_review'`
- **WHEN** the operator submits the Confirm action
- **THEN** a confirmation event with source `dashboard-operator` SHALL be recorded via the service layer, the review TTL SHALL refresh, and the reloaded page SHALL show `reviewState = 'fresh'` with an incremented confirmation count

### Requirement: The dashboard MUST surface a sessions list view at `/dashboard/sessions`

A logged-in dashboard user SHALL see a list of recent sessions for the active project (or globally when no project is selected). The list SHALL include columns for title, agent, started_at, ended_at, status, a memory count (number of `memory` rows with that `session_id`), and a prompt count (number of `prompts` rows with that `session_id` AND `deleted_at IS NULL`). The list SHALL NOT include a session id column; the `title` cell carries the row's anchor to `/dashboard/sessions/:id`.

The list SHALL be ordered with `status = 'active'` rows first, then all remaining rows; within each group rows SHALL be ordered by `started_at DESC`. The ordering SHALL be applied in the SQL query (before `LIMIT`/`OFFSET`) so pagination respects it. The soft-deleted table shown under `?include_deleted=1` keeps plain `started_at DESC`.

The view SHALL provide a filter bar (matching the memories-list pattern) with controls for project, agent, and status. Filters SHALL be applied server-side in the repository query (affecting rows, pagination, and the header total alike) and SHALL apply to the non-deleted table only; the `include_deleted` toggle is unchanged. Each filter control SHALL have an associated `<label>`.

The `title` column SHALL render using the cascade `row.title ?? row.description ?? shortId(row.id)`. The cascade SHALL NOT short-circuit on placeholder titles (e.g. `'rembric · 22:14 UTC'`) — those count as real titles for the purpose of display, because they are still more informative than `shortId` alone. The cascade ensures legacy rows (where `title` is NULL because they predate the column migration) still get a sensible value.

The title column SHALL be the first visible content column and SHALL truncate with `text-overflow: ellipsis` past ~40 chars to keep the table compact. The full title SHALL be available as the cell's `title` attribute (HTML tooltip) so operators can hover to see the full string.

The memory count and the prompt count SHALL be rendered as two separate right-aligned columns (`memories`, `prompts`). The detail view at `/dashboard/sessions/:id` SHALL render BOTH a `Memories (N)` and a `Prompts (N)` table — memories first, prompts below.

#### Scenario: A dashboard user navigates to `/dashboard/sessions`

- **WHEN** the user is authenticated with an admin token and visits `/dashboard/sessions`
- **THEN** the server SHALL return a paginated list of 50 sessions ordered active-first then `started_at DESC`, with each row linking to `/dashboard/sessions/:id` via `data-href` and via the `title` cell's anchor
- **AND** each row SHALL include a `title` column rendered via the documented cascade
- **AND** each row SHALL include both a `memories` count column and a `prompts` count column
- **AND** the table header SHALL NOT contain a `<th>` labelled `id`

#### Scenario: Filtering sessions by agent and status

- **GIVEN** sessions from agents `claude-code` and `opencode` in statuses `active` and `ended`
- **WHEN** the operator applies `?agent=claude-code&status=ended`
- **THEN** the table SHALL contain only `claude-code`/`ended` rows, the pager SHALL paginate the filtered set, and the header total SHALL equal the filtered count

#### Scenario: Active sessions sort above ended ones regardless of age

- **GIVEN** an active session `A` started three days ago and an ended session `E` started one hour ago
- **WHEN** the operator navigates to `/dashboard/sessions`
- **THEN** `A`'s row SHALL appear before `E`'s row
- **AND** two active sessions SHALL order between themselves by `started_at DESC`

#### Scenario: Session with a model-authored title

- **GIVEN** a session whose `sessions.title = 'Fix Stop→SessionEnd bug'`
- **WHEN** the list view renders that row
- **THEN** the title cell SHALL display `'Fix Stop→SessionEnd bug'` (truncated with ellipsis past ~40 chars; full string in `title` attribute)

#### Scenario: Legacy session with no title

- **GIVEN** a session predating the `title` column migration, with `sessions.title = NULL` and `description = NULL`
- **WHEN** the list view renders that row
- **THEN** the title cell SHALL fall back to `shortId(row.id)`

#### Scenario: Session with description but no title

- **GIVEN** a session with `title = NULL` and `description = 'investigate auth bug'`
- **WHEN** the list view renders that row
- **THEN** the title cell SHALL display `'investigate auth bug'`

#### Scenario: A dashboard user opens a session detail page

- **WHEN** the user navigates to `/dashboard/sessions/:id` for an accessible session
- **THEN** the page SHALL display: the title as the `<h1>` (via the same cascade as the list view), the session metadata (agent, project, token name, started_at, ended_at, status), the verbatim `summary` text, a table of memories whose `session_id` matches, AND a table of prompts whose `session_id` matches AND `deleted_at IS NULL` rendered below the memories table

#### Scenario: A session was created by a now-revoked token

- **WHEN** the underlying token has been revoked but the session row still exists
- **THEN** the detail page SHALL still render and SHALL show the token name with a "(revoked)" suffix; the session SHALL not be hidden from the list

#### Scenario: Prompts count column reflects non-deleted prompts only

- **GIVEN** session `S` has 5 prompts: 3 with `deleted_at IS NULL` and 2 with `deleted_at IS NOT NULL`
- **WHEN** the list view renders `S`'s row
- **THEN** the `prompts` column SHALL display `3`

### Requirement: Dashboard list headers MUST report the true filtered total

Every paginated dashboard list view SHALL render a header total chip whose value equals the true number of rows matching the view's current filter set, computed independently of pagination — NOT the count of rows present on the current page. The page-slice count SHALL remain available as a distinct `SHOWING N ROWS` indicator (in the header meta and/or the pager footer), and the `SHOWING` value SHALL equal the number of rows actually rendered on the page (never including any pagination lookahead row). This requirement applies to the memories (`/dashboard/memories`), sessions (`/dashboard/sessions`), judgments (`/dashboard/judgments`), consolidation-runs (`/dashboard/consolidation`), and prompts (`/dashboard/prompts`) list views.

The true count SHALL be produced by an `admin*`-prefixed repository read that applies the SAME filter conditions as the view's corresponding `admin*List*` query and omits `LIMIT`/`OFFSET`/`ORDER BY`. All such counting SQL SHALL live under `apps/server/src/db/repositories/` and SHALL be invoked only from `apps/server/src/dashboard/`, satisfying the data-access and admin-method confinement invariants. No new MCP tool, HTTP route, DB migration, or design token SHALL be introduced.

The tokens list (`/dashboard/tokens`) already reports the true count because its source list is unpaginated; it is the reference pattern and is exempt from any change under this requirement.

#### Scenario: Sessions list total counts all non-deleted sessions

- **GIVEN** 37 non-deleted agent sessions with the page size at 10
- **WHEN** the operator opens `/dashboard/sessions`
- **THEN** the header total chip SHALL read `37`, not the count of rows on the current page

#### Scenario: Judgments list total counts all rows for the active filter

- **GIVEN** 64 `memory_relations` rows with `status = 'pending'` and the page size at 10
- **WHEN** the operator opens `/dashboard/judgments?status=pending`
- **THEN** the header SHALL render a total chip reading `64`
- **AND** the `SHOWING N ROWS` indicator SHALL reflect only the page slice

#### Scenario: Consolidation runs total counts all runs

- **GIVEN** 25 `consolidation_runs` rows with the page size at 10
- **WHEN** the operator opens `/dashboard/consolidation`
- **THEN** the header total chip SHALL read `25`, not the page-slice count

#### Scenario: Prompts list total counts all rows for the active filter

- **GIVEN** 23 non-deleted `prompts` rows matching the active filter with the page size at 10
- **WHEN** the operator opens `/dashboard/prompts`
- **THEN** the header SHALL render a total chip reading `23` alongside the existing `SHOWING` indicator

#### Scenario: SHOWING never counts the pagination lookahead

- **GIVEN** a list view whose query fetches `PAGE_SIZE + 1` rows to detect a next page
- **WHEN** a full page renders
- **THEN** the `SHOWING` indicator SHALL read `PAGE_SIZE`, not `PAGE_SIZE + 1`

#### Scenario: Counting SQL stays in the repository layer

- **WHEN** a contributor inspects the dashboard handlers and runs the data-access confinement invariant test
- **THEN** all counting SQL for these totals SHALL reside under `apps/server/src/db/repositories/`
- **AND** every count method SHALL carry the `admin*` prefix and be called only from `apps/server/src/dashboard/`

#### Scenario: Tokens list is unchanged

- **WHEN** the operator opens `/dashboard/tokens`
- **THEN** the header total chip SHALL continue to reflect the full, unpaginated token count with no behavioural change
