## ADDED Requirements

### Requirement: The dashboard MUST surface a prompts list view at `/dashboard/prompts`

A logged-in dashboard user SHALL see a list of curated user prompts for the active project (or globally when no project is selected). The list SHALL include columns for title (cascade `title → content[truncated to 80 chars] → shortId`), short prompt id, project slug, session short id (link to session detail when present), agent, tags (comma-separated), and created_at.

The view SHALL paginate at 50 rows per page (`PAGE_SIZE` shared constant). The view SHALL support a free-text query box that submits as the `q` query parameter; when non-empty, the server-side handler SHALL use the FTS5 `prompts_fts` index (matching against `content` + `tags`). The view SHALL support filters by `project_slug`, `session_id` (shortId match), and `agent`.

Each row SHALL render a `Delete` form (soft-delete, `data-confirm-tone="warn"`, action `prompt.delete`). Rows shown under `?include_deleted=1` SHALL additionally render an `Undelete` form (action `prompt.undelete`). A row whose `replaces` is not NULL AND whose `deleted_at` is not NULL SHALL render a `REFINED` badge instead of the default `DELETED` indicator — the `replaces` link encodes that the deletion was the consequence of an agent-driven refine, not an operator action.

The view SHALL NOT include a detail page at `/dashboard/prompts/:id` in this revision; long contents SHALL be expandable inline via an HTMX `<details>` toggle.

#### Scenario: An operator opens the prompts list

- **WHEN** an authenticated admin operator navigates to `/dashboard/prompts`
- **THEN** the server SHALL return a paginated list of the 50 most recent prompts (active and not-deleted) ordered by `created_at DESC`
- **AND** each row SHALL include the documented columns
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

### Requirement: The dashboard sidebar MUST include a `PROMPTS` entry

The primary dashboard navigation (`apps/server/src/dashboard/components.ts::NAV`) SHALL include an entry with `key: 'prompts'`, `num: '03b'`, label `PROMPTS`, `href: '/dashboard/prompts'`, group `MAIN`, placed between the `SESSIONS` entry and the `JUDGMENTS` entry. The `NavKey` union and `NAV_ICONS` table SHALL be extended accordingly.

#### Scenario: Sidebar lists PROMPTS in the MAIN group

- **WHEN** any authenticated dashboard page is rendered
- **THEN** the sidebar SHALL contain an `<a>` linking to `/dashboard/prompts` with the label `PROMPTS`
- **AND** the entry SHALL appear within the `MAIN` group, after `SESSIONS` and before `JUDGMENTS`

### Requirement: The session detail view MUST list anchored prompts below memories

The view at `/dashboard/sessions/:id` SHALL render a new `Prompts (N)` section AFTER the existing `Memories (N)` section. The section SHALL list every row of `prompts` whose `session_id` equals the URL id AND `deleted_at IS NULL`, ordered by `created_at ASC`, with columns: short prompt id, title (cascade), content (truncated to 120 chars), tags, created_at. When the session has no prompts, the section SHALL render `<p class="muted">No prompts anchored to this session.</p>` and SHALL still be emitted (so the `<h2>` is visible).

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

## MODIFIED Requirements

### Requirement: The dashboard MUST surface a sessions list view at `/dashboard/sessions`

A logged-in dashboard user SHALL see a list of recent sessions for the active project (or globally when no project is selected). The list SHALL include columns for title, session id (short form), agent, started_at, ended_at, status, a memory count (number of `memory` rows with that `session_id`), and a prompt count (number of `prompts` rows with that `session_id` AND `deleted_at IS NULL`).

The `title` column SHALL render using the cascade `row.title ?? row.description ?? shortId(row.id)`. The cascade SHALL NOT short-circuit on placeholder titles (e.g. `'rembric · 22:14 UTC'`) — those count as real titles for the purpose of display, because they are still more informative than `shortId` alone. The cascade ensures legacy rows (where `title` is NULL because they predate the column migration) still get a sensible value.

The title column SHALL be the first visible content column (left of session id) and SHALL truncate with `text-overflow: ellipsis` past ~40 chars to keep the table compact. The full title SHALL be available as the cell's `title` attribute (HTML tooltip) so operators can hover to see the full string.

The memory count and the prompt count SHALL be rendered as two separate right-aligned columns (`memories`, `prompts`). The detail view at `/dashboard/sessions/:id` SHALL render BOTH a `Memories (N)` and a `Prompts (N)` table — memories first, prompts below.

#### Scenario: A dashboard user navigates to `/dashboard/sessions`

- **WHEN** the user is authenticated with an admin token and visits `/dashboard/sessions`
- **THEN** the server SHALL return a paginated list of the 50 most recent sessions ordered by `started_at DESC`, with each row linking to `/dashboard/sessions/:id`
- **AND** each row SHALL include a `title` column rendered via the documented cascade
- **AND** each row SHALL include both a `memories` count column and a `prompts` count column

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

### Requirement: Dashboard navigation MUST use a sidebar with persisted collapse state

The dashboard SHALL render its primary navigation as a left-hand vertical sidebar listing the routes Overview, Memories, Sessions, Prompts, Judgments, Consolidation, Projects, Tokens, Maintenance. The sidebar SHALL support a collapsed mode (icons only, narrower fixed width) on desktop viewports and SHALL expose a toggle button to switch states.

The collapse state SHALL be persisted in an HTTP cookie named `rbr-sb-collapsed` (value `1` collapsed, `0` or absent expanded), scoped to `Path=/dashboard`, with `SameSite=Lax`. The server SHALL read this cookie when rendering any dashboard page and SHALL set the root container's class accordingly so the SSR HTML matches the persisted state on first paint.

The toggle SHALL work without JavaScript via a `POST /dashboard/_sidebar/toggle` form submission protected by the existing CSRF mechanism; a small inline script MAY progressively enhance the toggle to apply the collapsed class client-side (so the CSS width transition plays) while it `fetch()`es the same endpoint to persist the cookie.

#### Scenario: Collapsed state survives reload

- **GIVEN** the operator has clicked the sidebar collapse button
- **WHEN** the operator reloads any dashboard page
- **THEN** the SSR HTML SHALL include `class="app is-collapsed"` on the root container, and no client script SHALL be required to apply that class

#### Scenario: Toggle works without JavaScript

- **WHEN** the operator submits the toggle form with JavaScript disabled
- **THEN** the server SHALL flip the `rbr-sb-collapsed` cookie and redirect back to the page the form was submitted from

#### Scenario: CSRF protection on toggle

- **WHEN** `POST /dashboard/_sidebar/toggle` arrives without a valid CSRF token
- **THEN** the server SHALL respond with `403 Forbidden` and SHALL NOT flip the cookie

#### Scenario: Prompts entry appears in the sidebar between Sessions and Judgments

- **WHEN** any authenticated dashboard page is rendered
- **THEN** the sidebar's MAIN group SHALL list, in order: Overview, Memories, Sessions, Prompts, Judgments, Consolidation

### Requirement: The dashboard MUST surface a maintenance view at `/dashboard/maintenance`

The dashboard SHALL serve `GET /dashboard/maintenance` as a top-level page that aggregates physically destructive operations. The page SHALL be reachable only by dashboard sessions whose underlying token has scope `*` (global admin). For dashboard sessions backed by a project-scoped token, the route SHALL respond with `403 forbidden` and a small HTML body explaining the requirement; the sidebar link to `/dashboard/maintenance` SHALL be hidden entirely for those sessions.

The page SHALL contain four regions:

1. **DB breakdown.** A summary card showing the SQLite file size (computed as `page_count × page_size`), the freelist size (`freelist_count × page_size`), and a per-table breakdown of allocated bytes (computed via `dbstat` aggregated by name) sorted descending by size.
2. **Empty sessions card.** A card titled "Purge empty sessions" with the current count of rows matching the predicate in the sessions spec's "Sessions MAY be physically purged when empty" requirement. When the count is zero, the action button SHALL be disabled and copy SHALL read "No empty sessions to purge."
3. **Disconnected archived memories card.** A card titled "Purge disconnected archived memories" with the current count of rows matching the predicate in the memory spec's "Memories MAY be physically purged when archived and disconnected" requirement. When the count is zero, the action button SHALL be disabled and copy SHALL read "No disconnected archived memories to purge."
4. **Deleted prompts card.** A card titled "Purge deleted prompts" with the current count of `prompts` rows whose `deleted_at IS NOT NULL`. When the count is zero, the action button SHALL be disabled and copy SHALL read "No deleted prompts to purge."

All action buttons SHALL use the existing `data-confirm` modal pattern (no new JS) with `data-confirm-tone="danger"`, a `data-confirm-label` that names the count and the action verb (e.g. `PURGE 12 SESSIONS`, `PURGE 4 PROMPTS`), and a `data-confirm` copy that explicitly states the action is irreversible.

#### Scenario: An admin-scope session opens the maintenance page

- **GIVEN** a dashboard session backed by a token with `scope = '*'`
- **WHEN** the session navigates to `/dashboard/maintenance`
- **THEN** the response SHALL be `200 OK`
- **AND** the page SHALL render the DB breakdown and the three purge cards with their pre-flight counts

#### Scenario: A project-scope session opens the maintenance page

- **GIVEN** a dashboard session backed by a token with `scope = 'project:<id>'`
- **WHEN** the session navigates to `/dashboard/maintenance`
- **THEN** the response SHALL be `403 forbidden`
- **AND** the response body SHALL contain copy explaining that maintenance requires an admin-scoped token

#### Scenario: A project-scope session views the sidebar

- **GIVEN** a dashboard session backed by a token with `scope = 'project:<id>'`
- **WHEN** the session renders any dashboard page
- **THEN** the sidebar SHALL NOT contain a link to `/dashboard/maintenance`

#### Scenario: Deleted prompts card with zero eligible rows shows the disabled state

- **GIVEN** there are no rows in `prompts` with `deleted_at IS NOT NULL`
- **WHEN** the admin operator opens `/dashboard/maintenance`
- **THEN** the "Purge deleted prompts" card SHALL render with a disabled action button
- **AND** the card copy SHALL read `No deleted prompts to purge.`

### Requirement: The maintenance page MUST expose admin-only purge actions

The dashboard SHALL expose `POST /dashboard/maintenance/purge-sessions`, `POST /dashboard/maintenance/purge-archived-memories`, AND `POST /dashboard/maintenance/purge-prompts`. All three routes SHALL:

1. Validate the CSRF token using the existing `csrfInput` / `csrfCheck` mechanism. Missing or invalid CSRF SHALL return `403`.
2. Assert the dashboard session's underlying token has `scope = '*'`. Mismatch SHALL return `403`.
3. Call the corresponding service method with `adminBypass: true`.
4. Redirect with `303 See Other` to `/dashboard/maintenance?purged-sessions=N`, `?purged-memories=N`, or `?purged-prompts=N` where `N` is the count actually deleted by the service call.
5. On the subsequent GET, the page SHALL render a flash banner showing the count and the timestamp of the purge.

#### Scenario: An admin-scope session triggers a sessions purge

- **GIVEN** a dashboard session with `scope = '*'`, 12 eligible empty sessions, and a valid CSRF token
- **WHEN** the session POSTs to `/dashboard/maintenance/purge-sessions`
- **THEN** the response SHALL be `303 See Other` with `Location: /dashboard/maintenance?purged-sessions=12`
- **AND** the 12 session rows SHALL no longer exist in `sessions`
- **AND** a `consolidation_ops` row with `op_type='session_purge'` and `affected_ids` of length 12 SHALL exist

#### Scenario: An admin-scope session triggers a prompts purge

- **GIVEN** a dashboard session with `scope = '*'`, 4 deleted prompts, and a valid CSRF token
- **WHEN** the session POSTs to `/dashboard/maintenance/purge-prompts`
- **THEN** the response SHALL be `303 See Other` with `Location: /dashboard/maintenance?purged-prompts=4`
- **AND** the 4 prompt rows SHALL no longer exist in `prompts`
- **AND** a `consolidation_ops` row with `op_type='prompt_purge'` and `affected_ids` of length 4 SHALL exist
- **AND** corresponding rows in `prompts_fts` SHALL be removed by the AFTER DELETE trigger

#### Scenario: A project-scope session attempts a sessions purge

- **GIVEN** a dashboard session with `scope = 'project:<id>'` and a valid CSRF token
- **WHEN** the session POSTs to `/dashboard/maintenance/purge-sessions`
- **THEN** the response SHALL be `403 forbidden`
- **AND** zero rows SHALL be deleted from `sessions`

#### Scenario: A POST without CSRF is rejected before scope is checked

- **GIVEN** any dashboard session
- **WHEN** the session POSTs to `/dashboard/maintenance/purge-archived-memories` WITHOUT a valid CSRF token
- **THEN** the response SHALL be `403 forbidden` and the body SHALL identify the missing CSRF token
- **AND** no service call SHALL have been issued

#### Scenario: A purge POST with count = 0 is a no-op

- **GIVEN** a dashboard session with `scope = '*'`, zero eligible rows, and a valid CSRF token
- **WHEN** the session POSTs to any of the three purge endpoints
- **THEN** the response SHALL be `303 See Other` with `?purged-sessions=0`, `?purged-memories=0`, or `?purged-prompts=0`
- **AND** no `consolidation_ops` row SHALL be written

### Requirement: The maintenance page MUST refresh counts on every GET

The pre-flight counts on `/dashboard/maintenance` SHALL be queried fresh from the database on every GET response. There SHALL NOT be a caching layer between the route handler and SQLite for these counts. This requirement applies to all three purge cards (empty sessions, disconnected archived memories, deleted prompts).

The POST handler SHALL re-run the predicate inside the same transaction as the `DELETE`. If the count visible on the page is stale because rows became eligible between page render and POST, the POST SHALL delete the actually-eligible rows (which may be more or fewer than the displayed count). The redirect query string SHALL reflect the actual deleted count, not the count that was displayed at render time.

#### Scenario: Counts grow between render and click

- **GIVEN** the page renders with `purgeable empty sessions = 12`
- **AND** between render and the operator's click, 2 more sessions become eligible
- **WHEN** the POST handler runs
- **THEN** all 14 eligible sessions SHALL be deleted
- **AND** the redirect SHALL include `?purged-sessions=14`

#### Scenario: Deleted prompts count grows between render and click

- **GIVEN** the page renders with `deleted prompts = 4`
- **AND** between render and the operator's click, 1 more prompt is soft-deleted
- **WHEN** the POST handler runs
- **THEN** all 5 deleted prompts SHALL be physically removed
- **AND** the redirect SHALL include `?purged-prompts=5`
