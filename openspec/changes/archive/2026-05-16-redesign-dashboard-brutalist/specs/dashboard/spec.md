## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: Dashboard CSS MUST be organised as a layered design system

The dashboard styles SHALL live under `src/dashboard/styles/` and SHALL be split across exactly two layers of source files:

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
- **THEN** they SHALL add a new file `src/dashboard/styles/views/<view>.css`, register the view key in the build script's view list, and reference the view key from the route's `shell()` call — and a `pnpm run build` SHALL emit and serve the new file with no further configuration

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

- **WHEN** a contributor inspects `src/dashboard/styles/core/tokens.css`
- **THEN** the file SHALL contain all design tokens listed above, declared inside a single `:root { ... }` block

### Requirement: Dashboard fonts MUST be self-hosted

The dashboard SHALL serve Space Grotesk (weights 400, 500, 600, 700, 800), Inter (weights 400, 500, 600), and JetBrains Mono (weights 400, 500, 600) as woff2 files from `/dashboard/assets/fonts/`. The dashboard SHALL NOT reference Google Fonts or any other font CDN at runtime. Font files SHALL be served with `Cache-Control: public, max-age=31536000, immutable`.

#### Scenario: No external font requests

- **WHEN** a browser loads any dashboard page
- **THEN** the page SHALL NOT trigger an HTTP request to `fonts.googleapis.com`, `fonts.gstatic.com`, or any host other than the Rembric server

#### Scenario: Every font weight is reachable

- **WHEN** a request hits `/dashboard/assets/fonts/space-grotesk-700.woff2`
- **THEN** the response SHALL be a valid woff2 file with `Content-Type: font/woff2`

### Requirement: Dashboard navigation MUST use a sidebar with persisted collapse state

The dashboard SHALL render its primary navigation as a left-hand vertical sidebar listing the routes Overview, Memories, Sessions, Judgments, Consolidation, Projects, Tokens. The sidebar SHALL support a collapsed mode (icons only, narrower fixed width) on desktop viewports and SHALL expose a toggle button to switch states.

The collapse state SHALL be persisted in an HTTP cookie named `rbr-sb-collapsed` (value `1` collapsed, `0` or absent expanded), scoped to `Path=/dashboard`, with `SameSite=Lax`. The server SHALL read this cookie when rendering any dashboard page and SHALL set the root container's class accordingly so the SSR HTML matches the persisted state on first paint.

The toggle SHALL work without JavaScript via a `POST /dashboard/_sidebar/toggle` form submission protected by the existing CSRF mechanism; the same endpoint MAY be HTMX-enhanced for no-reload toggling when `HX-Request: true` is present.

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
- **≤640 px (phone)**: `.grid-7` and `.grid-6` show 2 columns; `.kv-grid` shows 2 columns; `.health` stacks to 1 column; `.login-stage` hides its left identity pane and shows the right-pane form full-width; `.view-head h1` reduces to ~1.7rem; table minimum width drops; `.stat-v` shrinks to ~2.4rem.

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

### Requirement: Dashboard MUST surface numbered editorial section labels

Each top-level dashboard route SHALL render a `viewHead` block containing a section number (`§ 01` through `§ NN`) computed deterministically from the route's position in the navigation order, alongside the section title and a meta strip. Section numbering is presentational and SHALL NOT appear in URLs or affect routing.

#### Scenario: Section number reflects nav order

- **WHEN** the operator opens `/dashboard/memories`
- **THEN** the page SHALL display `§ 02 / 07` (or the equivalent denominator if the nav order changes) in the view header
