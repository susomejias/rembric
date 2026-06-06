# Dashboard delta — declutter-table-id-columns

## ADDED Requirements

### Requirement: List tables MUST NOT spend a column on row ids

Dashboard list tables SHALL NOT render a dedicated `id` column. Row identity is carried by the row's semantic cell (title, content, or timestamp), and navigation to a detail page — where one exists — is provided by whole-row `data-href` plus exactly one real `<a href>` anchor hosted on that semantic cell, so cmd-click / middle-click / keyboard navigation keep working.

Concretely:

- Sessions list: the `title` cell carries the anchor to `/dashboard/sessions/{id}` (rows keep `data-href`).
- Memories list, session detail → Memories, memory detail → Predecessors: the `content` cell carries the anchor to `/dashboard/memories/{id}` (rows keep `data-href`).
- Consolidation runs list: the `started` cell carries the anchor to `/dashboard/consolidation/{id}` (rows keep `data-href`).
- Judgments list: the `created` cell carries the anchor to `/dashboard/judgments/{id}` (rows gain `data-href`).
- Projects (active + archived), prompts list, session detail → Prompts, consolidation run detail → Ops: the id column is removed with no replacement anchor — these rows have no detail page. Memory shortId anchors inside the ops table's `affected` / `created` cells are retained: they are cross-navigation, not row identity.

`shortId(...)` rendering remains in use outside list-table columns (detail-page headings such as `Rembric Memory {shortId}.`, ops `affected`/`created` cells, prompt session links).

#### Scenario: A navigable list row keeps exactly one real anchor

- **WHEN** an authenticated operator renders any list whose rows have a detail page (sessions, memories, consolidation runs, judgments, predecessors, session-detail memories)
- **THEN** each row SHALL carry `data-href` pointing at its detail URL
- **AND** each row SHALL contain exactly one `<a>` anchor pointing at that same detail URL, hosted on the row's semantic cell
- **AND** no `<th>` labelled `id` SHALL be present in the table header

#### Scenario: Tables without detail pages drop the id column with no replacement

- **WHEN** an authenticated operator renders the projects, prompts, session-detail prompts, or run-detail ops tables
- **THEN** no `<th>` labelled `id` SHALL be present and no cell SHALL render the row's own short id
- **AND** row action forms SHALL keep functioning (they carry the full id in their `action` URLs)

## MODIFIED Requirements

### Requirement: The dashboard MUST surface a sessions list view at `/dashboard/sessions`

A logged-in dashboard user SHALL see a list of recent sessions for the active project (or globally when no project is selected). The list SHALL include columns for title, agent, started_at, ended_at, status, a memory count (number of `memory` rows with that `session_id`), and a prompt count (number of `prompts` rows with that `session_id` AND `deleted_at IS NULL`). The list SHALL NOT include a session id column; the `title` cell carries the row's anchor to `/dashboard/sessions/:id`.

The list SHALL be ordered with `status = 'active'` rows first, then all remaining rows; within each group rows SHALL be ordered by `started_at DESC`. The ordering SHALL be applied in the SQL query (before `LIMIT`/`OFFSET`) so pagination respects it. The soft-deleted table shown under `?include_deleted=1` keeps plain `started_at DESC`.

The `title` column SHALL render using the cascade `row.title ?? row.description ?? shortId(row.id)`. The cascade SHALL NOT short-circuit on placeholder titles (e.g. `'rembric · 22:14 UTC'`) — those count as real titles for the purpose of display, because they are still more informative than `shortId` alone. The cascade ensures legacy rows (where `title` is NULL because they predate the column migration) still get a sensible value.

The title column SHALL be the first visible content column and SHALL truncate with `text-overflow: ellipsis` past ~40 chars to keep the table compact. The full title SHALL be available as the cell's `title` attribute (HTML tooltip) so operators can hover to see the full string.

The memory count and the prompt count SHALL be rendered as two separate right-aligned columns (`memories`, `prompts`). The detail view at `/dashboard/sessions/:id` SHALL render BOTH a `Memories (N)` and a `Prompts (N)` table — memories first, prompts below.

#### Scenario: A dashboard user navigates to `/dashboard/sessions`

- **WHEN** the user is authenticated with an admin token and visits `/dashboard/sessions`
- **THEN** the server SHALL return a paginated list of 50 sessions ordered active-first then `started_at DESC`, with each row linking to `/dashboard/sessions/:id` via `data-href` and via the `title` cell's anchor
- **AND** each row SHALL include a `title` column rendered via the documented cascade
- **AND** each row SHALL include both a `memories` count column and a `prompts` count column
- **AND** the table header SHALL NOT contain a `<th>` labelled `id`

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

### Requirement: The judgment-queue view MUST be served at `/dashboard/judgments`

The dashboard SHALL serve the operator-facing queue of memory-relation judgments at the URL `/dashboard/judgments`. The page SHALL list every row of `memory_relations` (status `pending`, `judged`, or `orphaned`), SHALL support filtering by status and verdict kind, and SHALL paginate results. The legacy path `/dashboard/relations` SHALL NOT respond; any request to it SHALL return the standard dashboard `404` body.

The page heading SHALL read `Rembric Judgments.` (with `Rembric` highlighted via `hl-lime`), the document `<title>` SHALL read `Judgments · Rembric`, the empty-state cell SHALL read `No judgments match this filter.`, the table column previously labelled `relation` SHALL be labelled `verdict`, and the orphan-not-found flash SHALL read `Judgment not found or already closed.`.

The list SHALL NOT render an `id` column. Each row SHALL carry `data-href="/dashboard/judgments/{id}"` (whole-row click navigation, consistent with the sessions/memories/consolidation lists), and the `created` cell SHALL contain the row's real `<a href="/dashboard/judgments/{id}">` anchor wrapping the `formatTs(created_at)` output. The whole-row click handler's interactive-element bail-out keeps the memory anchors in `source → target` and the `Mark orphaned` form working inside the clickable row.

The `source → target` column SHALL render each side as an `<a href="/dashboard/memories/{id}">` anchor whose visible text is the corresponding memory's `content` truncated to 60 characters (not the memory's short id). The two anchors SHALL be separated by the `→` arrow as before.

The `verdict` column SHALL render via the shared `verdictPill(relation)` helper. When `relation` is non-null the cell SHALL contain a `<span class="pill k-{relation}">{relation}</span>` element (matching the home overview's `RECENT JUDGMENTS` tile). When `relation` is null (pending or orphaned rows) the cell SHALL contain the muted em-dash `<span class="muted">—</span>`. No inline `pill k-…` HTML SHALL exist in the judgments page template.

#### Scenario: Operator opens the judgment queue

- **WHEN** an authenticated operator navigates to `/dashboard/judgments`
- **THEN** the server SHALL return a `200` HTML response whose heading reads `Rembric Judgments.` and whose table column header for the relation kind reads `verdict`
- **AND** the table header SHALL NOT contain a `<th>` labelled `id`

#### Scenario: Judgment rows are whole-row clickable

- **WHEN** an authenticated operator navigates to `/dashboard/judgments` with at least one row present
- **THEN** each row SHALL carry `data-href="/dashboard/judgments/{id}"` where `{id}` is that row's `memory_relations.id`
- **AND** the row's `created` cell SHALL contain an `<a href="/dashboard/judgments/{id}">` anchor wrapping the rendered timestamp

#### Scenario: Legacy `/dashboard/relations` returns 404

- **WHEN** any authenticated request reaches `/dashboard/relations`
- **THEN** the server SHALL respond with `404 Not Found` (no redirect)

#### Scenario: Sidebar and home links to the judgments view

- **WHEN** any authenticated dashboard page is rendered
- **THEN** the sidebar nav item labelled `JUDGMENTS` SHALL have `href="/dashboard/judgments"`
- **AND** the home overview `RECENT JUDGMENTS` section header `OPEN ALL ›` anchor SHALL link to `/dashboard/judgments` (the unfiltered default view)
- **AND** the home overview stat strip SHALL NOT include a `PENDING JUDGMENTS` stat card; pending counts are surfaced only via the sidebar badge on the `JUDGMENTS` nav entry

#### Scenario: CSRF action token uses the judgment vocabulary

- **WHEN** the operator submits the "mark this judgment as orphaned" form on the judgments page
- **THEN** the CSRF token issued by the form and the action verified by the server SHALL both be the string `judgment.orphan`

### Requirement: The dashboard MUST surface a prompts list view at `/dashboard/prompts`

A logged-in dashboard user SHALL see a list of curated user prompts for the active project (or globally when no project is selected). The list SHALL include columns for title (cascade `title → content[truncated to 80 chars] → shortId`), project slug, session short id (link to session detail when present), agent, tags (comma-separated), and created_at. The list SHALL NOT include a prompt id column.

The view SHALL paginate at 50 rows per page (`PAGE_SIZE` shared constant). The view SHALL support a free-text query box that submits as the `q` query parameter; when non-empty, the server-side handler SHALL use the FTS5 `prompts_fts` index (matching against `content` + `tags`). The view SHALL support filters by `project_slug`, `session_id` (shortId match), and `agent`.

Each row SHALL render a `Delete` form (soft-delete, `data-confirm-tone="warn"`, action `prompt.delete`). Rows shown under `?include_deleted=1` SHALL additionally render an `Undelete` form (action `prompt.undelete`). A row whose `replaces` is not NULL AND whose `deleted_at` is not NULL SHALL render a `REFINED` badge instead of the default `DELETED` indicator — the `replaces` link encodes that the deletion was the consequence of an agent-driven refine, not an operator action.

The view SHALL NOT include a detail page at `/dashboard/prompts/:id` in this revision; long contents SHALL be expandable inline via an HTMX `<details>` toggle.

#### Scenario: An operator opens the prompts list

- **WHEN** an authenticated admin operator navigates to `/dashboard/prompts`
- **THEN** the server SHALL return a paginated list of the 50 most recent prompts (active and not-deleted) ordered by `created_at DESC`
- **AND** each row SHALL include the documented columns
- **AND** the table header SHALL NOT contain a `<th>` labelled `id`
- **AND** each row SHALL include a `Delete` form using `data-confirm` modal attributes on the `<form>` element

#### Scenario: An operator searches prompts by content

- **GIVEN** prompts exist with content "deploy via Docker Compose" and "refactor the auth middleware"
- **WHEN** the operator submits `?q=deploy` on `/dashboard/prompts`
- **THEN** the server SHALL return only the first prompt
- **AND** the SQL query SHALL use a `JOIN` against `prompts_fts MATCH 'deploy'`

#### Scenario: An operator filters by session

- **GIVEN** session `S1` has 3 prompts and session `S2` has 1 prompt
- **WHEN** the operator submits `?session=<S1-shortId>`
- **THEN** the response SHALL contain exactly the 3 prompts whose `session_id = S1.id`

#### Scenario: Soft-deleted prompts are hidden by default

- **GIVEN** prompts `P1`, `P2` exist and `P2.deleted_at IS NOT NULL`
- **WHEN** the operator navigates to `/dashboard/prompts`
- **THEN** the response SHALL contain `P1` and SHALL NOT contain `P2`

#### Scenario: `?include_deleted=1` reveals deleted prompts with Undelete actions

- **GIVEN** prompts `P1`, `P2` exist and `P2.deleted_at IS NOT NULL`
- **WHEN** the operator navigates to `/dashboard/prompts?include_deleted=1`
- **THEN** the response SHALL contain both prompts
- **AND** `P2`'s row SHALL render an `Undelete` form using CSRF action `prompt.undelete`

#### Scenario: A refined prompt renders a REFINED badge

- **GIVEN** prompt `P1` was refined: its `deleted_at IS NOT NULL` and there exists a successor `P2` with `P2.replaces = ['<P1.id>']`
- **WHEN** the operator navigates to `/dashboard/prompts?include_deleted=1`
- **THEN** `P1`'s row SHALL render a `REFINED` badge (NOT the default `DELETED` indicator)

#### Scenario: Delete form opens the confirmation modal

- **GIVEN** an authenticated admin operator viewing the prompts list
- **WHEN** the operator clicks the `Delete` button of a row
- **THEN** the global `#rbr-confirm` dialog SHALL open with `data-confirm-tone="warn"` styling
- **AND** the form SHALL submit only after the operator confirms via the dialog

### Requirement: The session detail view MUST list anchored prompts below memories

The view at `/dashboard/sessions/:id` SHALL render a new `Prompts (N)` section AFTER the existing `Memories (N)` section. The section SHALL list every row of `prompts` whose `session_id` equals the URL id AND `deleted_at IS NULL`, ordered by `created_at ASC`, with columns: title (cascade), content (truncated to 120 chars), tags, created_at — no prompt id column. When the session has no prompts, the section SHALL render `<p class="muted">No prompts anchored to this session.</p>` and SHALL still be emitted (so the `<h2>` is visible).

#### Scenario: Session with prompts and memories renders both sections

- **GIVEN** session `S` with 3 anchored memories and 2 anchored non-deleted prompts
- **WHEN** the operator opens `/dashboard/sessions/<S.id>`
- **THEN** the response HTML SHALL contain a `<h2>Memories (3)</h2>` section BEFORE a `<h2>Prompts (2)</h2>` section

#### Scenario: Session with only memories shows an empty-state prompts section

- **GIVEN** session `S` with 1 anchored memory and 0 anchored prompts
- **WHEN** the operator opens `/dashboard/sessions/<S.id>`
- **THEN** the response HTML SHALL contain a `<h2>Prompts (0)</h2>` section
- **AND** the prompts area SHALL render `No prompts anchored to this session.`

#### Scenario: Soft-deleted prompts are excluded from the session detail count

- **GIVEN** session `S` has 3 prompts with `session_id = S.id` and one of them has `deleted_at IS NOT NULL`
- **WHEN** the operator opens `/dashboard/sessions/<S.id>`
- **THEN** the rendered `<h2>` SHALL read `Prompts (2)`
- **AND** the deleted prompt SHALL NOT appear in the table

### Requirement: The dashboard MUST surface a judgment detail view at `/dashboard/judgments/:id`

The dashboard SHALL serve a per-row detail page at `/dashboard/judgments/:id` (where `:id` is the `memory_relations.id` primary key). The page SHALL load the judgment row alongside the source and target memory contents (JOIN over `memory` twice) and SHALL render:

- A `viewHead` whose title is `Rembric Judgment {shortId}.` with `Rembric` highlighted via `hl-lime`, and whose meta strip exposes `STATUS` and `VERDICT`.
- A `BACK TO JUDGMENTS` back-link to `/dashboard/judgments`.
- A stat grid with six cards: Status (rendered via `statusPill`), Verdict (rendered via `verdictPill`), Confidence, Marked by (`marked_by_kind` + `marked_by_actor`), Created (`formatTs(created_at)`), Judged (`formatTs(judged_at)` or em-dash when null).
- A `Source` section with the source memory's short id rendered as an anchor to `/dashboard/memories/{sourceId}` followed by a `<pre>` block with the full untruncated source content.
- A `Target` section structured identically for the target memory.
- A `Reason` section showing the verbatim `reason` text or an em-dash when null.
- An `Evidence` section showing the `evidence` JSON pretty-printed inside a `<pre>` block, or an em-dash when null.
- A `Judgment id` section showing the opaque `judgment_id` token in mono.
- An `Actions` section: when `status='pending'` the section SHALL render the existing `judgment.orphan` form (CSRF-protected, `data-confirm-tone="danger"`); otherwise it SHALL render a muted "No actions available — this judgment is closed." line.

When the `:id` does not match any row, the page SHALL respond with `404 Not Found` and a `Judgment not found.` flash, using the standard dashboard shell.

#### Scenario: Operator opens a judgment detail page

- **WHEN** an authenticated operator navigates to `/dashboard/judgments/{id}` where `id` matches an existing `memory_relations.id`
- **THEN** the server SHALL return a `200` HTML response whose heading reads `Rembric Judgment {shortId}.`, and whose body contains the source memory's full content inside a `<pre>` block, the target memory's full content inside a `<pre>` block, anchors to both `/dashboard/memories/{sourceId}` and `/dashboard/memories/{targetId}`, and the verdict pill rendered via `verdictPill`

#### Scenario: Judgment detail returns 404 for unknown ids

- **WHEN** an authenticated operator navigates to `/dashboard/judgments/non-existent-id`
- **THEN** the server SHALL respond with `404 Not Found` and the response body SHALL contain the flash text `Judgment not found.`

#### Scenario: Recent-judgments tile exposes a VIEW button to the detail page

- **WHEN** the home overview is rendered with at least one judged row
- **THEN** each row SHALL contain a `.btn.primary.sm` anchor labelled `VIEW →` inside the row's `.acts` slot, whose `href` is `/dashboard/judgments/{id}` (where `{id}` is the corresponding `memory_relations.id`)
- **AND** the verdict pill itself SHALL NOT be wrapped in an anchor (no click conflict with the memory links in the row)

#### Scenario: Judgments list created cell links to the detail page

- **WHEN** the operator navigates to `/dashboard/judgments` with at least one row present
- **THEN** each row's `created` cell SHALL contain an `<a href="/dashboard/judgments/{id}">` anchor wrapping the rendered timestamp, where `{id}` is that row's `memory_relations.id`
- **AND** the list SHALL NOT render a standalone short-id cell for the judgment's own id
