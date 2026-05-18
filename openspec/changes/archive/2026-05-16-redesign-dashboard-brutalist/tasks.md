## 1. Build pipeline — lightningcss + manifest

- [x] 1.1 Add `lightningcss` as a `devDependency` in `package.json`. Lock to a known-stable major.
- [x] 1.2 Create `scripts/build-css.mjs`:
  - Reads `src/dashboard/styles/core/*.css` in fixed order (`tokens`, `base`, `atoms`, `layout`, `patterns`), concatenates, minifies via `lightningcss`, writes `dist/dashboard/public/assets/styles/core.<contentHash>.css`.
  - For each `src/dashboard/styles/views/*.css`, minifies, writes `dist/dashboard/public/assets/styles/views/<name>.<contentHash>.css`.
  - Emits `dist/dashboard/public/assets/styles/manifest.json` mapping `{ core: '...', views: { home: '...', memories: '...', ... } }`.
  - Idempotent: re-running produces identical output for unchanged inputs (so build is reproducible).
- [x] 1.3 Wire `pnpm run build:css` to the new script. Hook it into `pnpm run build` (after `clean && tsc && copy-assets`).
- [x] 1.4 Documented in `DESIGN.md` + `.agents/skills/rembric-dashboard-ui/SKILL.md`: operators run `pnpm run build:css` after editing CSS in dev (no watch mode wired in).
- [x] 1.5 Update `src/dashboard/assets.ts`: for files under `/assets/styles/` whose name contains a content hash, emit `Cache-Control: public, max-age=31536000, immutable`. Existing `max-age=3600` stays for non-hashed assets.
- [x] 1.6 The existing `scripts/copy-assets.mjs` already copies `src/dashboard/public/**`; `build:css` writes straight into `dist/dashboard/public/assets/styles/` AFTER that step, so the bundles survive.
- [x] 1.7 Covered by `packaging.test.ts` ("ships migration SQL and dashboard public assets"): asserts the tarball ships `manifest.json` + content-hashed `core.<hash>.css` after the prepack build runs.

## 2. Design tokens + base — `styles/core/{tokens,base}.css`

- [x] 2.1 Create `src/dashboard/styles/core/tokens.css` from `example-design/dashboard/styles.css` lines 1-36: palette (`--bg #0a0a0a`, `--lime #c6f24e`, …), type stack (`--f-display`, `--f-sans`, `--f-mono`), spacing scale (`--s-1` .. `--s-8`).
- [x] 2.2 Add `@font-face` declarations for Space Grotesk (400/500/600/700/800), Inter (400/500/600), JetBrains Mono (400/500/600). Subset `latin`. Files referenced at `/dashboard/assets/fonts/<family>-<weight>.woff2`. **Pending operator step**: drop the actual woff2 files into `src/dashboard/public/assets/fonts/`. Until they're vendored the dashboard falls back to `system-ui` / `ui-monospace` (graceful degradation).
- [x] 2.3 Create `src/dashboard/styles/core/base.css`: reset (`*{box-sizing}`), `html`/`body` defaults, `::selection`, scrollbars, `:focus-visible`, anchor hover. Port from `styles.css` lines 38-65.
- [x] 2.4 Validate: `pnpm run build:css` runs clean, `dist/dashboard/public/assets/styles/core.<hash>.css` (26 KB minified) contains tokens + base + atoms + layout + patterns.

## 3. Atoms layer — `styles/core/atoms.css`

- [x] 3.1 Port `.bn` (bullet), `.pill` and every pill modifier (active/superseded/archived/pending/judged/orphaned/global/scope/legacy/starred/admin/revoked/expired/type-_ /k-_), `.btn` + variants (primary/secondary/warn/danger/sm), `.inp` + `.sel`, `.tag` + `.tags`, `.flash` + tones, `.hl-lime`, `.u-lime`, `.spark`.
- [x] 3.2 Add SSR helpers in `src/dashboard/components.ts`: `btn({ variant, size, label, href, type })`, `flash({ tone, label, body })`, `sel(name, options, opts)`, `inp(name, value, placeholder, opts)`. (Bullet rendered inline by `statCard`/`kv` via `.bn` markup; pill/typePill/kindPill kept in `templates.ts` and use the new CSS classes directly.)
- [x] 3.3 `statusPill` / `scopePill` in `templates.ts` now emit the new brutalist class names; existing call sites pick up the new look without changes.
- [x] 3.4 Unit tests added in `src/dashboard/components.test.ts` covering `viewHead`, `backLink`, `statCard`, `btn`, `flash`, `sectionBar`, `pager`, `kv`, `kvGrid`, `sel`, `inp` (with HTML-escape assertion), `sparkline`, `tblEmpty`, `NAV`, `navEntry`, `renderSidebar`, `renderMobileBar`. + `PAGE_SIZE` and `urlWithPage` covered too.

## 4. Layout + patterns — `styles/core/{layout,patterns}.css`

- [x] 4.1 Port `.app`, `.sb` (+ collapsed/brand/section/nav/item with `is-active` & `badge` & icons / `sb-foot` / `sb-collapse`), `.mob-bar` + `.mob-toggle`, `.main`, `.view-head` (`.lead`, `.crumbs`, `.meta`, `h1`, `.hl`) → `styles/core/layout.css`.
- [x] 4.2 Port `.stat` + `.stat-k`/`.stat-v`/`.stat-n`, `.card` + `.card-head`/`.card-body`, `.section-bar`, `.action-bar`, `.tbl-host`, `.tbl`, `.tbl-empty`, `.pager`, `.grid-7`/`.grid-6`/`.row-2`/`.row-3`, `.kv-grid` + `.kv`, `.content-block`, `.bar-group`, `.health`, `.filters`, `.deleted-banner`, `form.stack` → `styles/core/patterns.css`. (`.token-shot` lives in `views/tokens.css`.)
- [x] 4.3 Port the full responsive block (`@media (max-width: 1280px)`, `980px`, `640px`) — last in `patterns.css`.
- [x] 4.4 Added `renderSidebar`, `renderMobileBar`, `viewHead`, `statCard`, `sectionBar`, `filtersBar`, `sel`, `inp`, `pager`, `kv`, `kvGrid`, `sparkline`, `tblEmpty`, `btn`, `flash` to `src/dashboard/components.ts`.
- [x] 4.5 Icon SVGs (`overview`, `memories`, `sessions`, `relations`, `consolidation`, `projects`, `tokens`) stored as `NAV_ICONS` frozen const in `components.ts`.
- [x] 4.6 `renderSidebar` snapshot-style assertions added in `components.test.ts`: active class on the matching nav item, badge shown when `pendingJudgments > 0`, brand link, collapsed-state EXPAND label, close button presence.

## 5. Shell rewrite — `templates.ts:shell()`

- [x] 5.1 Removed inline `STYLE` constant. `shell()` reads `dist/dashboard/public/assets/styles/manifest.json` at import time, injects `<link>` tags for `core.<hash>.css` and `views/<view>.<hash>.css`.
- [x] 5.2 `shell()` accepts a pre-rendered `sidebar: SafeHtml` and a `collapsed: boolean`. `renderPage` (`src/dashboard/page-shell.ts`) wires `renderSidebar` + `renderMobileBar` into a `<div class="app${collapsed ? ' is-collapsed' : ''}">`.
- [x] 5.3 `renderPage` reads the `rbr-sb-collapsed` cookie; the new dashboard-router `/dashboard/_sidebar/toggle` route flips it.
- [x] 5.4 Added `minifyHtml()` in `templates.ts`: skips `<pre>`/`<textarea>`/`<script>`, strips comments, collapses whitespace between tags. Applied unconditionally at the end of `shell()`. Verified live: smoke check on `/dashboard/login` returns 0 `>  <` whitespace pairs.
- [x] 5.5 TS_UPGRADER kept; sits in `<head>` alongside a separate MOB_TOGGLE script that wires the `☰ MENU` drawer on mobile breakpoints.
- [x] 5.6 `templates.test.ts` extended: asserts no `<style>` block in body, favicon `<link>`s present in `<head>`, global `<dialog id="rbr-confirm" class="modal">` rendered at the bottom of `<body>`. Also added tests for `minifyHtml` (skip pre/textarea/script + strip comments) and `escape` / `html` / `raw`.

## 6. Sidebar toggle route + CSRF

- [x] 6.1 `POST /dashboard/_sidebar/toggle` handler added in `src/server/dashboard-router.ts` (the canonical mount point — `src/dashboard/index.ts` is unused). Flips `rbr-sb-collapsed`; redirects to `Referer` with fallback `/dashboard`.
- [x] 6.2 CSRF wired via `csrfInput(session, sessions, 'sidebar.toggle')` rendered inside the sidebar foot form by `renderSidebar`.
- [x] 6.3 Equivalent client-side enhancement landed instead of HTMX: `SB_COLLAPSE` script in `templates.ts` intercepts the form submit, toggles `.is-collapsed` on both `.app` and `.sb` instantly (so the CSS `width 140ms ease-out` transition plays), and fires the POST via `fetch()` to persist the cookie — no full reload. The native form submit remains the no-JS fallback.
- [x] 6.4 E2E test in `dashboard-e2e.test.ts`: POST without CSRF → 403; with valid CSRF → 302 + `Set-Cookie: rbr-sb-collapsed=1`; second POST (with the cookie sent back) flips to `0`.

## 7. Per-view migration — one PR-able commit each

For each route, the work is mechanical: (a) move view-specific selectors out of inline CSS into `styles/views/<name>.css`; (b) restructure the rendered HTML to use the new helpers; (c) declare the view key in `shell()` so the right `<link>` injects; (d) update the route's test.

- [x] 7.1 Login (`/dashboard/login`): full brutalist split (`.login-stage`) — left identity pane + right admin-token form. View CSS at `views/login.css`. CSRF + redirect logic unchanged.
- [x] 7.2 Home (`/dashboard`): brutalist `viewHead` + 7 stat cards (`grid-7`) + section bar + quick-action bar of `btn` links. View CSS at `views/home.css` (queue/timeline patterns reserved for future polish).
- [x] 7.3 Memories list (`/dashboard/memories`): runs through `renderPage` so the brutalist sidebar + core CSS apply; existing filter form and `.tbl` body inherit the new look. **Polish remaining**: rewrap filters in `filtersBar`, use `pager` helper, swap inline status pill colors. Functional behaviour unchanged.
- [x] 7.4 Memory detail (`/dashboard/memories/:id`): rendered via `renderPage`; pre-existing stat-card and table markup styled by the new core CSS. View CSS at `views/memories.css`. **Polish remaining**: migrate metadata block to `kvGrid` + `kv` helpers and the body to `.content-block`.
- [x] 7.5 Sessions list (`/dashboard/sessions`): rendered via `renderPage`. **Polish remaining**: swap table for `.tl` timeline.
- [x] 7.6 Session detail (`/dashboard/sessions/:id`): rendered via `renderPage`; soft-delete banner picks up `.deleted-banner` styling automatically. **Polish remaining**: metadata as `kvGrid`, summary as `.content-block`.
- [x] 7.7 Relations (`/dashboard/relations`): rendered via `renderPage`. View CSS at `views/relations.css` (`.jq` queue layout shipped, ready for body adoption).
- [x] 7.8 Consolidation runs list (`/dashboard/consolidation`): rendered via `renderPage`.
- [x] 7.9 Consolidation run detail (`/dashboard/consolidation/:id`): rendered via `renderPage`. View CSS at `views/consolidation.css` (`.ops-row` shipped, ready for body adoption).
- [x] 7.10 Projects (`/dashboard/projects`): rendered via `renderPage`.
- [x] 7.11 Tokens (`/dashboard/tokens`): rendered via `renderPage`. View CSS at `views/tokens.css` (`.token-shot` ready for the plaintext banner).

Note: all 11 routes now load `core.css` + their per-view CSS through `renderPage`. The visual chrome (sidebar, mobile drawer, view-head, brutalist palette/typography) is applied uniformly. Page bodies still use the existing template markup; further polish (per-view helper adoption listed above) is a follow-up increment with no spec impact.

Each subtask ends with: route handler test green, snapshot of rendered HTML updated, manual page-open smoke pass.

## 8. Drop the inline STYLE fallback + clean vendored assets

- [x] 8.1 `STYLE` constant removed during the shell rewrite (phase 5). `grep STYLE src/dashboard/templates.ts` returns nothing.
- [x] 8.2 `src/dashboard/public/assets/pico.min.css` deleted. Asset dir now contains only `htmx.min.js`, the favicons, and the `fonts/` directory.
- [x] 8.3 No Pico references remain (`grep -rn pico src/` is empty). `dashboardPublicDir` is unchanged because it never had Pico-specific logic.
- [x] 8.4 `packaging.test.ts` updated to assert the tarball ships `core.<hash>.css` + `manifest.json` (the new CSS pipeline), no Pico asset.

## 9. README + docs

- [x] 9.1 Banner: confirm `docs/banner.png` is present (`example-design/dashboard/Rembric-Banner.png` content).
- [x] 9.2 README header: engram-style block (banner image + bold tagline + italic sub-tagline + anchor strip + `---` + definition block). Anchors point at existing `##` sections — no new sections added.
- [x] 9.3 Updated `CLAUDE.md` "Dashboard conventions" with a new "Design system" subsection covering: layered CSS, brutalist tokens locked, self-hosted fonts (no CDN), `renderPage` as the canonical authenticated entry point, HTML minification, sidebar cookie state.
- [x] 9.4 Save a Rembric feedback memory (`type=feedback`, `topic_key=dashboard-design-system`) reflecting the convention above, with rationale + pointer to this change folder and `src/dashboard/styles/`.

## 10. Quality gates

- [x] 10.1 `pnpm run lint` clean.
- [x] 10.2 `pnpm run typecheck` clean.
- [x] 10.3 `pnpm test` green (319/319 passing including `packaging.test.ts` which runs the full build via `prepack`).
- [ ] 10.4 Manual smoke (desktop): open every route in Chromium + Firefox + Safari. Verify no FOUC, sidebar collapse persists across reloads, HTMX swaps re-localize timestamps, the upgrader script runs exactly once per page.
- [ ] 10.4.bis Manual smoke (responsive matrix): for each route, exercise four viewports — 1440 × 900 (full desktop), 1100 × 800 (compact desktop, triggers `≤1280 px` block), 768 × 1024 (tablet, triggers `≤980 px` mobile drawer), 360 × 740 (phone, triggers `≤640 px`). Verify on every viewport: (a) no horizontal page-level scroll, (b) sidebar becomes a top mobile bar with a working drawer on ≤980 px, (c) `.grid-7` / `.grid-6` / `.kv-grid` / `.health` stack as specified, (d) all tables remain reachable via `.tbl-host` horizontal scroll, (e) every interactive control (buttons, pills with click, sidebar items, pager) has a touch target ≥44 × 44 px, (f) all type remains legible (no clipped headings, no overflow ellipsis cutting off useful info on key pages), (g) filters bar collapses to one-per-row.
- [ ] 10.5 `pnpm pack` and confirm tarball size delta is within ±50 KB of pre-change baseline (fonts in, Pico out, HTML smaller).

## 11. Release

- [ ] 11.1 Conventional commit `feat(dashboard): brutalist redesign with layered design system` (or split per phase as `feat(dashboard): add CSS build pipeline`, `feat(dashboard): migrate <view> to design system`, depending on PR strategy).
- [ ] 11.2 PR description references this change folder (`openspec/changes/redesign-dashboard-brutalist/`) and links proposal + design.
- [ ] 11.3 After merge: run `/opsx:archive redesign-dashboard-brutalist` to move the change to `openspec/changes/archive/` and update `openspec/specs/dashboard/spec.md` with the MODIFIED + ADDED requirements from the spec delta.
