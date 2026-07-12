# dashboard Specification

## Purpose

Defines the server-rendered web dashboard that lets operators authenticate, browse memories, inspect consolidation runs, and manage tokens — without a frontend build pipeline.

## Requirements

### Requirement: The dashboard MUST be served at `/dashboard`

The server SHALL serve a server-side rendered web dashboard at the `/dashboard` path of the same process and port as the MCP endpoint. Static assets (HTMX and Pico.css) SHALL be served from `/dashboard/assets/` and SHALL be bundled inside the npm package; no CDN dependency at runtime.

#### Scenario: Dashboard home is reachable

- **WHEN** an authenticated operator navigates to `/dashboard`
- **THEN** the server SHALL return an HTML page with the layout, stats summary, and navigation rendered server-side

### Requirement: Dashboard access MUST require authentication

The dashboard SHALL require a valid signed session cookie to access any route other than `/dashboard/login`. The login route SHALL accept the admin token submitted via a form, validate it against the `tokens` table, and on success SHALL set an httpOnly, SameSite=Lax, signed cookie referencing a row in `dashboard_sessions`.

#### Scenario: Unauthenticated access redirects to login

- **WHEN** an unauthenticated request hits `/dashboard/memories`
- **THEN** the server SHALL respond with a 302 redirect to `/dashboard/login`

#### Scenario: Login with admin token

- **WHEN** the operator submits the admin token at `/dashboard/login`
- **THEN** the server SHALL validate the token, create a `dashboard_sessions` row, set the signed cookie, and redirect to `/dashboard`

#### Scenario: Logout

- **WHEN** the operator triggers logout
- **THEN** the corresponding `dashboard_sessions` row SHALL be deleted and the cookie SHALL be cleared

### Requirement: Memory browsing MUST support filters and pagination

The `/dashboard/memories` view SHALL support filtering by project, type, status, **review state**, and free-text search, and SHALL paginate results. All filtering SHALL be performed server-side; the form SHALL be progressively enhanced with HTMX so it updates without a full page reload.

The view SHALL render review state in a dedicated `review` column (separate from `status`, because review is an orthogonal axis — a freshness signal, not a lifecycle value): each `active` row whose derived `reviewState = 'needs_review'` (derivation per the `memory` capability) SHALL show a `needs_review` badge in that column; all other rows SHALL show a neutral placeholder. The badge SHALL use the existing `.pill` atom and the locked palette — no new design token is introduced. The filter form SHALL include a `review` control with values `(any)` (default) and `needs_review`; when `review = needs_review` the list SHALL show only `active` memories deriving `needs_review`, computed server-side with the per-type TTL pushed into SQL so pagination is correct, respecting the current project filter and preserving all active filters across HTMX swaps.

The view header SHALL render a `TOTAL` meta chip whose value is the true count of rows matching the **current filter set** (the combined scope/status/type/review/search filters), independent of pagination — NOT the count of rows on the current page. The header SHALL also render a `SHOWING N ROWS` indicator carrying the page-slice count. The true count SHALL be computed by a dashboard-only, `admin*`-prefixed repository read so that no counting SQL leaves the `src/db/` layer. For the FTS-search branch the count SHALL be the number of rows matching the search expression **within the current scope/status/type filter** — mirroring the client-side filter the list applies to the FTS page — not the raw match count (which would over-report by including superseded/out-of-scope rows the list drops) and not the page slice; for the `needs_review`-only branch it SHALL be the number of active rows deriving `needs_review` for the active project filter.

For the single combination of `review = needs_review` AND a non-empty free-text query — where review state is derived after the page slice rather than in SQL — the `TOTAL` chip SHALL render the page-slice count suffixed with `+` (a "at least N" lower bound) rather than an inexact exact-looking number.

#### Scenario: Filtering by status

- **WHEN** the operator selects `status = 'archived'` in the filter form
- **THEN** the resulting page SHALL show only memories with `status = 'archived'`, respecting the current project filter

#### Scenario: Filtering by review state

- **WHEN** the operator selects `review = needs_review` in the filter form
- **THEN** the resulting page SHALL show only `active` memories whose derived `reviewState = 'needs_review'`, respecting the current project filter, and SHALL paginate correctly (each page honors `limit`)

#### Scenario: A stale active row shows the needs_review badge

- **GIVEN** an `active` memory whose derived `reviewState = 'needs_review'`
- **WHEN** the operator views it on `/dashboard/memories` (under any filter that includes it)
- **THEN** its row SHALL render a `needs_review` badge in the `review` column (distinct from the `status` column)
- **AND** a `fresh`, `superseded`, `archived`, or no-TTL-type row SHALL show the neutral placeholder, not the badge

#### Scenario: Badge and filter agree

- **GIVEN** a row that renders the `needs_review` badge
- **WHEN** the operator applies `review = needs_review`
- **THEN** that row SHALL appear in the filtered result

#### Scenario: Pagination

- **WHEN** the operator clicks "next page"
- **THEN** the page SHALL reload with the next `limit` rows offset, preserving all active filters (including `review`)

#### Scenario: TOTAL reflects the true filtered count, not the page slice

- **GIVEN** a filter set matching 248 memories with the page size at 10
- **WHEN** the operator opens `/dashboard/memories` under that filter set
- **THEN** the header `TOTAL` chip SHALL read `248`
- **AND** the `SHOWING` indicator SHALL read `10 ROWS`

#### Scenario: TOTAL counts FTS matches within the active filter set, not just the page

- **GIVEN** 53 `active` memories match the free-text query `q` with the page size at 10, plus additional superseded/archived (or out-of-scope) rows that also match `q`
- **WHEN** the operator submits that query on `/dashboard/memories` under the default `status = active` filter
- **THEN** the header `TOTAL` chip SHALL read `53` — the FTS matches within the current scope/status/type filter, mirroring the rows the list shows — and SHALL NOT read the raw match count that includes the superseded/out-of-scope rows
- **AND** the `SHOWING` indicator SHALL read `10 ROWS`

#### Scenario: needs_review combined with search renders a lower-bound total

- **GIVEN** `review = needs_review` AND a non-empty free-text query, and the current page is full (10 rows after the in-process review filter)
- **WHEN** the operator views `/dashboard/memories` under that combination
- **THEN** the header `TOTAL` chip SHALL render the page-slice count suffixed with `+` (e.g. `10+`)
- **AND** it SHALL NOT render an exact-looking number that under- or over-states the match set

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

### Requirement: Memory and judgment views MUST display the title

Wherever the dashboard lists or links to a memory, it SHALL show that memory's `title` as the primary label: the `/dashboard/memories` list rows, the predecessor entries on the detail view, and the source/target memory references on the judgment-queue (`/dashboard/judgments`) and judgment detail views. These labels SHALL use the stored `title` rather than a truncated `content` snippet.

#### Scenario: The memories list shows titles

- **WHEN** the operator opens `/dashboard/memories`
- **THEN** each row SHALL display the memory's `title` as its primary label rather than a `content` truncation

#### Scenario: The judgment queue shows titles

- **WHEN** the operator opens `/dashboard/judgments` and a relation references a source and target memory
- **THEN** each referenced memory SHALL be labelled by its `title` rather than a `content` truncation

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

### Requirement: Tokens MUST be manageable from the dashboard

The `/dashboard/tokens` view SHALL list existing tokens (name, scope, project, created_at, revoked_at, expires_at) and SHALL allow creating a new token (shown in plaintext exactly once) and revoking an existing token (setting `revoked_at`).

#### Scenario: Creating a token

- **WHEN** the operator submits the new-token form
- **THEN** the server SHALL generate a token, store its hash in `tokens`, and render the plaintext token exactly once in a one-time-view component

#### Scenario: Revoking a token

- **WHEN** the operator clicks "Revoke" on a token
- **THEN** the corresponding row SHALL have `revoked_at` set; subsequent MCP requests using that token SHALL be rejected

### Requirement: Mutating dashboard requests MUST be CSRF-protected

Every mutating dashboard form or HTMX action SHALL include a CSRF token bound to the current session, and the server SHALL reject any mutating request missing a valid CSRF token.

#### Scenario: Missing CSRF token

- **WHEN** a `POST /dashboard/tokens` arrives without a valid CSRF token
- **THEN** the server SHALL respond with `403 Forbidden` and SHALL NOT create a token

### Requirement: Destructive dashboard actions MUST gate submission with the confirmation modal

Every dashboard `<form>` whose submit triggers a destructive or hard-to-reverse server action — soft-delete, hard-delete/purge, revoke, archive, undo of a journaled op — SHALL declare the three confirmation attributes (`data-confirm`, `data-confirm-label`, `data-confirm-tone`) on the FORM element itself (NOT on the submit `<button>`), so the inline modal handler implemented in `apps/server/src/dashboard/templates.ts::shell()::CONFIRM` intercepts the submit and prompts the operator.

The handler binds with the selector `form[data-confirm]` and rebinds on `htmx:afterSwap`. Attributes on a child `<button>` are silently ignored — the form would submit unprompted.

The `data-confirm-tone` value SHALL be one of:

- `warn` — for destructive actions the operator can revert through an existing UI path (e.g. soft-delete + undelete, archive + re-save, undo-of-undo).
- `danger` — for actions that cannot be unwound through the UI (e.g. hard-delete via maintenance purge, token revoke, hard undo of an op when the affected rows still exist but no further undo path exists).

The `data-confirm` string SHALL be a plain-language sentence ending in a question, naming the count (when applicable) and stating the consequence shape (reversible / irreversible / journaled). The `data-confirm-label` SHALL be the uppercase VERB + COUNT + NOUN ("PURGE 12 SESSIONS", "REVOKE TOKEN", "UNDO ENTIRE RUN") matching the action being taken, NOT a generic "OK".

#### Scenario: A destructive form with attributes on the form opens the modal

- **GIVEN** a dashboard form `<form action="…" data-confirm="…" data-confirm-label="…" data-confirm-tone="…">…</form>`
- **WHEN** the operator clicks its submit button
- **THEN** the global `#rbr-confirm` dialog SHALL open with the supplied copy
- **AND** the form SHALL submit only after the operator confirms via the dialog

#### Scenario: A destructive form with attributes only on the button submits without prompting (forbidden)

- **GIVEN** a dashboard form whose `data-confirm*` attributes are on the submit button instead of the form
- **WHEN** the operator clicks the submit button
- **THEN** the modal SHALL NOT open and the form SHALL submit immediately — which is a defect
- **AND** code review SHALL reject the pattern and move the attributes to the `<form>` element

#### Scenario: A form-level rebind after an HTMX swap

- **WHEN** an HTMX response replaces a dashboard subtree containing a new `<form data-confirm="…">`
- **THEN** the binder SHALL re-run on `htmx:afterSwap` and the new form SHALL gain the same modal interception as forms present at initial render

#### Scenario: Tone selection matches undoability

- **WHEN** the form action is destructive but reversible through the UI (e.g. soft-delete via `deleted_at`)
- **THEN** `data-confirm-tone` SHALL be `warn`
- **WHEN** the form action cannot be unwound through the UI (e.g. operator-purge via `/dashboard/maintenance`, token revoke)
- **THEN** `data-confirm-tone` SHALL be `danger`

### Requirement: No frontend build pipeline SHALL be required

The dashboard SHALL be implemented with HTMX and server-side template literals. The repository SHALL NOT contain a JavaScript bundler, transpiler, or JavaScript source file that requires compilation beyond what `tsc` produces for the server. A CSS minifier (lightningcss) IS allowed and IS required to produce the per-page CSS bundles described in the design-system requirements; the CSS build step is invoked by `pnpm run build` and SHALL NOT require any additional install or configuration beyond `pnpm install`.

#### Scenario: Fresh contributor onboarding

- **WHEN** a contributor clones the repo and runs `pnpm install`
- **THEN** the dashboard SHALL be ready to develop and to build without any frontend-specific install step beyond what `pnpm install` already produces

#### Scenario: Build emits per-page CSS bundles

- **WHEN** a contributor runs `pnpm run build`
- **THEN** the build SHALL produce `dist/dashboard/public/assets/styles/core.<contentHash>.css`, one `dist/dashboard/public/assets/styles/views/<view>.<contentHash>.css` per dashboard view, and a `dist/dashboard/public/assets/styles/manifest.json` mapping view keys to file names

#### Scenario: No client-side JS framework is introduced

- **WHEN** a contributor inspects the repository for client-side JS
- **THEN** the only JavaScript executing in the browser SHALL be HTMX (vendored) plus inline scripts smaller than 2 KB each, embedded by the SSR shell for the timestamp upgrader and the sidebar toggle progressive enhancement

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

### Requirement: The dashboard home page MUST include a sessions counter

The `/dashboard` overview page SHALL surface a "Sessions (active)" stat card alongside the existing counters. The stat strip SHALL render exactly six cards in this order — `TOTAL`, `ACTIVE`, `SUPERSEDED`, `ARCHIVED`, `PROJECTS`, `ACTIVE SESSIONS` — inside a `.grid-6` container. The previously-rendered `PENDING JUDGMENTS` card has been removed: the LLM now resolves pending candidates inline via `memory.judge`, so an operator-facing counter adds visual noise without an actionable workflow. Pending counts remain accessible via the `JUDGMENTS` sidebar badge.

#### Scenario: The home page is rendered after sessions exist

- **WHEN** the user lands on `/dashboard` and one or more sessions have `status = 'active'`
- **THEN** the stat grid SHALL include a `Sessions (active)` card whose value is the count

#### Scenario: The home stat strip omits the PENDING JUDGMENTS card

- **WHEN** any authenticated operator navigates to `/dashboard`
- **THEN** the response HTML SHALL contain a `.grid-6` stat strip with exactly six `.stat` cards, and SHALL NOT contain a stat card labelled `PENDING JUDGMENTS`

#### Scenario: source → target column shows truncated memory content as links

- **WHEN** an authenticated operator navigates to `/dashboard/judgments` with at least one row present
- **THEN** each row's `source → target` column SHALL contain two `<a href="/dashboard/memories/{id}">` anchors whose visible text is the corresponding memory's `content` truncated to 60 characters, and SHALL NOT contain the memory's short id rendered as standalone text in that column

#### Scenario: verdict column reuses the shared verdict-pill component

- **WHEN** an authenticated operator navigates to `/dashboard/judgments` with at least one judged row present (relation set)
- **THEN** that row's `verdict` cell SHALL contain a `<span class="pill k-{relation}">{relation}</span>` element identical to the rendering used by the home overview's `RECENT JUDGMENTS` tile
- **AND** any pending or orphaned row's `verdict` cell SHALL contain only a `<span class="muted">—</span>` element

### Requirement: Dashboard timestamps MUST render in the viewer's local timezone

Every timestamp surfaced by the dashboard (memories list and detail, sessions list and detail, the soft-delete banner, prompts, consolidation runs and operations, projects list, tokens list, judgments list, and the `replaces` chain on memory detail) SHALL be rendered through a single helper that emits a `<time>` element with:

- A `datetime` attribute set to the ISO-8601 UTC representation (suffix `Z`) of the underlying timestamp.
- A `data-rembric-ts` attribute marking it as a Rembric-managed timestamp.
- A visible text content that, before any client script runs, equals the UTC string `YYYY-MM-DD HH:MM:SS UTC`.

A small inline script bundled in the dashboard layout (`<head>`) SHALL upgrade every `<time data-rembric-ts>` element in place after the document is parsed and after every HTMX content swap, replacing its `textContent` with a `Intl.DateTimeFormat`-formatted string using the browser's timezone and default locale.

The SQLite storage, the service-layer `new Date()` writes, and the MCP serialization of timestamps SHALL remain UTC; only the dashboard HTML changes.

#### Scenario: SSR renders UTC fallback

- **WHEN** the dashboard returns an HTML page containing a timestamp
- **THEN** the response body SHALL contain a `<time datetime="…Z" data-rembric-ts>YYYY-MM-DD HH:MM:SS UTC</time>` element for that timestamp, with no JS execution required to produce the fallback text

#### Scenario: Client upgrades the visible text to local time

- **WHEN** a browser with `Intl.DateTimeFormat` support loads any dashboard page after the change
- **THEN** every `<time data-rembric-ts>` element's `textContent` SHALL be replaced with the formatted-local-time representation of its `datetime` attribute, using the browser's timezone

#### Scenario: HTMX swap re-applies the upgrade

- **WHEN** an HTMX swap injects new `<time data-rembric-ts>` elements into the page (e.g. the memories filter form's partial response)
- **THEN** the upgrader SHALL run again on the newly inserted nodes so they also display local time

#### Scenario: Null or invalid timestamp renders an em-dash

- **WHEN** a dashboard page calls the timestamp helper with `null`, `undefined`, or a value that does not parse to a valid date
- **THEN** the rendered output SHALL be the literal em-dash `—` and SHALL NOT contain a `<time>` element

#### Scenario: Dashboard layout includes the upgrader script exactly once

- **WHEN** any dashboard page is rendered through the layout shell
- **THEN** the HTML `<head>` SHALL include exactly one inline `<script>` whose responsibility is to upgrade `<time data-rembric-ts>` elements

### Requirement: Dashboard CSS MUST be organised as a layered design system

The dashboard styles SHALL live under `apps/server/src/dashboard/styles/` and SHALL be split across exactly two layers of source files:

- A `core/` directory containing, in this order, `tokens.css` (CSS custom properties for palette, typography stack, and spacing scale), `base.css` (reset, root element defaults, `::selection`, scrollbar, focus ring, anchor behaviour), `atoms.css` (single-class building blocks: `.pill`, `.btn`, `.bn`, `.inp`, `.sel`, `.tag`, `.flash`, `.hl-lime`, `.u-lime`, `.spark`), `layout.css` (app shell: `.app`, `.sb`, `.sb-*`, `.mob-bar`, `.main`, `.view-head`), and `patterns.css` (composed surfaces: `.stat`, `.card`, `.tbl`, `.filters`, `.pager`, `.section-bar`, `.kv-grid`, `.content-block`, `.grid-7`, `.grid-6`, `.row-2`, `.row-3`, `.health`, `.tl`, plus the full responsive override block).
- A `views/` directory containing one `<view>.css` per dashboard route, holding only the selectors that are exclusively used by that view.

The shipped artefact SHALL be two CSS bundles per page: one shared `core.css` and one `views/<view>.css`. No view CSS SHALL be inlined into the HTML response body; no inline `<style>` block SHALL be emitted by `shell()` beyond zero-byte placeholders.

#### Scenario: A page renders with two CSS links

- **WHEN** any authenticated dashboard route returns HTML
- **THEN** the `<head>` SHALL contain exactly one `<link rel="stylesheet">` whose `href` ends with `core.<hash>.css` AND, when the view has its own CSS file, exactly one `<link rel="stylesheet">` whose `href` ends with `views/<view>.<hash>.css`

#### Scenario: The HTML body carries no `<style>` block

- **WHEN** any authenticated dashboard route returns HTML
- **THEN** the response body SHALL NOT contain a `<style>` element

#### Scenario: Adding a new view requires adding its CSS file

- **WHEN** a contributor adds a new dashboard route that needs view-specific selectors
- **THEN** they SHALL add a new file `apps/server/src/dashboard/styles/views/<view>.css`, register the view key in the build script's view list, and reference the view key from the route's `shell()` call — and a `pnpm run build` SHALL emit and serve the new file with no further configuration

### Requirement: Dashboard CSS MUST be minified and content-hashed in production

The build step SHALL minify every dashboard CSS file via `lightningcss` and SHALL emit each output with a content-hash segment in its filename (e.g. `core.a3f1e2.css`). The HTTP layer SHALL serve content-hashed CSS with `Cache-Control: public, max-age=31536000, immutable`.

#### Scenario: Hashed files are served with immutable cache

- **WHEN** a request hits `/dashboard/assets/styles/core.a3f1e2.css`
- **THEN** the response SHALL carry `Cache-Control: public, max-age=31536000, immutable`

#### Scenario: A CSS edit produces a new hash

- **WHEN** the contents of any source `*.css` file changes and `pnpm run build` runs again
- **THEN** the affected output filename SHALL have a different hash than the previous build, and the `manifest.json` SHALL reflect the new filename

### Requirement: Dashboard HTML MUST be whitespace-minified in production

The `shell()` helper SHALL run every rendered response through a whitespace-collapsing minifier before returning it, removing runs of whitespace between tags and stripping HTML comments. The minifier SHALL NOT alter the content of `<pre>`, `<textarea>`, or `<script>` elements, and SHALL NOT remove or rewrite any attribute or tag.

#### Scenario: Response has no inter-tag indentation

- **WHEN** any dashboard route returns HTML
- **THEN** the response body SHALL NOT contain runs of two or more whitespace characters between a `>` and a `<`, outside `<pre>`, `<textarea>`, or `<script>` elements

#### Scenario: Pre-formatted content is preserved

- **WHEN** a memory body containing newlines is rendered inside a `<pre>` element
- **THEN** the original newlines and indentation inside the `<pre>` SHALL be preserved exactly

### Requirement: Dashboard MUST follow the brutalist visual identity

The dashboard SHALL render in a single dark theme with the following design tokens locked at the `:root` scope:

- `--bg: #0a0a0a`, `--bg-elev: #141414`, `--bg-row-hover: #15170d`
- `--fg: #f2f2f2`, `--fg-dim: #9a9a9a`, `--fg-faint: #2a2a2a`
- `--lime: #c6f24e`, `--lime-ink: #0a0a0a`, `--warn: #ff8c00`, `--danger: #ff3344`
- `--f-display: "Space Grotesk", system-ui, sans-serif`
- `--f-sans: "Inter", system-ui, sans-serif`
- `--f-mono: "JetBrains Mono", ui-monospace, monospace`
- Spacing scale `--s-1: 4px` through `--s-8: 64px`

Changing any of these tokens SHALL require a new OpenSpec change. The dashboard SHALL NOT ship a light theme, a theme switcher, or per-user theme settings.

#### Scenario: Tokens are declared once in core.css

- **WHEN** a contributor inspects `apps/server/src/dashboard/styles/core/tokens.css`
- **THEN** the file SHALL contain all design tokens listed above, declared inside a single `:root { ... }` block

### Requirement: Dashboard fonts MUST be self-hosted

The dashboard SHALL serve Space Grotesk (weights 400, 500, 600, 700), Inter (weights 400, 500, 600), and JetBrains Mono (weights 400, 500, 600) as woff2 files from `/dashboard/assets/fonts/`. The dashboard SHALL NOT reference Google Fonts or any other font CDN at runtime. Font files SHALL be served with `Cache-Control: public, max-age=31536000, immutable`.

#### Scenario: No external font requests

- **WHEN** a browser loads any dashboard page
- **THEN** the page SHALL NOT trigger an HTTP request to `fonts.googleapis.com`, `fonts.gstatic.com`, or any host other than the Rembric server

#### Scenario: Every font weight is reachable

- **WHEN** a request hits `/dashboard/assets/fonts/space-grotesk-700.woff2`
- **THEN** the response SHALL be a valid woff2 file with `Content-Type: font/woff2`

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

### Requirement: Dashboard MUST be fully responsive across desktop, tablet, and phone viewports

Every dashboard route SHALL render correctly and remain fully usable from a viewport width of 320 px upwards. The responsive system SHALL honour the following breakpoints:

- **≥1281 px (full desktop)**: full-width sidebar (~196 px), multi-column grids at their maximum density (`.grid-7` shows 7 columns, `.grid-6` shows 6, `.kv-grid` shows 6).
- **≤1280 px (compact desktop)**: `.main` padding reduced; `.grid-7` reflows to 4 columns; `.grid-6` reflows to 3 columns.
- **≤980 px (tablet / mobile drawer)**: sidebar collapses into a sticky `.mob-bar` at the top of the viewport with a `☰ MENU` toggle that opens a full-width drawer; multi-column grids stack to 2-3 columns; `.row-2` and `.row-3` collapse to single column; tables remain horizontally scrollable inside `.tbl-host`; `.filters` becomes one-per-row; `.action-bar` wraps with action hint on its own row.
- **≤640 px (phone)**: `.grid-7` and `.grid-6` show 2 columns; `.kv-grid` shows 2 columns; `.health` stacks to 1 column; `.login-stage` keeps both panes stacked vertically (no longer hides the identity pane); `.view-head h1` reduces to ~1.8rem; table minimum width drops; `.stat-v` shrinks to ~2.4rem.

At every viewport, the page SHALL NOT introduce horizontal page-level scrolling (only `.tbl-host` and code blocks may scroll horizontally). Interactive controls (buttons, pager items, sidebar items, form fields) SHALL have a touch target of at least 44 × 44 CSS pixels at viewports ≤980 px.

#### Scenario: Sidebar becomes a mobile drawer at ≤980 px

- **WHEN** any dashboard page is loaded at a viewport width of 980 px or less
- **THEN** the page SHALL render a sticky `.mob-bar` at the top of the viewport, the desktop sidebar SHALL be hidden by default, and tapping the `☰ MENU` button SHALL slide the navigation in as a full-width drawer

#### Scenario: No horizontal page scroll at any breakpoint

- **WHEN** any dashboard page is loaded at viewport widths 1440, 1100, 768, 540, or 360 px
- **THEN** the document element's horizontal overflow SHALL be `hidden` or the rendered content SHALL fit within the viewport, with the only horizontally-scrollable elements being `.tbl-host` containers and any explicit code/`<pre>` blocks

#### Scenario: Stat grids reflow at narrow widths

- **WHEN** any page containing a `.grid-7` is rendered at a viewport width of 640 px or less
- **THEN** the grid SHALL show exactly 2 columns and SHALL preserve its internal border lines between cards

#### Scenario: Tables stay reachable on phone widths

- **WHEN** a table wider than the viewport is rendered at ≤640 px
- **THEN** the table SHALL be wrapped in `.tbl-host` and SHALL scroll horizontally within that container without expanding the page width

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

### Requirement: The dashboard login view MUST present a single canonical brand mark, headline, and client-support footer

The `/dashboard/login` page SHALL render a single brand block in the top-left of the left pane containing the transparent Rembric logo (`/dashboard/assets/logo-transparent.png`) at 56 × 56 px on desktop, 48 × 48 px at viewports ≤ 980 px, and 40 × 40 px at viewports ≤ 640 px, followed by two lines of mono text (`REMBRIC` and `v<version>`, where `<version>` is the running server package version loaded via `REMBRIC_VERSION`). The main headline SHALL read `REMBRIC DASHBOARD.` with `REMBRIC` rendered via the `hl-lime` highlight pill and the trailing period rendered in `var(--lime)`. The headline `line-height` SHALL be at least `1.3` so the `hl-lime` background does not visually clip the next line.

A footer SHALL list the supported plugin clients in the following order, separated visually by lime square bullets: `CLAUDE CODE`, `CODEX CLI`, `HERMES`, `MCP CLIENTS`. The right pane SHALL contain only the admin-token form (a labelled password input + a primary submit button) and SHALL NOT contain redundant section chips or security-disclosure copy that duplicates the `/tokens` documentation.

#### Scenario: Login renders the canonical brand mark

- **WHEN** an unauthenticated request hits `/dashboard/login`
- **THEN** the response HTML SHALL contain exactly one `<img>` with `src="/dashboard/assets/logo-transparent.png"` inside an element with class `login-brand`, placed before any `<form>` element

#### Scenario: Login brand shows the version instead of SELF-HOSTED

- **WHEN** an unauthenticated request hits `/dashboard/login`
- **THEN** the brand block SHALL contain the line `v<version>` directly under `REMBRIC` and SHALL NOT contain the text `SELF-HOSTED`

#### Scenario: Headline is REMBRIC DASHBOARD

- **WHEN** the login page is rendered
- **THEN** the `<h1>` SHALL contain the text `REMBRIC` wrapped in a `<span class="hl-lime">` followed by the text `DASHBOARD` and a period rendered in `var(--lime)`

#### Scenario: Footer lists all three plugin clients plus generic MCP

- **WHEN** the login page is rendered at a viewport width greater than 640 px
- **THEN** the `.login-stage .clients` element SHALL contain, in order, four labelled spans `CLAUDE CODE`, `CODEX CLI`, `HERMES`, `MCP CLIENTS`

#### Scenario: Login form has no redundant chips or disclosure block

- **WHEN** the login page is rendered
- **THEN** the response HTML SHALL NOT contain the strings `§ 00 / ACCESS`, `OPERATOR DASHBOARD`, `APPEND-ONLY`, `ADMIN-SCOPED TOKENS ONLY`, `STORED IN HTTPONLY COOKIE`, or `PLAINTEXT SHOWN ONLY ONCE IN /TOKENS`

### Requirement: The dashboard MUST surface an Abandon action for active sessions

The list view at `/dashboard/sessions` SHALL render an inline `<form action="/dashboard/sessions/<id>/abandon" method="post">` per row whose `status === 'active'` AND `deleted_at IS NULL`, alongside the existing `Delete` form. The form SHALL include a CSRF input minted with the action token `'session.abandon'`, a `data-confirm` attribute reading `Mark this session as abandoned? Its <N> memories stay queryable and the row stays visible in the list. This transition is not reversible from the dashboard.` (where `<N>` is the per-row memory count already computed for the row), a `data-confirm-label` of `ABANDON SESSION`, and a `data-confirm-tone` of `warn`.

The submit button SHALL be styled `class="warn"` (matching the existing `class="warn"` convention for soft-destructive actions) and SHALL read `Abandon`. Rows whose `status` is `'ended'` or `'abandoned'`, or whose `deleted_at` is set, SHALL NOT render the Abandon form — the action is meaningful only on currently-active rows.

The handler at `POST /dashboard/sessions/:id/abandon` SHALL verify CSRF with action token `'session.abandon'`, call `agentSessions.markAbandoned(id, { adminBypass: true })`, and on success redirect to `/dashboard/sessions?abandoned=<id>` (URL-encoded). On `DomainError`, the handler SHALL re-render the sessions list page with a `flash error` body and the appropriate status code: `404` for `session_not_found`, `400` for every other `DomainError` code surfaced by the service (e.g. `session_already_ended`). The handler SHALL not surface raw exceptions to the operator.

The list view SHALL recognise the `?abandoned=<id>` query parameter and render it as a `flash success` banner reading `Session <code><id></code> marked as abandoned. <a href="/dashboard/sessions/<id>">View</a>.` The banner SHALL appear in the same position and styling as the existing `?deleted=` / `?restored=` banners.

The detail view at `/dashboard/sessions/:id` SHALL render the Abandon form in the action area when the row's `status === 'active'` AND `deleted_at IS NULL`. The form attributes SHALL match those used in the list view, with `<N>` computed from the count of memories already loaded for the detail page.

#### Scenario: Operator abandons an active session from the list view

- **GIVEN** an authenticated admin session and an `active` Rembric session row with id `<S>` and 12 memories
- **WHEN** the operator submits the row's Abandon form (after confirming the modal)
- **THEN** the response SHALL be a 302 redirect to `/dashboard/sessions?abandoned=<S>`
- **AND** the row's `status` SHALL be `'abandoned'`
- **AND** the row's `ended_at` SHALL be non-NULL
- **AND** a subsequent GET of `/dashboard/sessions` SHALL render the flash banner referencing `<S>`

#### Scenario: Abandon button is hidden for non-active rows

- **WHEN** the list view renders a row whose `status` is `'ended'` or `'abandoned'`
- **THEN** the row's actions cell SHALL NOT contain an Abandon form

#### Scenario: Abandon button is hidden for soft-deleted rows

- **WHEN** the list view renders a soft-deleted row (`deleted_at IS NOT NULL`)
- **THEN** the row's actions cell SHALL contain only the Undelete form — no Abandon form

#### Scenario: Abandon confirmation modal names the memory count

- **GIVEN** an active session row with 12 memories
- **WHEN** the operator triggers the Abandon form's submit
- **THEN** the global `#rbr-confirm` dialog SHALL open with copy containing the substring `Its 12 memories stay queryable`
- **AND** the confirm button SHALL read `ABANDON SESSION`
- **AND** the dialog SHALL use the `warn` tone styling

#### Scenario: Abandon without CSRF is rejected

- **GIVEN** an authenticated admin session
- **WHEN** a POST to `/dashboard/sessions/<S>/abandon` arrives without the `csrf` field
- **THEN** the response SHALL be `403` with the standard `csrf_invalid` body

#### Scenario: Abandoning an already-ended session surfaces an error

- **GIVEN** a session row with `status = 'ended'`
- **WHEN** a POST to `/dashboard/sessions/<S>/abandon` is made (e.g. via a stale form replayed after the row transitioned)
- **THEN** the response SHALL be `400` with a `flash error` body describing the `session_already_ended` condition
- **AND** the row's `status` SHALL remain `'ended'`

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

### Requirement: The dashboard sidebar MUST include a `PROMPTS` entry

The primary dashboard navigation (`apps/server/src/dashboard/components.ts::NAV`) SHALL include an entry with `key: 'prompts'`, `num: '03b'`, label `PROMPTS`, `href: '/dashboard/prompts'`, group `MAIN`, placed between the `SESSIONS` entry and the `JUDGMENTS` entry. The `NavKey` union and `NAV_ICONS` table SHALL be extended accordingly.

#### Scenario: Sidebar lists PROMPTS in the MAIN group

- **WHEN** any authenticated dashboard page is rendered
- **THEN** the sidebar SHALL contain an `<a>` linking to `/dashboard/prompts` with the label `PROMPTS`
- **AND** the entry SHALL appear within the `MAIN` group, after `SESSIONS` and before `JUDGMENTS`

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

### Requirement: The dashboard home page MUST surface a recent-judgments block

The `/dashboard` overview page SHALL render a `RECENT JUDGMENTS` block as the left tile of its `.row-2` strip (the position previously occupied by the `PENDING JUDGMENTS` inline list). The block SHALL load the four most recently judged rows of `memory_relations` ordered by `judged_at DESC`, restricted to `status = 'judged'`. The block SHALL NOT include rows whose status is `pending` or `orphaned`.

Each row SHALL render, in order:

- A verdict pill produced by the shared `verdictPill(relation)` helper exported from `apps/server/src/dashboard/templates.ts`, which renders `<span class="pill k-{relation}">{relation}</span>` using the existing relation-kind classes (`k-supersedes`, `k-conflicts_with`, `k-related`, `k-compatible`, `k-scoped`, `k-not_conflict`). The same helper SHALL be used by every other dashboard surface that displays a verdict — no inline `pill k-…` HTML in templates. The pill itself SHALL NOT be wrapped in an anchor (to avoid click conflicts with the memory anchors inside the row); a dedicated `VIEW →` button (`btn({variant:'primary', size:'sm', href:'/dashboard/judgments/{id}'})`) in the row's `.acts` slot SHALL be the operator's path to the judgment detail view.
- The `judged_at` timestamp rendered as a relative-time string (e.g. `3M AGO`, `2H AGO`) consistent with the adjacent `RECENT SESSIONS` tile, and the `marked_by_kind` value (one of `agent`, `agent_topic_key`, `consolidator`, `system`) — when present — rendered in dim text. The row SHALL NOT render the judgment's short id as standalone text on the meta line; the only way to identify the judgment from the home tile is the linked verdict pill described above.
- One source memory line: the source memory's `content` truncated to 70 characters, wrapped in an `<a class="txt" href="/dashboard/memories/{sourceId}">` element. The short id is NOT rendered alongside (the link target carries it). The anchor SHALL be rendered in the brand lime accent (`color: var(--lime)`) via a scoped CSS rule in `styles/views/home.css`, with an underline on hover, so it reads as a link at a glance.
- One target memory line, prefixed with the existing `↳` arrow span: the target memory's `content` truncated to 70 characters, wrapped in an `<a class="txt" href="/dashboard/memories/{targetId}">` element, styled identically (lime + hover-underline).
- A right-aligned `.acts` slot containing a single `VIEW →` button — an `<a class="btn primary sm" href="/dashboard/judgments/{id}">` produced by the shared `btn` helper — that takes the operator to the judgment detail page.

The block SHALL NOT render any per-row action button (no `JUDGE` button or equivalent affordance) — every row is a closed verdict.

The block's section header SHALL read `RECENT JUDGMENTS` with the meta `NEWEST FIRST`, and SHALL include an `OPEN ALL ›` anchor whose `href` is `/dashboard/judgments` (the unfiltered default view).

When no judged rows exist for the active scope, the block SHALL render the empty-state cell `NO JUDGMENTS YET`.

#### Scenario: Operator sees recent judgments on the home overview

- **WHEN** an authenticated operator navigates to `/dashboard` and at least one `memory_relations` row exists with `status='judged'`
- **THEN** the response HTML SHALL contain a section header reading `RECENT JUDGMENTS` followed by between 1 and 4 rows, each containing a `pill k-{relation}` element matching that row's `relation`, two `<a href="/dashboard/memories/{id}">` anchors (one per source / target memory) wrapping the truncated content, and a relative-time string for `judged_at` matching `/^(NOW|\d+(M|H|D|MO) AGO)$/`

#### Scenario: Empty home overview renders the new empty-state copy

- **WHEN** an authenticated operator navigates to `/dashboard` and no `memory_relations` rows exist with `status='judged'`
- **THEN** the response HTML SHALL contain the literal string `NO JUDGMENTS YET` inside an element with class `tbl-empty`, and SHALL NOT contain the legacy string `NO PENDING JUDGMENTS YET`

#### Scenario: Recent-judgments block excludes pending and orphaned

- **WHEN** the home overview is rendered with a mix of `pending`, `judged`, and `orphaned` rows in `memory_relations`
- **THEN** the rendered `RECENT JUDGMENTS` block SHALL contain only rows whose `status='judged'`; the rendered output SHALL NOT contain any `pill k-pending` element inside the block

#### Scenario: Recent-judgments block has no per-row JUDGE button

- **WHEN** the home overview is rendered with at least one judged row
- **THEN** the `RECENT JUDGMENTS` block SHALL NOT contain any element with class `acts` or any anchor whose href is `/dashboard/judgments` rendered _inside_ a row (the only `OPEN ALL ›` anchor SHALL be the one in the section header)

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

### Requirement: The dashboard brand block MUST display the running server version

The dashboard SHALL render the running server version (the `version` field of the server package, loaded at boot via `REMBRIC_VERSION` from `apps/server/src/version.ts`) inside the brand block of the desktop sidebar (`.sb-brand`) and the mobile bar (`.mob-bar .brand`), as the line directly under `REMBRIC`. The version SHALL be rendered as a `<small>` element with the text `v<version>` (displayed uppercased by the brand's existing `text-transform`). The brand SHALL NOT render a `SELF-HOSTED` line — the version takes that row. The rendering SHALL reuse the existing `.label-stack small` styles and SHALL NOT introduce new CSS rules.

#### Scenario: Sidebar brand shows the version

- **WHEN** an authenticated operator loads any dashboard page at a desktop viewport with the sidebar expanded
- **THEN** the sidebar brand block SHALL contain, in order, the lines `REMBRIC` and `v<version>` where `<version>` equals the server package version, and SHALL NOT contain the text `SELF-HOSTED`

#### Scenario: Mobile bar brand shows the version inline

- **WHEN** an authenticated operator loads any dashboard page at a viewport ≤980 px
- **THEN** the `.mob-bar` brand SHALL render `REMBRIC` and `v<version>` inline, with the existing `·` separator applied before the `<small>` by the established `.mob-bar .brand .label-stack small::before` rule

#### Scenario: Collapsed sidebar hides the version with the rest of the label stack

- **WHEN** the sidebar is in collapsed mode
- **THEN** the version SHALL be hidden along with the entire `.label-stack` (existing collapse behavior, unchanged)

### Requirement: The dashboard MUST surface update availability as a badge in the brand block

When the update check reports a newer version, the dashboard SHALL render an update badge adjacent to the running-version line in the brand block (sidebar, mobile bar) showing the latest available version. The badge SHALL persist across visits until the deployment runs the newer version and SHALL NOT be affected by modal dismissal.

When no newer version is known and the update check is enabled, the same brand-block slot SHALL render a quiet link (muted styling, no lime accent) to `/dashboard/update`, so the update page is always reachable from the shell. When the update check is disabled (`REMBRIC_UPDATE_CHECK=off`), the slot SHALL render nothing.

#### Scenario: Update available

- **WHEN** an authenticated operator loads any dashboard page while a newer version is known
- **THEN** the brand block SHALL show an update badge with the latest version next to the running version

#### Scenario: No update known, check enabled

- **WHEN** an authenticated operator loads any dashboard page while no newer version is known and the update check is enabled
- **THEN** the brand-block slot SHALL render a quiet link to `/dashboard/update` in place of the badge

#### Scenario: Check disabled

- **WHEN** `REMBRIC_UPDATE_CHECK=off` is set
- **THEN** the brand-block slot SHALL render neither a badge nor a quiet link

### Requirement: The dashboard MUST present a per-version dismissable update modal with the release changelog

When a newer version is known and the operator has not dismissed that specific version, the dashboard SHALL present an update modal showing: current version → new version, the release publication time (via `formatTs`), the release changelog body rendered from the GitHub Release, and a link to the release on GitHub. A "Later" action SHALL dismiss the modal for that version only (client-side persistence); the next newer release SHALL re-trigger it. The modal's primary action SHALL depend on the self-update capability state:

- `available` — an update button that triggers the one-click flow
- `pinned` — no button; an explanation that the image tag is pinned and how to unpin
- `manual` — a copy-to-clipboard `docker compose pull && docker compose up -d` command and a link to `docs/updates.md` for enabling one-click

#### Scenario: First visit after a release

- **WHEN** an operator opens the dashboard and a newer, undismissed version exists
- **THEN** the update modal SHALL appear with the version diff, changelog, and the capability-appropriate action

#### Scenario: Dismissed version stays dismissed

- **WHEN** the operator chose "Later" for `0.22.0` and reloads the dashboard
- **THEN** the modal SHALL NOT reappear for `0.22.0`, while the brand badge remains

#### Scenario: Manual quadrant

- **WHEN** the modal renders with capability `manual`
- **THEN** it SHALL show the copy-paste update command and the docs link instead of an update button

### Requirement: The one-click update action MUST require a danger-tone confirmation

The one-click update trigger SHALL be a form protected by the dashboard's `data-confirm` modal with `data-confirm-tone="danger"`, and its confirmation copy SHALL state that the server will stop, replace its container, and restart, and that a database backup is taken first.

#### Scenario: Confirmation before update

- **WHEN** the operator clicks the update button
- **THEN** the danger-tone confirmation modal SHALL appear and no update SHALL start until confirmed

### Requirement: The dashboard MUST show update progress and reload itself on the new version

After a one-click update is confirmed, the dashboard SHALL show a progress view with discrete steps (backup, image pull with progress, service restart, version verification) updated by polling a status endpoint. While the server is restarting, connection failures SHALL be rendered as the restart step, not as errors. The page SHALL then poll a session-authenticated version endpoint and, once it answers with a version different from the one the page rendered with, SHALL reload automatically. If the update fails before the swap, the progress view SHALL show the failure reason; if it fails after the swap (rollback), the reloaded page SHALL surface that the previous version is still running.

#### Scenario: Successful update reloads on new version

- **WHEN** the upgrader completes and the replacement container becomes healthy
- **THEN** the operator's page SHALL detect the new version via polling and reload, showing the dashboard on the new version with the session still valid

#### Scenario: Failure before swap

- **WHEN** the backup or pull step fails
- **THEN** the progress view SHALL display the failure reason and the dashboard SHALL remain fully functional on the current version

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

### Requirement: The update page MUST offer a manual check with an honest outcome

The up-to-date state of `/dashboard/update` SHALL render a CSRF-protected form that triggers the manual release check and, when a check has run in the current process lifetime, a last-checked timestamp rendered via `formatTs`. After the manual check: if a newer version was found, the page SHALL render the existing update-available view; if no newer version is known, the page SHALL show a flash stating the deployment is still up to date; if the check could not reach the GitHub API, the page SHALL show an error flash that names the failure (distinct from "up to date") and notes this is expected on air-gapped hosts. The manual-check form SHALL NOT render when the update check is disabled; a disabled note naming `REMBRIC_UPDATE_CHECK=off` SHALL render instead, and the page SHALL NOT claim the deployment is up to date (the server never checks, so it cannot know). The manual check action SHALL NOT require a `data-confirm` modal (read-only, reversible).

#### Scenario: Manual check finds an update

- **WHEN** the operator triggers the manual check and a newer release exists
- **THEN** `/dashboard/update` SHALL render the update-available view (version diff, changelog, capability-appropriate action) and the brand-block badge SHALL appear on subsequent page loads

#### Scenario: Manual check, still up to date

- **WHEN** the operator triggers the manual check and no newer release exists
- **THEN** `/dashboard/update` SHALL show a flash stating no newer version is known and remain on the up-to-date state

#### Scenario: Manual check fails

- **WHEN** the operator triggers the manual check and the GitHub API is unreachable
- **THEN** `/dashboard/update` SHALL show an error flash that distinguishes the failure from being up to date

#### Scenario: Check disabled hides the action

- **WHEN** `REMBRIC_UPDATE_CHECK=off` is set and the operator opens `/dashboard/update`
- **THEN** the page SHALL NOT render the manual-check form

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

### Requirement: Long text content on detail views MUST be rendered as Markdown

On detail views, the dashboard SHALL render long text `content` fields as Markdown using an in-process parser, rather than displaying the raw Markdown source inside an escaped `<pre>` block. This applies to: memory detail content (`/dashboard/memories/:id`), session description (seed goal) and session summary (`/dashboard/sessions/:id`), the expanded prompt content cell (`/dashboard/prompts`), and the Source and Target memory content on the judgment detail view (`/dashboard/judgments/:id`).

Fields that are NOT free-form Markdown content SHALL NOT be Markdown-rendered: the judgment Reason SHALL remain a plain (escaped) paragraph, and the judgment Evidence SHALL remain a `<pre>` block because it is pretty-printed JSON.

The Markdown parser SHALL be configured to **disable raw HTML passthrough** (`html: false`): any HTML tags present in the source SHALL be rendered as escaped text, never as live markup. The parser SHALL reject dangerous URL schemes (e.g. `javascript:`, `vbscript:`, `data:`) in links, leaving the affected link inert. No separate HTML sanitizer SHALL be required for safety. The rendered HTML SHALL be the **only** value passed through the template's raw/unescaped path; user-supplied content SHALL never bypass escaping except as the parser's output.

The rendering SHALL be performed entirely server-side and in-process; no CDN, network call, or client-side JavaScript SHALL be required to display formatted content. Rendering SHALL reuse the locked brutalist design tokens and self-hosted fonts; it SHALL NOT introduce a new design token, and fenced/inline code SHALL remain monospace.

Each rendered Markdown block SHALL provide an icon-only control that copies the verbatim Markdown source to the clipboard, so the raw source remains recoverable behind the render. The source SHALL be carried in the page (not re-fetched) such that copying yields the original source — including the literal `**`, backticks, and fences — rather than the rendered HTML. The control SHALL function in non-secure (plain-HTTP) deployments via a clipboard fallback. This control is a progressive enhancement; the formatted content itself SHALL still render with JavaScript disabled.

List and table views SHALL NOT render Markdown: truncated `content` snippets in list cells SHALL remain plain escaped text.

#### Scenario: Memory detail renders Markdown formatting

- **WHEN** an authenticated operator opens `/dashboard/memories/:id` for a memory whose content contains `**bold**`, inline `` `code` ``, a fenced code block, and a bulleted list
- **THEN** the page SHALL render the bold span, inline code, code block, and list as formatted HTML elements
- **AND** the literal characters `**`, `` ` ``, and ` ``` ` SHALL NOT appear as visible source text

#### Scenario: Raw HTML in content is rendered inert

- **WHEN** a memory's content contains `<script>alert(1)</script>` or any other raw HTML tag
- **THEN** the detail view SHALL display that text escaped (visible as literal characters), and SHALL NOT execute or inject it as live markup

#### Scenario: Dangerous link schemes are dropped

- **WHEN** a memory's content contains a Markdown link whose URL uses a `javascript:` (or other dangerous) scheme
- **THEN** the rendered output SHALL NOT produce a clickable link that navigates to that scheme

#### Scenario: Copy-raw control returns the verbatim source

- **WHEN** an operator activates the copy control on a rendered Markdown block
- **THEN** the verbatim Markdown source (including the original `**`, backticks, and fences) SHALL be copied to the clipboard, not the rendered HTML

#### Scenario: Session description and summary render Markdown

- **WHEN** an authenticated operator opens `/dashboard/sessions/:id` for a session with a Markdown-formatted description and summary
- **THEN** both the description (seed goal) and the summary SHALL be rendered as formatted HTML

#### Scenario: Judgment Source/Target render Markdown but Evidence stays JSON

- **WHEN** an authenticated operator opens `/dashboard/judgments/:id`
- **THEN** the Source and Target memory content SHALL be rendered as formatted Markdown
- **AND** the Evidence block SHALL remain a `<pre>` rendering of the pretty-printed JSON (not Markdown-rendered)

#### Scenario: List snippets remain plain text

- **WHEN** the operator views the `/dashboard/memories` list where a row's content contains `**bold**`
- **THEN** the truncated snippet cell SHALL display the raw characters as escaped plain text and SHALL NOT render Markdown formatting

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
