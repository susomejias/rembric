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

The `/dashboard/memories` view SHALL support filtering by project, type, status, and free-text search, and SHALL paginate results. All filtering SHALL be performed server-side; the form SHALL be progressively enhanced with HTMX so it updates without a full page reload.

#### Scenario: Filtering by status

- **WHEN** the operator selects `status = 'archived'` in the filter form
- **THEN** the resulting page SHALL show only memories with `status = 'archived'`, respecting the current project filter

#### Scenario: Pagination

- **WHEN** the operator clicks "next page"
- **THEN** the page SHALL reload with the next `limit` rows offset, preserving all active filters

### Requirement: Memory detail MUST display the history chain

The `/dashboard/memories/:id` view SHALL display the memory's content, status, tags, scope, project, source, current confirmation count, and a visualization of the `replaces` chain showing all predecessors with their content snapshots and timestamps.

#### Scenario: Viewing a merged memory

- **WHEN** the operator opens the detail view for a merged memory M
- **THEN** the page SHALL show M's content, M's predecessor ids and content snapshots ordered chronologically, and an "Archive" action

### Requirement: Consolidation runs MUST be inspectable and reversible from the dashboard

The dashboard SHALL list consolidation runs at `/dashboard/consolidation` and SHALL show per-run details at `/dashboard/consolidation/:id` including each op with its LLM reasoning. Each op SHALL have an "Undo" action; each run SHALL have an "Undo entire run" action.

#### Scenario: Undoing an op from the dashboard

- **WHEN** the operator clicks "Undo" on a merge op
- **THEN** the server SHALL execute the undo, the page SHALL update to show the op as reverted, and the affected memories SHALL be visible at `/dashboard/memories` in their restored state

#### Scenario: Reverted run is marked

- **GIVEN** every op of a run has been undone
- **WHEN** the operator visits `/dashboard/consolidation`
- **THEN** the run SHALL be visually marked as reverted in the listing

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

A logged-in dashboard user SHALL see a list of recent sessions for the active project (or globally when no project is selected). The list SHALL include columns for title, session id (short form), agent, started_at, ended_at, status, and a memory count (number of `memory` rows with that `session_id`).

The `title` column SHALL render using the cascade `row.title ?? row.description ?? shortId(row.id)`. The cascade SHALL NOT short-circuit on placeholder titles (e.g. `'rembric · 22:14 UTC'`) — those count as real titles for the purpose of display, because they are still more informative than `shortId` alone. The cascade ensures legacy rows (where `title` is NULL because they predate the column migration) still get a sensible value.

The title column SHALL be the first visible content column (left of session id) and SHALL truncate with `text-overflow: ellipsis` past ~40 chars to keep the table compact. The full title SHALL be available as the cell's `title` attribute (HTML tooltip) so operators can hover to see the full string.

#### Scenario: A dashboard user navigates to `/dashboard/sessions`

- **WHEN** the user is authenticated with an admin token and visits `/dashboard/sessions`
- **THEN** the server SHALL return a paginated list of the 50 most recent sessions ordered by `started_at DESC`, with each row linking to `/dashboard/sessions/:id`
- **AND** each row SHALL include a `title` column rendered via the documented cascade

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
- **THEN** the page SHALL display: the title as the `<h1>` (via the same cascade as the list view), the session metadata (agent, project, token name, started_at, ended_at, status), the verbatim `summary` text, and a table of memories whose `session_id` matches, linking to each memory's detail page

#### Scenario: A session was created by a now-revoked token

- **WHEN** the underlying token has been revoked but the session row still exists
- **THEN** the detail page SHALL still render and SHALL show the token name with a "(revoked)" suffix; the session SHALL not be hidden from the list

### Requirement: The dashboard home page MUST include a sessions counter

The `/dashboard` overview page SHALL surface a "Sessions (active)" stat card alongside the existing counters.

#### Scenario: The home page is rendered after sessions exist

- **WHEN** the user lands on `/dashboard` and one or more sessions have `status = 'active'`
- **THEN** the stat grid SHALL include a `Sessions (active)` card whose value is the count

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

The dashboard SHALL render its primary navigation as a left-hand vertical sidebar listing the routes Overview, Memories, Sessions, Judgments, Consolidation, Projects, Tokens. The sidebar SHALL support a collapsed mode (icons only, narrower fixed width) on desktop viewports and SHALL expose a toggle button to switch states.

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

The dashboard SHALL serve `GET /dashboard/maintenance` as a top-level page that aggregates physically destructive operations. The page SHALL be reachable only by dashboard sessions whose underlying token has scope `*` (global admin). For dashboard sessions backed by a project-scoped token, the route SHALL respond with `403 forbidden` and a small HTML body explaining the requirement; the sidebar link to `/dashboard/maintenance` SHALL be hidden entirely for those sessions.

The page SHALL contain three regions:

1. **DB breakdown.** A summary card showing the SQLite file size (computed as `page_count × page_size`), the freelist size (`freelist_count × page_size`), and a per-table breakdown of allocated bytes (computed via `dbstat` aggregated by name) sorted descending by size.
2. **Empty sessions card.** A card titled "Purge empty sessions" with the current count of rows matching the predicate in the sessions spec's "Sessions MAY be physically purged when empty" requirement. When the count is zero, the action button SHALL be disabled and copy SHALL read "No empty sessions to purge."
3. **Disconnected archived memories card.** A card titled "Purge disconnected archived memories" with the current count of rows matching the predicate in the memory spec's "Memories MAY be physically purged when archived and disconnected" requirement. When the count is zero, the action button SHALL be disabled and copy SHALL read "No disconnected archived memories to purge."

Both action buttons SHALL use the existing `data-confirm` modal pattern (no new JS) with `data-confirm-tone="danger"`, a `data-confirm-label` that names the count and the action verb (e.g. `PURGE 12 SESSIONS`), and a `data-confirm` copy that explicitly states the action is irreversible.

#### Scenario: An admin-scope session opens the maintenance page

- **GIVEN** a dashboard session backed by a token with `scope = '*'`
- **WHEN** the session navigates to `/dashboard/maintenance`
- **THEN** the response SHALL be `200 OK`
- **AND** the page SHALL render the DB breakdown and the two cards with their pre-flight counts

#### Scenario: A project-scope session opens the maintenance page

- **GIVEN** a dashboard session backed by a token with `scope = 'project:<id>'`
- **WHEN** the session navigates to `/dashboard/maintenance`
- **THEN** the response SHALL be `403 forbidden`
- **AND** the response body SHALL contain copy explaining that maintenance requires an admin-scoped token

#### Scenario: A project-scope session views the sidebar

- **GIVEN** a dashboard session backed by a token with `scope = 'project:<id>'`
- **WHEN** the session renders any dashboard page
- **THEN** the sidebar SHALL NOT contain a link to `/dashboard/maintenance`

### Requirement: The maintenance page MUST expose admin-only purge actions

The dashboard SHALL expose `POST /dashboard/maintenance/purge-sessions` and `POST /dashboard/maintenance/purge-archived-memories`. Both routes SHALL:

1. Validate the CSRF token using the existing `csrfInput` / `csrfCheck` mechanism. Missing or invalid CSRF SHALL return `403`.
2. Assert the dashboard session's underlying token has `scope = '*'`. Mismatch SHALL return `403`.
3. Call the corresponding service method with `adminBypass: true`.
4. Redirect with `303 See Other` to `/dashboard/maintenance?purged-sessions=N` (or `?purged-memories=N`) where `N` is the count actually deleted by the service call.
5. On the subsequent GET, the page SHALL render a flash banner showing the count and the timestamp of the purge.

#### Scenario: An admin-scope session triggers a sessions purge

- **GIVEN** a dashboard session with `scope = '*'`, 12 eligible empty sessions, and a valid CSRF token
- **WHEN** the session POSTs to `/dashboard/maintenance/purge-sessions`
- **THEN** the response SHALL be `303 See Other` with `Location: /dashboard/maintenance?purged-sessions=12`
- **AND** the 12 session rows SHALL no longer exist in `sessions`
- **AND** a `consolidation_ops` row with `op_type='session_purge'` and `affected_ids` of length 12 SHALL exist

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
- **WHEN** the session POSTs to either purge endpoint
- **THEN** the response SHALL be `303 See Other` with `?purged-sessions=0` or `?purged-memories=0`
- **AND** no `consolidation_ops` row SHALL be written

### Requirement: The maintenance page MUST refresh counts on every GET

The pre-flight counts on `/dashboard/maintenance` SHALL be queried fresh from the database on every GET response. There SHALL NOT be a caching layer between the route handler and SQLite for these counts.

The POST handler SHALL re-run the predicate inside the same transaction as the `DELETE`. If the count visible on the page is stale because rows became eligible between page render and POST, the POST SHALL delete the actually-eligible rows (which may be more or fewer than the displayed count). The redirect query string SHALL reflect the actual deleted count, not the count that was displayed at render time.

#### Scenario: Counts grow between render and click

- **GIVEN** the page renders with `purgeable empty sessions = 12`
- **AND** between render and the operator's click, 2 more sessions become eligible
- **WHEN** the POST handler runs
- **THEN** all 14 eligible sessions SHALL be deleted
- **AND** the redirect SHALL include `?purged-sessions=14`

### Requirement: The judgment-queue view MUST be served at `/dashboard/judgments`

The dashboard SHALL serve the operator-facing queue of memory-relation judgments at the URL `/dashboard/judgments`. The page SHALL list every row of `memory_relations` (status `pending`, `judged`, or `orphaned`), SHALL support filtering by status and verdict kind, and SHALL paginate results. The legacy path `/dashboard/relations` SHALL NOT respond; any request to it SHALL return the standard dashboard `404` body.

The page heading SHALL read `Rembric Judgments.` (with `Rembric` highlighted via `hl-lime`), the document `<title>` SHALL read `Judgments · Rembric`, the empty-state cell SHALL read `No judgments match this filter.`, the table column previously labelled `relation` SHALL be labelled `verdict`, and the orphan-not-found flash SHALL read `Judgment not found or already closed.`.

#### Scenario: Operator opens the judgment queue

- **WHEN** an authenticated operator navigates to `/dashboard/judgments`
- **THEN** the server SHALL return a `200` HTML response whose heading reads `Rembric Judgments.` and whose table column header for the relation kind reads `verdict`

#### Scenario: Legacy `/dashboard/relations` returns 404

- **WHEN** any authenticated request reaches `/dashboard/relations`
- **THEN** the server SHALL respond with `404 Not Found` (no redirect)

#### Scenario: Sidebar links to the new URL

- **WHEN** any authenticated dashboard page is rendered
- **THEN** the sidebar nav item labelled `JUDGMENTS` SHALL have `href="/dashboard/judgments"` and the home overview SHALL link to `/dashboard/judgments?status=pending` from the pending-judgments stat card and from the `OPEN ALL ›` row header

#### Scenario: CSRF action token uses the judgment vocabulary

- **WHEN** the operator submits the "mark this judgment as orphaned" form on the judgments page
- **THEN** the CSRF token issued by the form and the action verified by the server SHALL both be the string `judgment.orphan`

### Requirement: The dashboard login view MUST present a single canonical brand mark, headline, and client-support footer

The `/dashboard/login` page SHALL render a single brand block in the top-left of the left pane containing the transparent Rembric logo (`/dashboard/assets/logo-transparent.png`) at 56 × 56 px on desktop, 48 × 48 px at viewports ≤ 980 px, and 40 × 40 px at viewports ≤ 640 px, followed by two lines of mono text (`REMBRIC` and `SELF-HOSTED`). The main headline SHALL read `REMBRIC DASHBOARD.` with `REMBRIC` rendered via the `hl-lime` highlight pill and the trailing period rendered in `var(--lime)`. The headline `line-height` SHALL be at least `1.3` so the `hl-lime` background does not visually clip the next line.

A footer SHALL list the supported plugin clients in the following order, separated visually by lime square bullets: `CLAUDE CODE`, `CODEX CLI`, `HERMES`, `MCP CLIENTS`. The right pane SHALL contain only the admin-token form (a labelled password input + a primary submit button) and SHALL NOT contain redundant section chips or security-disclosure copy that duplicates the `/tokens` documentation.

#### Scenario: Login renders the canonical brand mark

- **WHEN** an unauthenticated request hits `/dashboard/login`
- **THEN** the response HTML SHALL contain exactly one `<img>` with `src="/dashboard/assets/logo-transparent.png"` inside an element with class `login-brand`, placed before any `<form>` element

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
