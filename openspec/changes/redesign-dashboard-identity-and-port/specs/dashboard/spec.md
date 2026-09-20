## RENAMED Requirements

- FROM: `### Requirement: Dashboard MUST follow the brutalist visual identity`
- TO: `### Requirement: Dashboard MUST follow the liquid-glass visual identity`

## MODIFIED Requirements

### Requirement: The dashboard MUST be served at `/dashboard`

The server SHALL serve a server-side rendered dashboard at the `/dashboard` path of the same process and port as the MCP endpoint. The dashboard SHALL be an application surface of `apps/web` whose route components are React Server Components, and every asset it references SHALL be served from this same origin: the framework's content-hashed build output (stylesheets, scripts, fonts) under its own static-asset path, and the dashboard's images (logo, favicons) from the application's `public/` tree. **No CDN dependency at runtime.** The `/dashboard/assets/` path SHALL continue to resolve for the committed images, which are served from `public/dashboard/assets/**`; the hand-written CSS bundles, the enumerated third-party JavaScript files and the hand-written font URLs that path used to carry are retired with the stack that served them.

#### Scenario: Dashboard home is reachable

- **WHEN** an authenticated operator navigates to `/dashboard`
- **THEN** the server SHALL return an HTML page with the layout, stats summary, and navigation rendered server-side

#### Scenario: Every served asset comes from this origin

- **WHEN** any dashboard page is loaded
- **THEN** every stylesheet, script, font and image it references SHALL be served from this application's own origin, and the page SHALL issue no request to any third-party host

#### Scenario: The committed images keep their published path

- **WHEN** the login page renders the brand logo
- **THEN** its `src` SHALL resolve to `/dashboard/assets/logo-transparent.png`, served from the application's public tree with no route handler in between

### Requirement: Memory browsing MUST support filters and pagination

The `/dashboard/memories` view SHALL support filtering by project, type, status, **review state**, and free-text search, and SHALL paginate results. All filtering SHALL be performed server-side; the filter form SHALL submit as a GET whose query string encodes every active filter, so a filtered page is a shareable URL and the browser's back button is correct. A client component MAY enhance the free-text control with debounced incremental search, but the server SHALL remain the only place where filtering, ordering, pagination and counting happen.

The view SHALL render review state in a dedicated `review` column (separate from `status`, because review is an orthogonal axis — a freshness signal, not a lifecycle value): each `active` row whose derived `reviewState = 'needs_review'` (derivation per the `memory` capability) SHALL show a `needs_review` badge in that column; all other rows SHALL show a neutral placeholder. The badge SHALL be rendered by the dashboard's shared badge component using the theme's review-state tone — no ad-hoc colour value is introduced outside the theme tokens. The filter form SHALL include a `review` control with values `(any)` (default) and `needs_review`; when `review = needs_review` the list SHALL show only `active` memories deriving `needs_review`, computed server-side with the per-type TTL pushed into SQL so pagination is correct, respecting the current project filter and preserving all active filters across pagination and filter changes.

The view header SHALL render a `TOTAL` meta chip whose value is the true count of rows matching the **current filter set** (the combined scope/status/type/review/search filters), independent of pagination — NOT the count of rows on the current page. The header SHALL also render a `SHOWING N ROWS` indicator carrying the page-slice count. The true count SHALL be computed by a dashboard-only, `admin*`-prefixed repository read so that no counting SQL leaves the data layer. For the FTS-search branch the count SHALL be the number of rows matching the search expression **within the current scope/status/type filter** — mirroring the client-side filter the list applies to the FTS page — not the raw match count (which would over-report by including superseded/out-of-scope rows the list drops) and not the page slice; for the `needs_review`-only branch it SHALL be the number of active rows deriving `needs_review` for the active project filter.

For the single combination of `review = needs_review` AND a non-empty free-text query — where review state is derived after the page slice rather than in SQL — the `TOTAL` chip SHALL render the page-slice count suffixed with `+` (a "at least N" lower bound) rather than an inexact exact-looking number.

**The free-text query SHALL be sanitized before it reaches the `memory_fts` `MATCH` expression**, using the same sanitizer as `memory.search`'s hybrid retrieval, so that ordinary punctuation (an apostrophe, a stray quote, a hyphenated word) degrades to no lexical match rather than raising an FTS5 syntax error. The search input SHALL redisplay the operator's original, unsanitized text — not the transformed match expression.

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

#### Scenario: A search query containing FTS5 metacharacters does not crash the page

- **GIVEN** the operator types `docker-compose?` or `what's the deploy plan` into the memories search box
- **WHEN** the query is submitted
- **THEN** the page SHALL render normally (no 500), showing matches for the sanitized terms
- **AND** the search input SHALL redisplay exactly what the operator typed, not the sanitized match expression

### Requirement: Mutating dashboard requests MUST be CSRF-protected

Every mutating dashboard interaction SHALL be protected against cross-site request forgery, and the server SHALL reject a mutating request whose protection check fails **before any service call**, leaving every row unchanged. The protection SHALL be the framework's own origin/host verification of Server Actions where that verification is demonstrated to refuse a cross-origin submission — and the dashboard's session-bound token checked inside the action boundary where it is not. Which of the two applies is a measured fact, not an assumption: this requirement describes the behaviour both must provide, and the implementation SHALL NOT claim the framework's protection until a probe has observed it refusing a cross-origin submission while a same-origin control succeeds. The retired mechanism is the string token minted into every form and checked by a route handler; a session-bound token kept inside the action boundary is a conforming implementation of this requirement.

#### Scenario: Missing CSRF token

- **WHEN** a `POST` reaches a dashboard mutation without the protection that applies to it — no valid session-bound token, or a request whose origin/host fails the framework's check
- **THEN** the server SHALL refuse it with `403 Forbidden`, SHALL NOT invoke the service, and SHALL NOT create or change any row

#### Scenario: A same-origin mutation still works

- **GIVEN** an authenticated dashboard session
- **WHEN** a same-origin form submission invokes a dashboard mutation with valid input
- **THEN** the mutation SHALL execute and no `403` SHALL be returned

#### Scenario: The protection is probed, not assumed

- **WHEN** the mutation protection mechanism is changed or the framework it depends on is upgraded
- **THEN** the suite SHALL contain a failing cross-origin case and a passing same-origin control, so a protection that has silently stopped protecting cannot pass

### Requirement: Destructive dashboard actions MUST gate submission with the confirmation modal

Every dashboard action whose submit triggers a destructive or hard-to-reverse server action — soft-delete, hard-delete/purge, revoke, archive, abandon, undo of a journaled op — SHALL be gated by the dashboard's confirmation dialog before its Server Action runs. The dialog SHALL be rendered once by the dashboard shell and opened by a client component; each call site SHALL declare three values to the action component:

- A **tone**: `warn` — for destructive actions the operator can revert through an existing UI path (e.g. soft-delete + undelete, archive + re-save, undo-of-undo); `danger` — for actions that cannot be unwound through the UI (e.g. hard-delete via maintenance purge, token revoke, hard undo of an op when the affected rows still exist but no further undo path exists).
- A **sentence**: a plain-language sentence ending in a question, naming the count (when applicable) and stating the consequence shape (reversible / irreversible / journaled).
- A **label**: the uppercase VERB + COUNT + NOUN ("PURGE 12 SESSIONS", "REVOKE TOKEN", "UNDO ENTIRE RUN") matching the action being taken, NOT a generic "OK".

The `data-confirm`, `data-confirm-label` and `data-confirm-tone` HTML attributes, the `form[data-confirm]` selector binding and the `htmx:afterSwap` rebind are retired with the stack that needed them; the three properties above are preserved as component props. A destructive control that declares no confirmation SHALL fail review.

The dialog is a client-side gate and SHALL NOT be the authorization boundary: the action SHALL remain safe when its form is submitted through the framework's no-JavaScript path, which means scope, admin gating, mutation protection and service-level preconditions SHALL be sufficient without it.

#### Scenario: A destructive form with attributes on the form opens the modal

- **GIVEN** a dashboard control whose action component declares a tone, a sentence and a label — the three declarations that replace the retired `data-confirm*` form attributes
- **WHEN** the operator triggers it
- **THEN** the confirmation dialog SHALL open with that sentence and label, and the Server Action SHALL run only after the operator confirms

#### Scenario: A destructive form with attributes only on the button submits without prompting (forbidden)

- **GIVEN** a destructive control that declares its confirmation somewhere no gate can read it — on the submit control rather than on the action — or that declares none at all
- **WHEN** the operator triggers it
- **THEN** the dialog SHALL NOT open and the action SHALL run immediately, which is a defect
- **AND** code review SHALL reject the pattern and move the declaration onto the action

#### Scenario: Tone selection matches undoability

- **WHEN** the form action is destructive but reversible through the UI (e.g. soft-delete via `deleted_at`)
- **THEN** the declared tone SHALL be `warn`
- **WHEN** the form action cannot be unwound through the UI (e.g. operator-purge via `/dashboard/maintenance`, token revoke)
- **THEN** the declared tone SHALL be `danger`

#### Scenario: A form-level rebind after an HTMX swap

- **WHEN** a destructive control is rendered after a client-side navigation or a partial re-render (the swap that used to inject new forms, and with them the re-binding step the retired attribute protocol needed)
- **THEN** the shell's dialog SHALL serve it with no re-binding step, so no rendered form can escape the gate by arriving late

#### Scenario: Authorization does not depend on the dialog

- **GIVEN** a destructive form submitted through the framework's no-JavaScript path
- **WHEN** the request reaches the action
- **THEN** the action's own scope, admin and mutation-protection checks SHALL decide the outcome, and the presence or absence of the dialog SHALL grant no authority

### Requirement: Dashboard timestamps MUST render in the viewer's local timezone

Every timestamp surfaced by the dashboard (memories list and detail, sessions list and detail, the soft-delete banner, prompts, consolidation runs and operations, projects, tokens, judgments, entities, maintenance, and the `replaces` chain on memory detail) SHALL be rendered through a single shared timestamp component that emits a `<time>` element with:

- A `datetime` attribute set to the ISO-8601 UTC representation (suffix `Z`) of the underlying timestamp.
- A `data-rembric-ts` attribute marking it as a Rembric-managed timestamp.
- A visible text content that, before any client script runs, equals the UTC string `YYYY-MM-DD HH:MM:SS UTC`.

A client component rendered by the dashboard shell SHALL upgrade every `<time data-rembric-ts>` element in place after hydration, replacing its `textContent` with a `Intl.DateTimeFormat`-formatted string using the browser's timezone and default locale. The previous inline script in the shell `<head>` and its re-run on every HTMX content swap are retired: a timestamp produced by a later client-side render SHALL be upgraded by the same component on mount, with no document-level rescan.

The SQLite storage, the service-layer `new Date()` writes, and the MCP serialization of timestamps SHALL remain UTC; only the rendered dashboard changes.

#### Scenario: SSR renders UTC fallback

- **WHEN** the dashboard returns an HTML page containing a timestamp
- **THEN** the response body SHALL contain a `<time datetime="…Z" data-rembric-ts>YYYY-MM-DD HH:MM:SS UTC</time>` element for that timestamp, with no JS execution required to produce the fallback text

#### Scenario: Client upgrades the visible text to local time

- **WHEN** a browser with `Intl.DateTimeFormat` support loads any dashboard page after the change
- **THEN** every `<time data-rembric-ts>` element's `textContent` SHALL be replaced with the formatted-local-time representation of its `datetime` attribute, using the browser's timezone

#### Scenario: HTMX swap re-applies the upgrade

- **WHEN** a dashboard surface re-renders a subtree and that subtree contains new `<time data-rembric-ts>` elements (the swap that used to inject them, now a client-side render)
- **THEN** the timestamp component SHALL upgrade the new elements on mount, without requiring a document-level rescan of the elements already rendered

#### Scenario: Null or invalid timestamp renders an em-dash

- **WHEN** a dashboard page calls the timestamp helper with `null`, `undefined`, or a value that does not parse to a valid date
- **THEN** the rendered output SHALL be the literal em-dash `—` and SHALL NOT contain a `<time>` element

#### Scenario: Dashboard layout includes the upgrader script exactly once

- **WHEN** any dashboard page is rendered through the shell
- **THEN** the shell SHALL mount exactly one component responsible for upgrading `<time data-rembric-ts>` elements, with no second upgrader and no document-level rescan

### Requirement: Dashboard CSS MUST be minified and content-hashed in production

The dashboard's production build SHALL emit minified, content-hashed CSS and SHALL serve it with `Cache-Control: public, max-age=31536000, immutable`. The dashboard no longer owns this pipeline itself: Tailwind v4 (through its PostCSS integration) produces the CSS, the framework's build minifies and content-hashes it, and the framework serves it. The retired machinery is the `lightningcss` build step, the `core.<hash>.css` + `views/<view>.<hash>.css` two-bundle contract and the `manifest.json` view registry. The requirement is the observable outcome: the stylesheet a production page references SHALL be content-hashed and minified, and its response SHALL carry the immutable cache directive. If the framework's default response for a deployed environment does not include that directive, the header SHALL be set explicitly rather than the promise dropped.

#### Scenario: Hashed files are served with immutable cache

- **WHEN** a production dashboard page requests the stylesheet it references
- **THEN** the response SHALL carry `Cache-Control: public, max-age=31536000, immutable`

#### Scenario: A CSS edit produces a new hash

- **WHEN** the contents of a theme token or a component's styles change and the production build runs again
- **THEN** the referenced stylesheet's path SHALL change, so no browser serves the stale stylesheet from cache

### Requirement: Dashboard MUST follow the liquid-glass visual identity

The dashboard SHALL render the identity-A liquid-glass visual identity in both a dark mode and a light mode, expressed as CSS custom properties in the shadcn token slots rather than as values frozen in this specification. The theme SHALL be declared once, in `apps/web/src/app/globals.css`.

The token slots this identity occupies:

- **Semantic surface and text roles** — `--background`, `--foreground`, `--card`, `--card-foreground`, `--popover`, `--muted`, `--muted-foreground`, `--border`, `--input`, `--ring`, `--radius`.
- **Brand role** — `--primary` (with its foreground pair) as the lime brand fill, carried over unchanged from the identity this one replaces.
- **Semantic state roles** — `--destructive` for irreversible actions, plus a warning role for reversible destructive ones; these are the two tones the confirmation contract distinguishes.
- **Light-surface text accent** — an olive-family token for text on light glass surfaces, distinct from the brand fill, so lime stays a fill and never becomes body text.
- **Typography roles** — `--font-sans`, `--font-display` and `--font-mono`, wired to the self-hosted families.
- **Glass roles** — a `--glass-*` group (surface tint, blur radius, saturation, specular edge, border) owned by the identity layer rather than by the semantic set, so glass surfaces can be retuned without touching component code.

The **exact values** of the glass group and of the light-surface accent are NOT fixed by this requirement: they are finalised at implementation against the design reference and recorded once, in `globals.css`. Freezing values here would lock in numbers nobody has chosen, which is the failure mode of the requirement this one replaces. The retired brutalist contract is its token list, its single `#0a0a0a` surface, its prohibition on a light theme, and its "changing any of these tokens SHALL require a new OpenSpec change" rule: changing a token value SHALL NOT require a spec change, as long as every role above remains occupied and both modes still render.

The dashboard SHALL support a dark mode and a light mode selected by the `.dark` class on the document element, defaulting to dark. A theme switcher or per-user theme setting is not required by this requirement and SHALL NOT be introduced by it.

#### Scenario: Tokens are declared once in core.css

- **WHEN** a contributor inspects the token declaration (the file the previous contract called `core/tokens.css`, now the `globals.css` theme block)
- **THEN** every role listed above SHALL be declared in a single `@theme`/`:root` block plus a `.dark` block, and no entry of the retired brutalist token list SHALL remain in the repository

#### Scenario: Both modes render

- **WHEN** the document element carries the `.dark` class the dark values SHALL apply, and when it does not the light values SHALL apply
- **THEN** text and surfaces in each mode SHALL be rendered from that mode's foreground and surface tokens, and no component SHALL fall back to a hardcoded colour that breaks in the other mode

#### Scenario: Changing a token value needs no spec change

- **WHEN** an implementation changes a token value in `globals.css`
- **THEN** no OpenSpec change SHALL be required, provided every role above stays occupied and both modes still render

#### Scenario: Glass surfaces are tunable independently

- **WHEN** a contributor changes a `--glass-*` value
- **THEN** every glass surface SHALL follow it without any component file being edited

### Requirement: Dashboard fonts MUST be self-hosted

The dashboard SHALL serve Space Grotesk (weights 400, 500, 600, 700), Inter (weights 400, 500, 600), and JetBrains Mono (weights 400, 500, 600) as woff2 files committed inside the application, loaded through `next/font/local` and exposed as the theme's font variables. The dashboard SHALL NOT reference Google Fonts or any other font CDN at runtime, and SHALL NOT fetch a font at request time. The loader hashes, self-hosts and preloads the files from this origin, so the previous `@font-face` declarations in hand-written CSS, the fixed `/dashboard/assets/fonts/<family>-<weight>.woff2` URLs and the hand-written immutable-cache rule are retired; the observable outcome those stated — fonts served from this origin with long-lived immutable caching — is unchanged.

#### Scenario: No external font requests

- **WHEN** a browser loads any dashboard page
- **THEN** the page SHALL NOT trigger an HTTP request to `fonts.googleapis.com`, `fonts.gstatic.com`, or any host other than the Rembric server

#### Scenario: The three families resolve through the theme

- **WHEN** any dashboard page is rendered
- **THEN** the display, sans and mono font variables SHALL resolve to Space Grotesk, Inter and JetBrains Mono respectively, and the built output SHALL contain the hashed woff2 files served from this origin

#### Scenario: Every font weight is reachable

- **WHEN** a heading, a body paragraph and a code block are rendered
- **THEN** each family SHALL be loaded with the weights the previous contract declared, so no weight falls back to a synthesized variant

### Requirement: Dashboard navigation MUST use a sidebar with persisted collapse state

The dashboard SHALL render its primary navigation as a left-hand vertical sidebar listing the routes Overview, Memories, Sessions, Prompts, Judgments, Consolidation, Projects, Tokens, Maintenance. The sidebar SHALL be built from the adopted collapsible sidebar block — its provider, trigger, inset, nav-group, nav-item and badge primitives — rather than from hand-written layout CSS, and SHALL support a collapsed mode (icons only, narrower fixed width) on desktop viewports with a toggle control. That block's provider SHALL also own the narrow-viewport behaviour, replacing the custom mobile bar: below the tablet breakpoint the navigation SHALL be reachable through the provider's mobile sheet, and the separate `☰ MENU` drawer implementation and its inline script are retired.

The collapse state SHALL be persisted in an HTTP cookie named `rbr-sb-collapsed` (value `1` collapsed, `0` or absent expanded), scoped to `Path=/dashboard`, with `SameSite=Lax`. The server SHALL read this cookie when rendering any dashboard page and SHALL render the sidebar's initial state from it, so the server-rendered HTML matches the persisted state on first paint.

The toggle SHALL work without client JavaScript: it SHALL submit a Server Action that flips the cookie and returns to the page the control was used on. A client component MAY additionally apply the collapsed state optimistically so the width transition plays.

#### Scenario: Collapsed state survives reload

- **GIVEN** the operator has collapsed the sidebar
- **WHEN** the operator reloads any dashboard page
- **THEN** the server-rendered HTML SHALL reflect the collapsed state, and no client script SHALL be required to apply it

#### Scenario: Toggle works without JavaScript

- **WHEN** the operator activates the toggle with JavaScript disabled
- **THEN** the server SHALL flip the `rbr-sb-collapsed` cookie and return the operator to the page the control was used on

#### Scenario: CSRF protection on toggle

- **WHEN** the toggle submission fails the dashboard's mutation protection
- **THEN** the server SHALL refuse it with `403 Forbidden` and SHALL NOT flip the cookie

#### Scenario: The narrow-viewport navigation comes from the sidebar block

- **WHEN** any dashboard page is loaded at a viewport width of 980 px or less
- **THEN** the navigation SHALL be reachable through the sidebar block's mobile sheet, and no separate mobile-bar component or drawer script SHALL exist in the application

#### Scenario: Prompts entry appears in the sidebar between Sessions and Judgments

- **WHEN** any authenticated dashboard page is rendered
- **THEN** the sidebar's MAIN group SHALL list, in order: Overview, Memories, Sessions, Prompts, Judgments, Consolidation

### Requirement: Dashboard MUST be fully responsive across desktop, tablet, and phone viewports

Every dashboard route SHALL render correctly and remain fully usable from a viewport width of 320 px upwards. The responsive system SHALL honour the following bands, expressed through the utility engine's responsive variants and the adopted components' own breakpoints:

- **≥1281 px (full desktop)**: full-width expanded sidebar; dense stat grids at their maximum column count.
- **≤1280 px (compact desktop)**: reduced main padding; dense stat grids reflow to a reduced column count.
- **≤980 px (tablet / narrow)**: the sidebar's mobile sheet becomes the navigation; multi-column grids stack to 2-3 columns; paired and tripled columns collapse to a single column; data tables remain horizontally scrollable inside their own container; filter rows become one control per row; action bars wrap.
- **≤640 px (phone)**: dense stat grids show 2 columns; two-column key/value grids show 2 columns; the login stage keeps both panes stacked vertically (it does not hide the identity pane); view-head headings reduce in size; table minimum widths drop.

At every viewport, the page SHALL NOT introduce horizontal page-level scrolling (only a table's own scroll container and code/preformatted blocks may scroll horizontally). Interactive controls (buttons, pager items, sidebar items, form fields) SHALL have a touch target of at least 44 × 44 CSS pixels at viewports ≤980 px.

#### Scenario: Sidebar becomes a mobile drawer at ≤980 px

- **WHEN** any dashboard page is loaded at a viewport width of 980 px or less
- **THEN** the desktop sidebar SHALL be hidden by default and tapping the sidebar block's mobile trigger SHALL open the navigation sheet

#### Scenario: No horizontal page scroll at any breakpoint

- **WHEN** any dashboard page is loaded at viewport widths 1440, 1100, 768, 540, or 360 px
- **THEN** the document element's horizontal overflow SHALL be `hidden` or the rendered content SHALL fit within the viewport, with the only horizontally-scrollable elements being a table's scroll container and any explicit code/preformatted block

#### Scenario: Stat grids reflow at narrow widths

- **WHEN** any page containing a dense stat grid is rendered at a viewport width of 640 px or less
- **THEN** the grid SHALL show exactly 2 columns and SHALL preserve its internal border lines between cards

#### Scenario: Tables stay reachable on phone widths

- **WHEN** a table wider than the viewport is rendered at ≤640 px
- **THEN** the table SHALL scroll horizontally within its own container without expanding the page width

### Requirement: List tables MUST NOT spend a column on row ids

Dashboard list tables SHALL NOT render a dedicated `id` column. Row identity is carried by the row's semantic cell (title, content, or timestamp), and navigation to a detail page — where one exists — is provided by exactly one real `<a>`/`<Link>` anchor hosted on that semantic cell, so cmd-click / middle-click / keyboard navigation keep working. The whole-row `data-href` attribute and the inline click handler that consumed it are retired with the hand-written dashboard; the row is not the link.

Concretely:

- Sessions list: the `title` cell carries the anchor to `/dashboard/sessions/{id}`.
- Memories list, session detail → Memories, memory detail → Predecessors: the `content` cell carries the anchor to `/dashboard/memories/{id}`.
- Consolidation runs list: the `started` cell carries the anchor to `/dashboard/consolidation/{id}`.
- Judgments list: the `created` cell carries the anchor to `/dashboard/judgments/{id}`.
- Projects (active + archived), prompts list, session detail → Prompts, consolidation run detail → Ops: the id column is removed with no replacement anchor — these rows have no detail page. Memory shortId anchors inside the ops table's `affected` / `created` cells are retained: they are cross-navigation, not row identity.

`shortId(...)` rendering remains in use outside list-table columns (detail-page headings such as `Rembric Memory {shortId}.`, ops `affected`/`created` cells, prompt session links).

#### Scenario: A navigable list row keeps exactly one real anchor

- **WHEN** an authenticated operator renders any list whose rows have a detail page (sessions, memories, consolidation runs, judgments, predecessors, session-detail memories)
- **THEN** each row SHALL contain exactly one anchor pointing at its detail URL, hosted on the row's semantic cell
- **AND** no `<th>` labelled `id` SHALL be present in the table header

#### Scenario: Tables without detail pages drop the id column with no replacement

- **WHEN** an authenticated operator renders the projects, prompts, session-detail prompts, or run-detail ops tables
- **THEN** no `<th>` labelled `id` SHALL be present and no cell SHALL render the row's own short id
- **AND** row action controls SHALL keep functioning (their actions carry the full id)

#### Scenario: Row navigation requires no click handler

- **WHEN** a list row with a detail page is rendered
- **THEN** it SHALL NOT rely on a row-level click handler or a `data-href` attribute to navigate, and keyboard activation of the semantic cell's anchor SHALL reach the detail page

### Requirement: The dashboard MUST present a per-version dismissable update modal with the release changelog

When a newer version is known and the operator has not dismissed that specific version, the dashboard SHALL present an update modal showing: current version → new version, the release publication time (via the shared timestamp component), the release changelog body rendered from the GitHub Release, and a link to the release on GitHub. A "Later" action SHALL dismiss the modal for that version only (client-side persistence); the next newer release SHALL re-trigger it. The modal SHALL NOT offer an in-application update trigger — the served application does not replace itself — so its action area SHALL depend on the deployment's capability state:

- `pinned` — an explanation that the image tag is pinned and how to unpin it.
- every other state, including a deployment that could be upgraded — a copy-to-clipboard upgrade command and a link to `docs/updates.md`, so the operator performs the swap at the deployment layer. This is the branch the previous contract called `available`, whose in-app trigger is retired with the orchestrator.

#### Scenario: First visit after a release

- **WHEN** an operator opens the dashboard and a newer, undismissed version exists
- **THEN** the update modal SHALL appear with the version diff, the changelog, and the capability-appropriate action

#### Scenario: Dismissed version stays dismissed

- **WHEN** the operator chose "Later" for `0.22.0` and reloads the dashboard
- **THEN** the modal SHALL NOT reappear for `0.22.0`

#### Scenario: Manual quadrant

- **WHEN** the modal renders under any capability state
- **THEN** it SHALL NOT contain a control that updates the running deployment, and it SHALL show either the pinned-tag explanation or the copy-paste upgrade command with the docs link

### Requirement: Long text content on detail views MUST be rendered as Markdown

On detail views, the dashboard SHALL render long text `content` fields as Markdown using an in-process parser, rather than displaying the raw Markdown source inside an escaped `<pre>` block. This applies to: memory detail content (`/dashboard/memories/:id`), session description (seed goal) and **curated** session summary (`/dashboard/sessions/:id`), the expanded prompt content cell (`/dashboard/prompts`), and the Source and Target memory content on the judgment detail view (`/dashboard/judgments/:id`).

**Session summaries SHALL be Markdown-rendered ONLY when curated (`summary_final = 1`).** When a session has a summary with `summary_final = 0` (a raw transcript sync from a client hook/provider, never confirmed by the model), the detail view SHALL instead render it as escaped preformatted text (monospace, inside its own `overflow-x: auto` container — the pattern the judgment Evidence block uses), and SHALL display an "RAW" (uncurated) badge adjacent to the Summary heading, using the shared badge component — no ad-hoc colour value. Rationale: raw transcripts frequently contain Markdown-looking framework text (tables, headers, tool documentation); rendering them as formatted Markdown makes an uncurated dump visually indistinguishable from a model-authored summary, which misled operators in practice. The session description (seed goal) is operator/agent-provided, never raw-synced, and SHALL remain Markdown-rendered unconditionally.

Fields that are NOT free-form Markdown content SHALL NOT be Markdown-rendered: the judgment Reason SHALL remain a plain (escaped) paragraph, and the judgment Evidence SHALL remain a `<pre>` block because it is pretty-printed JSON.

The Markdown parser SHALL be configured to **disable raw HTML passthrough** (`html: false`): any HTML tags present in the source SHALL be rendered as escaped text, never as live markup. The parser SHALL reject dangerous URL schemes (e.g. `javascript:`, `vbscript:`, `data:`) in links, leaving the affected link inert. No separate HTML sanitizer SHALL be required for safety. The rendered HTML SHALL be the **only** value passed to an unescaped rendering boundary in the entire dashboard — the Markdown component's `dangerouslySetInnerHTML`. User-supplied content SHALL never bypass escaping anywhere else.

The rendering SHALL be performed entirely server-side and in-process; no CDN, network call, or client-side JavaScript SHALL be required to display formatted content. Rendering SHALL use the theme's tokens and the self-hosted font variables, SHALL NOT introduce an ad-hoc colour or font value outside them, and fenced/inline code SHALL remain monospace.

Each rendered Markdown block SHALL provide an icon-only control that copies the verbatim Markdown source to the clipboard, so the raw source remains recoverable behind the render. The source SHALL be carried in the page (not re-fetched) such that copying yields the original source — including the literal `**`, backticks, and fences — rather than the rendered HTML. The control SHALL function in non-secure (plain-HTTP) deployments via a clipboard fallback. This control is a progressive enhancement implemented as a client component; the formatted content itself SHALL still render with JavaScript disabled. (The uncurated-summary `<pre>` block needs no copy control: its visible text IS the verbatim source.)

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

#### Scenario: Session description and curated summary render Markdown

- **GIVEN** a session whose `summary_final = 1` (the model called `memory.session_summary`)
- **WHEN** an authenticated operator opens `/dashboard/sessions/:id` for that session with a Markdown-formatted description and summary
- **THEN** both the description (seed goal) and the summary SHALL be rendered as formatted HTML
- **AND** no RAW badge SHALL appear next to the Summary heading

#### Scenario: Uncurated session summary renders as raw preformatted text with a RAW badge

- **GIVEN** a session whose `summary` is a raw transcript sync and `summary_final = 0`
- **WHEN** an authenticated operator opens `/dashboard/sessions/:id`
- **THEN** the summary SHALL be displayed as escaped preformatted monospace text inside a horizontally-scrollable container, NOT as rendered Markdown
- **AND** a "RAW" (uncurated) badge SHALL appear adjacent to the Summary heading
- **AND** the description (seed goal), if present, SHALL still render as Markdown

#### Scenario: Judgment Source/Target render Markdown but Evidence stays JSON

- **WHEN** an authenticated operator opens `/dashboard/judgments/:id`
- **THEN** the Source and Target memory content SHALL be rendered as formatted Markdown
- **AND** the Evidence block SHALL remain a `<pre>` rendering of the pretty-printed JSON (not Markdown-rendered)

#### Scenario: List snippets remain plain text

- **WHEN** the operator views the `/dashboard/memories` list where a row's content contains `**bold**`
- **THEN** the truncated snippet cell SHALL display the raw characters as escaped plain text and SHALL NOT render Markdown formatting

#### Scenario: The unescaped boundary is exactly one

- **WHEN** the dashboard source is searched for an unescaped rendering boundary
- **THEN** the only occurrence SHALL be the Markdown component, and it SHALL pass the parser's output and nothing else

### Requirement: User-supplied text rendered outside the Markdown pipeline MUST be HTML-escaped

Any dashboard component that renders user- or agent-supplied text SHALL pass it as a React text child, which React escapes, or through the theme's components as a plain string prop. The dashboard SHALL NOT contain a general-purpose unescaped-rendering helper: the `raw()`, `SafeHtml` and `escape()` helpers of the hand-written dashboard are deleted, and the Markdown component's `dangerouslySetInnerHTML` is the single unescaped boundary in the application. This applies in particular to prompt tags (agent-supplied via `memory.save_prompt`, rendered on the session detail and prompts list views) and project slugs (operator-supplied at project creation; legacy slugs may predate the current slug validation regex and are not guaranteed to be free of HTML metacharacters).

#### Scenario: A prompt tag containing HTML metacharacters renders as literal text

- **GIVEN** a prompt anchored to a session, with a tag containing `<` or `>` characters
- **WHEN** the operator opens the session detail view or the prompts list view
- **THEN** the tag SHALL render as escaped literal text
- **AND** SHALL NOT be interpreted as HTML or execute as script in the operator's browser

#### Scenario: A legacy project slug containing HTML metacharacters renders as literal text

- **GIVEN** a project whose `slug` predates the current slug-validation regex and contains HTML metacharacters
- **WHEN** the operator opens a dashboard view that renders that slug (e.g. the sessions list)
- **THEN** the slug SHALL render as escaped literal text
- **AND** SHALL NOT be interpreted as HTML or execute as script in the operator's browser

#### Scenario: A second unescaped boundary fails the guard

- **WHEN** a component outside the Markdown component introduces an unescaped rendering boundary
- **THEN** the dashboard's guard test SHALL fail naming the file, so the boundary count cannot grow silently

## ADDED Requirements

### Requirement: The dashboard UI SHALL be built from shadcn/ui blocks and components over Tailwind v4

The dashboard SHALL be implemented with shadcn/ui over Tailwind v4, using its blocks and components to the maximum extent the design allows. shadcn components SHALL be copied into `apps/web/src/components/ui/` and owned by this repository — edited freely, upgraded deliberately — and SHALL NOT be consumed as a versioned runtime UI dependency. The supporting dependencies SHALL be limited to `tailwindcss` v4 with `@tailwindcss/postcss`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, the `@radix-ui/*` packages the adopted components require, and `@tanstack/react-table` for the data-dense tables. Drag-and-drop toolkits and alternate icon sets SHALL NOT be adopted: the dashboard has no drag interaction, and `lucide-react` is the icon set every adopted component already uses.

The adopted blocks, and the views they serve:

- **`sidebar-07` (collapsible)** — the shell and navigation: provider, trigger, inset, nav-group/nav-item with badges, nav-user. Its provider's mobile sheet replaces the custom mobile bar and drawer script.
- **`dashboard-01`** — the home overview: section cards (the stat strip), the area chart (the activity sparkline), and the data table (the recents table).
- **`login-01`** — the login view: the split layout, with the Rembric brand mark in the identity pane.
- **The data-table composition and its primitives** (`table`, `badge`, `button`, `input`, `label`, `select`, `checkbox`, `dropdown-menu`, `tabs`, `toggle-group`, `separator`, `drawer`, `avatar`, `sheet`, `sonner`, `breadcrumb`, `chart`, `card`) — the list surfaces and the detail surfaces.
- **`alert-dialog`** (or the equivalent dialog primitive) — destructive confirmations.

A block SHALL NOT be adopted whole where doing so imports a dependency or an affordance the dashboard does not need: the composition is copied and pruned, and every pruned piece SHALL be named in `design.md` against the block it came from.

#### Scenario: Components are owned source, not a runtime dependency

- **WHEN** the dependency graph of `apps/web` is inspected
- **THEN** no component library SHALL appear as a runtime dependency, and every adopted component SHALL exist as a file under `apps/web/src/components/ui/`

#### Scenario: The stack's dependencies are the enumerated set

- **WHEN** `apps/web/package.json` is inspected
- **THEN** the UI-related dependencies SHALL be limited to the enumerated set, `@tanstack/react-table` SHALL be present, and no drag-and-drop toolkit and no alternate icon package SHALL be present

#### Scenario: A block is pruned, not imported wholesale

- **WHEN** a block is adopted for a view
- **THEN** the pieces the dashboard does not use SHALL be removed rather than shipped, and the remaining composition, together with the pruned pieces, SHALL be recorded against the view it serves

### Requirement: Dashboard styles MUST be organised as a three-layer system

The dashboard's styles SHALL be organised in exactly three layers:

- **Theme layer** — the design tokens, declared once in `apps/web/src/app/globals.css` in a Tailwind v4 `@theme` block together with the `:root` and `.dark` custom-property blocks. No other file SHALL declare a design token.
- **Component layer** — the owned shadcn components under `apps/web/src/components/ui/**`, styled with Tailwind utilities and `class-variance-authority` variants. A component's variants live in that component's own file, never in a separate stylesheet.
- **Identity layer** — the hand-authored liquid-glass utilities the visual-identity requirement defines, declared once above the component layer and consumed by it.

Tailwind v4 (CSS-first `@theme`) SHALL be the only utility engine. No per-route stylesheet SHALL exist: a route expresses its layout with the shared components, their variants and utility classes. No route, layout or component SHALL emit a `<style>` element in the response body — the built stylesheet is a linked, content-hashed asset.

#### Scenario: The theme is declared once

- **WHEN** a contributor inspects `apps/web/src/app/globals.css`
- **THEN** it SHALL contain the single declaration of the dashboard's design tokens, and no other file in the repository SHALL declare them

#### Scenario: The HTML body carries no `<style>` block

- **WHEN** any authenticated dashboard route returns HTML
- **THEN** the response body SHALL NOT contain a `<style>` element

#### Scenario: Adding a view requires no stylesheet

- **WHEN** a contributor adds a new dashboard route that needs view-specific presentation
- **THEN** they SHALL express it with the shared components, their variants and utility classes, and no new CSS file SHALL be required

### Requirement: Data-dense list views SHALL be built from one shared data-table composition

Every list surface with sorting, filtering and pagination — memories, sessions, prompts, judgments, projects, tokens, entities, consolidation runs, the maintenance breakdowns and the home recents table — SHALL be rendered from a single shared data-table composition (the shadcn table primitives driven by `@tanstack/react-table`), so column definitions, empty states, pagination controls and row linking are defined once. The composition SHALL accept a server-provided page of rows. A view whose contract places filtering, ordering and counting on the server — which is every paginated view — SHALL drive the composition's controls through the URL (requesting the next server page) rather than letting the client re-sort or re-filter the page it received; a view over a fully loaded in-memory set MAY use the composition's client-side transformations.

#### Scenario: Every list surface uses the one composition

- **WHEN** a contributor inspects the ported list views
- **THEN** each SHALL render through the shared data-table composition, and no view SHALL hand-roll its own table markup

#### Scenario: A server-paginated list is not re-sorted on the client

- **GIVEN** a server-paginated list view
- **WHEN** the operator renders it and then changes a sort or filter control
- **THEN** the rows SHALL be re-requested from the server with the change encoded in the URL, and the order SHALL be the server's order

#### Scenario: The empty state comes from the composition

- **WHEN** a list has no rows for the active filter
- **THEN** the composition SHALL render the view's declared empty message rather than a bare empty table

### Requirement: Dashboard mutations SHALL be Server Actions

Every dashboard mutation SHALL be a Server Action invoked from a React form or a client component, validated at the action boundary before any service call, executed against the same service method the hand-written route called, and followed by a revalidation of every path whose data it changed. A rejected mutation SHALL surface as form state rendered next to the control that caused it rather than as a separate error page; a mutation that returns to a list SHALL preserve the existing redirect-plus-query-parameter flash contract. An action SHALL NOT trust a client-supplied identifier: scope, project binding and admin gating SHALL be resolved inside the action from the session, exactly as the service layer requires. No dashboard mutation SHALL be invoked by a client-side `fetch()` to a dashboard URL — the HTTP routes the actions replace are deleted with the views they served.

**The OAuth consent decision is the one exception**: it SHALL remain a form `POST` to the protocol's authorization endpoint, because that endpoint is part of the OAuth protocol contract rather than a dashboard route, and the consent view SHALL therefore stay server-rendered with no client-side JavaScript requirement.

#### Scenario: A mutation runs through an action and revalidates

- **WHEN** an operator submits a dashboard form
- **THEN** the submission SHALL invoke a Server Action that validates its input, calls the service, revalidates the affected paths, and returns updated form state or a redirect

#### Scenario: An invalid submission changes nothing

- **WHEN** an action receives input that fails validation
- **THEN** it SHALL return an error to the form, SHALL NOT call the service, and SHALL NOT change any row

#### Scenario: No dashboard mutation is invoked by a client fetch

- **WHEN** the client-side code under `apps/web/src/**` is inspected
- **THEN** it SHALL contain no `fetch()` or equivalent call to a dashboard mutation URL

#### Scenario: The consent decision stays a protocol POST

- **WHEN** the OAuth consent view renders
- **THEN** its decision control SHALL submit a form `POST` to the authorization endpoint, and the view SHALL render and function without client-side JavaScript

### Requirement: Client-side data fetching SHALL be limited to scoped React Query islands

Server Components SHALL own the initial data for every dashboard route. `@tanstack/react-query` SHALL be used only inside client islands whose data changes after render: the update check's polling, incremental search, and optimistic action state. An island SHALL NOT become the source of truth for a list, a detail record, a filtered set or a total the server computes; those SHALL remain server-rendered reads. The dashboard SHALL NOT introduce a global client-side state store. An island's first render SHALL use the server-provided value, so hydration has nothing to disagree with.

#### Scenario: A ported list is server-rendered

- **WHEN** an operator opens any list view
- **THEN** its rows, filters and totals SHALL be rendered by the server, and no client-side query SHALL be required to display them

#### Scenario: Polling is an island, not the page

- **WHEN** the operator is on a surface that polls (the update check)
- **THEN** only that island SHALL fetch, and the rest of the page SHALL remain server-rendered

#### Scenario: No global client store

- **WHEN** the dependency graph of `apps/web` is inspected
- **THEN** no global state-management library SHALL be present

### Requirement: Dashboard UI mechanisms SHALL translate to the React stack rather than be ported

The port SHALL delete the mechanisms it replaces instead of re-implementing them. The translations are:

- `apps/server/src/dashboard/components.ts`'s HTML-string helpers → React components with typed props under `apps/web/src/components/dashboard/**`.
- `raw()`, `SafeHtml` and the `escape()` helper → React text children, which React escapes.
- The single unescaped boundary → the Markdown component's `dangerouslySetInnerHTML`.
- `minifyHtml()` and its `<pre>`/`<textarea>`/`<script>` carve-outs → nothing: JSX emits no inter-tag whitespace outside preformatted text.
- The six shell scripts (`TS_UPGRADER`, `MOB_TOGGLE`, `SB_COLLAPSE`, `ROW_LINK`, `CONFIRM`, `MD_COPY`) → the timestamp component, the sidebar block's mobile sheet, the sidebar cookie action, the semantic-cell link, the confirmation dialog and the copy-source control.
- The whole-row `data-href` click → a real link on the row's semantic cell.
- The two-CSS-link per-page delivery and the `views/<view>.css` registry → the component layer and utility classes.
- Stored form `action="/dashboard/..."` route strings → Server Actions, with the OAuth consent decision excepted (see the mutation requirement).

Preserved verbatim by the port: self-hosted fonts, the timestamp convention, the destructive-confirmation contract, the responsive bands, the data-access boundaries (server-side reads through the `@rembric/core` services, mutations through Server Actions), and DS1–DS6.

#### Scenario: A deleted mechanism is not re-implemented

- **WHEN** a contributor inspects the ported dashboard
- **THEN** `apps/web` SHALL contain no HTML-minifying step, no `data-href` row navigation, no inline first-party script in a shell, and no per-view stylesheet

#### Scenario: The preserved conventions still hold

- **WHEN** any ported view is rendered
- **THEN** its timestamps, fonts, destructive confirmations, responsive bands, data-access boundaries and data-safety behaviour SHALL match the pre-port contract

### Requirement: The dashboard application SHALL bootstrap through its framework instrumentation hook

The application's instrumentation hook SHALL be its single bootstrap path, executed once per process: open the database (migrations run inside the database factory), log the resolved absolute database path and whether the file already existed, bootstrap the admin token, start the session reaper, and drain the embedder. No second bootstrap path SHALL exist. The embedder SHALL remain lazily dynamically imported, and its model assets SHALL reach the process through the image's copy step rather than through module tracing.

#### Scenario: Bootstrap runs once per process

- **WHEN** the application starts
- **THEN** the database SHALL be opened and migrated, and the startup log SHALL name the resolved absolute database path together with whether the file pre-existed

#### Scenario: A missing migrations directory fails loudly

- **WHEN** the migrations directory cannot be read
- **THEN** startup SHALL fail with an error naming the path, and SHALL NOT continue against an empty or partially migrated database

#### Scenario: The embedder is not loaded at boot

- **WHEN** the process starts and no request has needed embeddings
- **THEN** the embedder SHALL NOT have been imported, and the model assets SHALL be present in the image by copy

### Requirement: The served dashboard application SHALL NOT host a scheduler or a self-upgrade orchestrator

The dashboard application SHALL NOT run a timer that performs consolidation or any other background mutation: the consolidation sweep SHALL remain a deterministic, throttled service call in the request path. No cron exists to port and none SHALL be introduced inside the served process; if a time-based sweep is ever required, it SHALL be a separate script driven by an OS scheduler rather than a duty hidden in the web process.

The self-upgrade orchestrator SHALL NOT live in the served application: a process that replaces itself while serving is not a supported path. The dashboard SHALL keep the version display, the update-availability check, the changelog modal and the manual check, and SHALL NOT offer an in-application update trigger, an update progress view, or a version-polling endpoint. Docker owns the swap by pulling the image; the installer owns it for non-Docker deployments; `docs/updates.md` is the operator-facing route.

#### Scenario: No background timer in the served process

- **WHEN** the application's startup code is inspected
- **THEN** no scheduler, interval or timer performing consolidation or any other background mutation SHALL be registered, and the sweep SHALL be reachable only through the request path

#### Scenario: The dashboard offers no in-app update trigger

- **WHEN** an operator views the update surface while a newer version is known
- **THEN** the surface SHALL show the deployment-layer upgrade path and SHALL NOT render a control that updates the running deployment

#### Scenario: The retired update routes are gone

- **WHEN** the application's routes are inspected
- **THEN** no update-progress or in-app upgrade route SHALL exist, and a request to one SHALL return the standard not-found response

## REMOVED Requirements

### Requirement: Dashboard CSS MUST be organised as a layered design system

**Reason**: replaced by "Dashboard styles MUST be organised as a three-layer system". The requirement described the hand-written CSS system the React port deletes: a `core/` directory of five ordered files, a `views/` directory holding one stylesheet per route, a two-bundle delivery (`core.<hash>.css` plus `views/<view>.<hash>.css`), and the rule that adding a view means adding and registering its CSS file. Under the adopted stack that system does not exist — presentation lives in a token block, in each owned component's own variant definitions, and in utility classes — so both of its scenarios ("A page renders with two CSS links", "Adding a new view requires adding its CSS file") assert a structure the dashboard no longer has, and no rewrite of their bodies would make their titles true. It is removed rather than modified for that reason.

**Migration**: nothing in this requirement is observable to an operator beyond the page rendering, so no operator-facing migration exists. For contributors: `apps/server/src/dashboard/styles/core/*.css` and `styles/views/*.css` are deleted with the Hono dashboard, `apps/server/scripts/build-css.mjs` (which built, hashed and registered them) is deleted with them, and a new view needs no stylesheet — its presentation comes from the shared components, their variants and utility classes. The two properties the old requirement protected are re-stated by its replacement: tokens declared in exactly one place, and no `<style>` element in the response body.

### Requirement: No frontend build pipeline SHALL be required

**Reason**: the redesign reverses this requirement's premise. The dashboard is now a React application built by its framework: first-party source is bundled and transpiled, more than one served JavaScript file exists, and a client-side component system is the point. The requirement cannot be satisfied by any implementation that also satisfies the liquid-glass identity, the shadcn stack and the React port, so leaving it in place would make the capability self-contradictory.

**Migration**: the guarantees it actually carried are preserved by other requirements, one for one. "No install step beyond `pnpm install`" → the workspace's existing `pnpm install` plus the Turborepo task graph (the dashboard needs no additional toolchain). "Assets and libraries are present in the distributed package, and a missing one fails the build" → the served-asset-origin requirement plus the production-image build, which fails on a missing traced file. "A CSS minifier is allowed and required" → the minified-and-content-hashed requirement, whose outcome is unchanged. "One served third-party file, version-pinned" → retired outright: the HTMX bundle is deleted and no replacement third-party script is served. "First-party client JS is inline and under 2 KB per script" → retired; first-party client code is now component code compiled into the bundle, and the six inline scripts it described are deleted rather than inlined. "No client-side framework, router or component system" → retired by the shadcn/ui requirement, which specifies exactly which one is adopted. Development requires `next dev` (through the Turborepo task graph) instead of serving TypeScript directly.

### Requirement: Dashboard HTML MUST be whitespace-minified in production

**Reason**: the minifier and its carve-outs are deleted with the template-literal renderer that needed them. React emits a text node per JSX expression and no inter-tag indentation, so there is no server-rendered whitespace left to collapse. A minifier applied to React's output would be machinery kept alive for a property it would no longer change.

**Migration**: none is required for the operator — the observable property holds structurally rather than by transformation. The requirement's one protected case is preserved by construction: text inside preformatted content (a memory body, a raw session summary, a judgment's evidence JSON) is a React text child and SHALL NOT be reformatted. The port's render tests assert the property on a rendered page, so a regression that reintroduces inter-tag whitespace is caught by a test rather than by the deleted transform.

### Requirement: The one-click update action MUST require a danger-tone confirmation

**Reason**: the in-application update action it guards no longer exists. The self-upgrade orchestrator leaves the served application (see "The served dashboard application SHALL NOT host a scheduler or a self-upgrade orchestrator"): a process that replaces its own container while serving is the fragile path, and both supported distributions already own the swap at the deployment layer. A confirmation dialog in front of an action that no surface can trigger has nothing to protect.

**Migration**: operators upgrade by their deployment layer — `docker compose pull && docker compose up -d` (or the TUI installer's upgrade path for non-Docker installs) — with `docs/updates.md` as the documented route. The update modal renders that command with a copy control and the docs link, and the pinned-tag state renders the explanation and how to unpin. Data protection is unchanged: the pre-upgrade backup the one-click flow performed is the operator's `VACUUM INTO` snapshot, which the maintenance view exposes as an on-demand action and the deployment docs describe.

### Requirement: The dashboard MUST show update progress and reload itself on the new version

**Reason**: this requirement describes the in-application upgrade orchestration — a progress view fed by a status endpoint, restart-window error suppression, and a version poll that reloads the page. All three live in the process being replaced, which is exactly what this change removes from the served application. Keeping the requirement would mandate an endpoint and a view for a flow that no longer exists.

**Migration**: the operator watches the deployment layer instead of the dashboard: the image pull (or the installer's upgrade step) reports progress where it runs, and the dashboard's own version line is the confirmation that the new version is live. The version badge, the availability check, the changelog modal and the manual check all remain, so an operator still learns that a newer version exists and what it contains without leaving the dashboard.
