## Why

The current dashboard is a single inline-CSS slab (`STYLE` in `src/dashboard/templates.ts`) that grew organically from the Pico-flavoured first cut: every page ships the same ~100 lines of CSS, the visual identity is generic dark/light auto, the navigation is a flat top strip, and there is no design system to grow into. Adding new views, atoms, or pages today means more inline CSS appended to one constant — there is no place for tokens, layered patterns, or per-view styles to live.

A full brutalist redesign already exists as a working React prototype in `example-design/dashboard/` (`Dashboard.html`, `styles.css`, `app.jsx`, `atoms.jsx`, `shell.jsx`, `views-*.jsx`). It pins:

- A dark + lime palette (`--bg #0a0a0a`, `--lime #c6f24e`) with editorial typography (Space Grotesk + Inter + JetBrains Mono).
- A collapsible sidebar navigation (drawer on mobile) with numbered sections (§ 01..§ 07).
- A reusable atoms layer (`pill`, `btn`, `bullet`, `stat`, `kv`, `filters`, `section-bar`, `flash`, `tag`) and patterns layer (`grid-7`, `tbl`, `pager`, `tl-item`, `jq-item`, `ops-row`, `kv-grid`, `health`, `card`).
- A responsive grid that degrades gracefully at 1280 / 980 / 640.

This change ports that visual system into Rembric's existing SSR + HTMX stack — no React, no client-side framework — and replaces the monolithic inline CSS with a layered, minified, per-page-loaded design system that pages opt into à la carte. It also stamps a permanent visual identity into the docs by surfacing the new banner in the README.

## What Changes

### Visual identity + design system

- Replace the inline `STYLE` constant in `src/dashboard/templates.ts` with a layered CSS tree under `src/dashboard/styles/`:
  - `styles/core/{tokens,base,atoms,layout,patterns}.css` → built into one `core.<hash>.css` (loaded by every page).
  - `styles/views/<view>.css` (one per route) → built into `views/<view>.<hash>.css` (loaded only by that page).
- Lock in the brutalist tokens (palette, type scale, spacing) and the navigation chrome (sidebar + mobile drawer + numbered sections).
- Self-host the three fonts (Space Grotesk, Inter, JetBrains Mono) as woff2 files under `src/dashboard/public/assets/fonts/` — no Google Fonts CDN at runtime (the existing "no CDN dependency" requirement stays intact).

### Build pipeline

- Add `lightningcss` as a build-only dependency. A new `pnpm run build:css` script reads `src/dashboard/styles/**/*.css`, emits minified, content-hashed bundles into `dist/dashboard/public/assets/styles/`, and writes a `manifest.json` that maps `'home' → 'views/home.a3f1.css'` for the shell to inject the right `<link>` per page.
- Hook `build:css` into `pnpm run build` between `clean` and `tsc -p tsconfig.build.json`.
- Add a small whitespace-collapse HTML minifier (~30 LOC) applied inside `shell()` before the response leaves the server. Safe by construction: skips `<pre>`, `<textarea>`, `<script>`.

### Component layer

- Introduce SSR template helpers that mirror the reference React atoms but emit plain HTML strings:
  `renderSidebar`, `viewHead`, `statCard`, `pill`, `btn`, `flash`, `kv`, `sectionBar`, `filtersBar`, `pager`, `tagList`, `sparkline` (inline SVG).
- Migrate every route under `src/dashboard/` (home, memories, memory detail, sessions, session detail, relations, consolidation, consolidation run, projects, tokens, login) to compose those helpers and to declare its view key so `shell()` can pick the right per-page CSS.

### Sidebar UX + responsive across the whole range

- Sidebar SHALL be collapsible on desktop and drawer-style on mobile. Collapse state SHALL persist via a `rbr-sb-collapsed` cookie so SSR renders the user's preferred state on first paint (no FOUC).
- The toggle SHALL work without JS (form POST that flips the cookie) and SHALL be enhanced by HTMX where present.
- Every dashboard route SHALL be fully usable from 320 px viewport width upwards. Breakpoints honoured: `≥1281 px` (full sidebar + multi-column grids), `≤1280 px` (compacted grids), `≤980 px` (sidebar collapses into a top mobile bar with drawer; multi-column grids stack to 2-3 cols; tables horizontally scroll inside `.tbl-host`), `≤640 px` (single-column everywhere; stat grids stack 2-wide; login becomes single pane; tables stay scrollable). Touch targets ≥44 × 44 px in mobile breakpoints. No horizontal page-level scroll at any width.

### README banner + engram-style header

- Move the brutalist banner (`example-design/dashboard/Rembric-Banner.png`) to `docs/banner.png`.
- Adopt the engram-style README header pattern (banner image + bold tagline + italic sub-tagline + dot-separated anchor links to in-page sections + horizontal rule + definition block). The current H1 + first paragraph are removed; navigation lives in the anchor strip instead.
- Anchor links: `Architecture · Quickstart · Claude Code · Codex CLI · Other Clients · CLI · Configuration · Contributing`. Each one links to an existing `##` section anchor — no new sections are added by this change.

### Out of scope

- No new dashboard features, routes, or data shown — only the chrome and the CSS pipeline.
- No changes to the MCP API, services, schema, or auth/CSRF logic.
- No client-side JS framework. HTMX stays as the only progressive-enhancement layer; the existing timestamp upgrader (`formatTs`) stays unchanged.

## Capabilities

### New Capabilities

<!-- None. -->

### Modified Capabilities

- `dashboard`: the existing "No frontend build pipeline" requirement is narrowed (CSS minification IS allowed and required); seven new requirements lock the design-system layering, per-page CSS, brand tokens, sidebar UX, font self-hosting, and HTML minification.

## Impact

- **Affected code**: `src/dashboard/templates.ts` (STYLE constant removed, `shell()` reworked to inject per-page CSS + run HTML minifier), all routes in `src/dashboard/*.ts` (compose new helpers, declare view key), new files under `src/dashboard/styles/`, new build script `scripts/build-css.mjs` (or inline in `package.json`), `package.json` (new `build:css` step, `lightningcss` devDep), `README.md` (banner), `docs/banner.png` (new file).
- **Unaffected**: SQLite schema, service layer, MCP tools, CLI, consolidation workers, plugin tree. The only thing the dashboard talks to is unchanged.
- **Risk**: medium. The change touches every dashboard page. Mitigated by (a) keeping the route-handler logic untouched (only the rendered HTML changes), (b) snapshot/structure tests on the rendered HTML per page, (c) a manual smoke pass across all routes (incl. the HTMX swap paths) before merge.
- **Bundle size delta**: today every page ships ~6 KB of unminified inline CSS in the HTML body; after this change the HTML is smaller (no inline `<style>`) and CSS becomes 2 cached `<link>` requests. Estimated steady-state: ~8 KB gzipped for `core.css` (loaded once, cached) + ~0.5–2 KB per view CSS. Net win after the first navigation.
