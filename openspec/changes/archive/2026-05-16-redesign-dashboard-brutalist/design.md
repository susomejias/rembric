## Context

The current dashboard ships one inline `<style>${STYLE}</style>` block (~100 lines, ~6 KB unminified) on every page render. The visual identity is Pico-flavoured auto dark/light, the nav is a flat top strip, and there is no separation between tokens, atoms, layout, and per-view styles. A React-based brutalist redesign already exists as a working prototype in `example-design/dashboard/`; this change ports that visual system into the SSR + HTMX stack the dashboard is built on.

Constraints that drove the design:

- **No client-side JS framework.** Existing dashboard spec ("No frontend build pipeline SHALL be required") explicitly bans React/Vue/Svelte, transpilers, and JS bundlers. HTMX + Pico were the original intent; HTMX stays.
- **No CDN dependency at runtime.** Existing spec ships assets bundled inside the npm package. Google Fonts is therefore out — fonts must be self-hosted.
- **One process, one SQLite file.** The build is `tsc -p tsconfig.build.json + copy assets`. Anything we add must integrate without standing up a second toolchain.
- **Existing observable surfaces (timestamps via `formatTs`, CSRF, auth, every route's logic) must continue to work unchanged.** This change is a re-skin, not a re-route.

## Goals / Non-Goals

**Goals:**

- Replace inline CSS with a layered, source-controlled design system (tokens → base → atoms → layout → patterns → views) that future contributors can extend without grepping a 100-line string constant.
- Each dashboard page loads exactly two CSS files: the shared `core.css` (cached across navigations) and its own `views/<name>.css`. The HTML body no longer carries a `<style>` block.
- All CSS is minified at build time. HTML is whitespace-collapsed before responding. The shipped artefact is smaller than today's per-response inline CSS.
- The brutalist visual identity (palette, type, spacing, sidebar chrome) is locked in spec — future templates can't drift to "blueish links and rounded buttons" without an OpenSpec change.
- The sidebar collapse state survives reloads via cookie so SSR renders the right width on first paint — no JS-driven flash.

**Non-Goals:**

- No new functional features, routes, or data exposure. The redesign is chrome-only.
- No SPA navigation. HTMX boost is acceptable for in-page partial swaps (already used by memories filter); full-route transitions stay as classic links.
- No theming switcher (no light mode). Brutalist dark-only by design — matches the project's stated positioning.
- No per-tenant customization. Single-operator self-hosted product; the dashboard looks the same for everyone.
- No CSS-in-JS, no `@apply`, no Tailwind. Plain CSS + custom properties + lightningcss minification.

## Decisions

### Decision 1: Layered CSS source tree → bundled per-page outputs

```
src/dashboard/styles/
├─ core/
│   ├─ tokens.css     # --bg, --lime, --f-display, --s-1..--s-8, ...
│   ├─ base.css       # reset, body, scrollbars, focus-visible, ::selection
│   ├─ atoms.css      # .pill, .btn, .bn (bullet), .inp, .sel, .flash, .tag, .pager, .hl-lime, .u-lime
│   ├─ layout.css     # .app, .sb (sidebar), .sb-collapse, .mob-bar, .main, .view-head
│   └─ patterns.css   # .stat, .grid-7, .grid-6, .tbl + .tbl-host, .filters, .card, .section-bar, .kv-grid, .content-block, .tl, .health
└─ views/
    ├─ home.css            # .tl-item dashboard variant, .jq snippets, .spark
    ├─ memories.css        # .content-block (memory detail), .replaces chain
    ├─ sessions.css        # session-specific extensions of .tl
    ├─ relations.css       # .jq full table (judgment queue)
    ├─ consolidation.css   # .ops-row
    ├─ projects.css        # project-rename inline form
    ├─ tokens.css          # .token-shot one-shot banner
    └─ login.css           # .login-stage (only login page)
```

Why this split: tokens/base/atoms/layout/patterns are used by every dashboard route — they belong in `core.css`. View-specific patterns (`.token-shot`, `.login-stage`, `.ops-row`, etc.) only fire on one route — shipping them on every page would be ~30-40% dead CSS per page. The split is mechanical, derivable from the reference prototype, and keeps the per-view CSS file small (~1-2 KB minified each).

### Decision 2: lightningcss as the build tool

Picked over esbuild and cssnano:

| Tool            | Verdict | Why                                                                                                                   |
| --------------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| lightningcss    | ✅      | Rust speed, single dep, minify + autoprefix + content-hash + dead-code in one pass. Standalone Node API. Mature.      |
| esbuild         | ❌      | CSS minify is fine but lacks autoprefix; we'd still need a separate prefixer. Two-tool problem when one tool does it. |
| cssnano/postcss | ❌      | Mature but a postcss pipeline drags in a plugin chain, slower at build time, more deps for the same outcome.          |

Build invocation lives in a small Node script (`scripts/build-css.mjs`), wired into `pnpm run build` after `clean` and before `tsc -p tsconfig.build.json`. The script:

1. Reads `src/dashboard/styles/core/*.css`, concatenates in fixed order (tokens → base → atoms → layout → patterns), minifies via `lightningcss`, writes `dist/dashboard/public/assets/styles/core.<hash>.css`.
2. For each `src/dashboard/styles/views/*.css`, minifies via `lightningcss`, writes `dist/dashboard/public/assets/styles/views/<name>.<hash>.css`.
3. Emits `dist/dashboard/public/assets/styles/manifest.json` like:
   ```json
   {
     "core": "core.a3f1e2.css",
     "views": { "home": "views/home.b7d4.css", "memories": "views/memories.c218.css", ... }
   }
   ```
4. The same script is invoked in dev (`pnpm run dev`) by a tsc watch sibling — or, simpler, by running `build:css` on save (no SSR hot reload anyway; operator refreshes the page).

`templates.ts:shell()` reads `manifest.json` once at process start, caches it, and injects:

```html
<link rel="stylesheet" href="/dashboard/assets/styles/core.a3f1e2.css" />
<link rel="stylesheet" href="/dashboard/assets/styles/views/home.b7d4.css" />
```

Content-hashed names + `Cache-Control: public, max-age=31536000, immutable` for assets (existing assets middleware already caches at `max-age=3600`; this change tightens it for hashed files).

### Decision 3: HTML minification = whitespace-collapse, hand-rolled

A 30-line helper in `templates.ts`:

```ts
function minifyHtml(s: string): string {
  // Skip ranges inside <pre>, <textarea>, <script> tags.
  // Collapse runs of whitespace between '>' and '<' to ''.
  // Strip HTML comments outside skip-ranges.
}
```

Why not `html-minifier-terser`: heavyweight dep, slower, attempts aggressive transforms (attribute-quote stripping, optional-tag removal) that introduce real risk for SSR pages that include user content (memory bodies, project names). Whitespace-collapse alone removes ~20-30% of bytes from typical dashboard responses with zero behavioural risk. Applied inside `shell()` after the body string is built.

Performance: <1 ms per page at the dashboard's size, negligible.

### Decision 4: Sidebar collapse persisted via cookie

```
Cookie: rbr-sb-collapsed=1; Path=/dashboard; SameSite=Lax; Max-Age=31536000
```

Server reads it in `shell()`, adds `class="app is-collapsed"` to the root `<div>` accordingly. Toggle is a small button that POSTs to `/dashboard/_sidebar/toggle` (CSRF-protected like every other mutation), flips the cookie, redirects back. HTMX-enhanced: the button can also send `hx-post="/dashboard/_sidebar/toggle"` + `hx-swap="outerHTML"` on the `.sb` element for no-reload toggling. Both paths set the same cookie.

Why cookie over localStorage:

| Storage       | First-paint render correct? | Works no-JS? | Sync across tabs?  |
| ------------- | --------------------------- | ------------ | ------------------ |
| Cookie (this) | ✅                          | ✅           | ✅                 |
| localStorage  | ❌ (FOUC)                   | ❌           | ❌ (different DBs) |

The reference React prototype uses localStorage; we don't because we don't have a hydration step to hide the FOUC.

### Decision 5: Self-hosted fonts (woff2) under `assets/fonts/`

Google Fonts is a CDN dependency and violates the existing "no CDN at runtime" spec. We vendor:

- Space Grotesk: weights 400, 500, 600, 700, 800 (display)
- Inter: weights 400, 500, 600 (body)
- JetBrains Mono: weights 400, 500, 600 (mono/labels)

Each as one woff2 file, with subset `latin` only (covers everything the dashboard text needs — no CJK, no extended math). Estimated total payload: ~50-70 KB across all three families. Cached with `max-age=31536000, immutable`.

`@font-face` declarations live in `core/tokens.css` (the only file that knows the font URLs). One copy, applied everywhere.

### Decision 6: React → SSR template helpers

Each React atom in the reference becomes a function in a new `src/dashboard/components.ts`:

| React component        | SSR helper signature                                         |
| ---------------------- | ------------------------------------------------------------ |
| `<Sidebar/>`           | `renderSidebar({ active, counters, collapsed }) → SafeHtml`  |
| `<MobileBar/>`         | `renderMobileBar({ sectionLabel }) → SafeHtml`               |
| `<ViewHead/>`          | `viewHead({ num, title, hl, meta }) → SafeHtml`              |
| `<StatCard/>`          | `statCard({ k, v, tone, sub, href }) → SafeHtml`             |
| `<Pill/>`, `<Bullet/>` | already in `templates.ts`, expanded to support new kinds     |
| `<Btn/>`               | `btn({ variant, size, label, href, formAction }) → SafeHtml` |
| `<Flash/>`             | `flash({ tone, label, body }) → SafeHtml`                    |
| `<Filters/>`+`<Sel/>`  | `filtersBar(...) → SafeHtml`, `sel(...) → SafeHtml`          |
| `<Pager/>`             | already in `templates.ts`, restyled to brutalist             |
| `<Kv/>`+`<KvGrid/>`    | `kv(...) → SafeHtml`, `kvGrid(...) → SafeHtml`               |
| `<SectionBar/>`        | `sectionBar({ name, meta, more }) → SafeHtml`                |
| Sparkline              | `sparkline(data: number[]) → SafeHtml` (inline SVG)          |

All return `SafeHtml` (the existing escape-aware marker) so they compose with `html\`…\`` template literals naturally.

Counter resolution (the sidebar's "pending judgments" badge): `shell()` accepts a `counters` field; the home route computes counters; other routes either compute or accept "unknown" (badge hidden). One DB query in the shell is acceptable for the dashboard's traffic level.

### Decision 7: Numbered sections (§ 01..§ 07) as visual chrome, not routing

The reference uses `§ 01 OVERVIEW`, `§ 02 MEMORIES`, etc. as a brutalist editorial flourish. We adopt the visual but keep URLs unchanged (`/dashboard`, `/dashboard/memories`, …). The section number is computed from the active-nav key and is purely presentational. Adding a new top-level nav item adds a new number; renaming or reordering changes the numbering deterministically.

### Decision 8: Login redesign in scope

The reference includes a full-screen split login (`<div class="login-stage">`). We adopt it. Current login is a tiny form; the new one preserves all functionality (admin token field, CSRF, error display) but with the brutalist treatment. Same route (`/dashboard/login`), same POST handler, only the rendered HTML changes.

### Decision 9: README adopts engram-style header

Aligns the project's marketing surface with the brutalist identity now landing in the dashboard. Pattern:

```
<banner image>
<bold tagline>
<italic sub-tagline>
<anchor strip: Section · Section · ...>
---
> definition block
```

Anchor strip points at existing `##` headings — no new doc sections added. The H1 "Rembric" disappears (the banner is the brand mark); GitHub still renders the page title from the repo name.

## Risks / Trade-offs

- **[Risk]** Every dashboard route is touched. → **Mitigation**: route handler logic stays untouched (only the HTML they emit changes). A per-page rendering test asserts the new `<link>` tags and shell structure; existing functional tests (auth, CSRF, filtering, undo) continue to cover behaviour.
- **[Risk]** Self-hosting three font families adds ~50-70 KB of static assets to the npm package. → **Mitigation**: woff2 with `latin` subset is compact and cached forever. The current package already ships HTMX + Pico — net delta is modest. Operators concerned about size can `unfont` post-install (the assets are static files).
- **[Risk]** lightningcss is a Rust binary distributed via prebuilt platform-specific packages. Some CI environments (e.g. minimal Alpine) may need the musl variant. → **Mitigation**: lightningcss ships prebuilt for darwin-x64, darwin-arm64, linux-x64, linux-x64-musl, linux-arm64, win32-x64. Covers every CI surface this project uses. Document in CONTRIBUTING if installs fail.
- **[Risk]** Cookie-based sidebar state adds one cookie to every dashboard request. → **Mitigation**: ~30 bytes, scoped to `/dashboard`, not sent to `/mcp`. Negligible.
- **[Trade-off]** Whitespace-collapse minification makes "view source" less readable. → **Accepted**: the dashboard is for operators using DevTools (which pretty-prints), not for view-source inspection. We can keep a `?pretty=1` query escape hatch if a future need emerges — not in scope now.
- **[Trade-off]** Brutalist dark-only excludes operators who explicitly prefer light themes or have high-contrast needs. → **Accepted**: single operator, single self-hosted product; users who want a different palette can override CSS variables via a local stylesheet (an `assets/local.css` extension hook could be added later if needed — not now).
- **[Trade-off]** The change is large and lands as one PR. → **Accepted but mitigated**: tasks.md breaks the work into 9 numbered phases. Phases 1-3 (build pipeline + tokens + atoms) land first in a working state; phases 4-8 migrate routes one at a time. Each phase ends with `pnpm test` green. Worst case the migration can be split into two PRs at any phase boundary.

## Migration Plan

1. **Add the CSS pipeline first.** New `src/dashboard/styles/` tree + `scripts/build-css.mjs` + `lightningcss` devDep + `manifest.json` emission. `shell()` learns to read the manifest but keeps the old inline `<style>` as a fallback when the manifest is absent. Tests pass with no visible change.
2. **Migrate core (tokens/base/atoms/layout/patterns).** Convert the inline `STYLE` constant into `core/*.css` files. `shell()` swaps the inline `<style>` for the manifest-driven `<link>`. Pages still look the same (or nearly — small palette and font shifts).
3. **Migrate views one at a time.** Home → memories → memory detail → sessions → session detail → relations → consolidation → consolidation run → projects → tokens → login. Each migration is a single PR-able commit: extract view-specific CSS into `views/<name>.css`, restructure the HTML to use the new helpers, snapshot/regenerate the rendering test.
4. **Drop the inline `STYLE` fallback** once every view has migrated.
5. **Apply HTML minifier** in `shell()` last (after every view migration, so any layout glitch from the migrator surfaces clearly).
6. **Move banner and rewrite README** at any point — independent of the dashboard work.

Rollback at any phase: revert that phase's commits. Phases 1-2 have no behavioural impact; later phases are visual.

## Open Questions

- **Should the manifest be loaded lazily per-process or pre-warmed at import?** → Pre-warmed at module load. The file is small (<1 KB) and never changes during a process lifetime. A missing manifest is a build-time bug, surfaced loudly at server start.
- **Should we keep the `/dashboard/assets/htmx.min.js` and Pico CSS files in place after this change?** → HTMX yes (still used for partial swaps). Pico no — removed once `core.css` covers everything Pico was doing. Reduces vendored asset size by ~10 KB.
- **Does the engram-style README work if a contributor opens the file outside GitHub (e.g. `cat README.md` in a terminal)?** → The HTML `<p align="center">` blocks render as plain text, slightly noisier than the current markdown. Trade-off accepted: GitHub is the primary surface and the banner is the marketing payoff.
- **Should the brutalist palette tokens be exposed for plugin docs / external use?** → No, out of scope. The plugin docs (`plugin/README.md`) can adopt the same banner if we ever want consistency, but the design tokens stay in the dashboard's own CSS.
