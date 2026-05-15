---
version: alpha
name: Rembric
description: >-
  Brutalist editorial design system for the Rembric self-hosted MCP memory
  dashboard. Dark + lime, monospace-forward, flat (no shadows, no radius),
  SSR-only (no client framework). Visual identity locked by spec; changing
  any token requires an OpenSpec change.

colors:
  primary: '#c6f24e'
  on-primary: '#0a0a0a'
  neutral: '#0a0a0a'
  surface: '#141414'
  surface-hover: '#15170d'
  on-surface: '#f2f2f2'
  on-surface-dim: '#9a9a9a'
  on-surface-faint: '#2a2a2a'
  warn: '#ff8c00'
  danger: '#ff3344'

typography:
  display:
    fontFamily: Space Grotesk
    fontSize: 3rem
    fontWeight: 700
    lineHeight: 0.95
    letterSpacing: -0.025em
  display-lg:
    fontFamily: Space Grotesk
    fontSize: 5rem
    fontWeight: 700
    lineHeight: 0.9
    letterSpacing: -0.035em
  h1:
    fontFamily: Space Grotesk
    fontSize: 2.4rem
    fontWeight: 700
    lineHeight: 1
    letterSpacing: -0.02em
  h2:
    fontFamily: JetBrains Mono
    fontSize: 0.78rem
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: 0.14em
  h3:
    fontFamily: JetBrains Mono
    fontSize: 0.72rem
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: 0.12em
  body-md:
    fontFamily: Inter
    fontSize: 0.92rem
    fontWeight: 400
    lineHeight: 1.55
  body-sm:
    fontFamily: Inter
    fontSize: 0.82rem
    fontWeight: 400
    lineHeight: 1.5
  label-md:
    fontFamily: JetBrains Mono
    fontSize: 0.72rem
    fontWeight: 500
    lineHeight: 1
    letterSpacing: 0.12em
  label-sm:
    fontFamily: JetBrains Mono
    fontSize: 0.66rem
    fontWeight: 500
    lineHeight: 1
    letterSpacing: 0.14em
  mono-md:
    fontFamily: JetBrains Mono
    fontSize: 0.78rem
    fontWeight: 400
    lineHeight: 1.4
  mono-sm:
    fontFamily: JetBrains Mono
    fontSize: 0.7rem
    fontWeight: 400
    lineHeight: 1.4

spacing:
  xs: 4px
  sm: 8px
  md: 12px
  base: 16px
  lg: 24px
  xl: 32px
  2xl: 48px
  3xl: 64px

rounded:
  none: 0px

components:
  button-primary:
    backgroundColor: '{colors.primary}'
    textColor: '{colors.on-primary}'
    typography: '{typography.label-md}'
    rounded: '{rounded.none}'
    padding: '16px'
    height: '44px'
  button-primary-hover:
    backgroundColor: '{colors.neutral}'
    textColor: '{colors.primary}'
  button-secondary:
    backgroundColor: 'transparent'
    textColor: '{colors.on-surface}'
    rounded: '{rounded.none}'
    padding: '16px'
    height: '44px'
  button-warn:
    backgroundColor: 'transparent'
    textColor: '{colors.warn}'
    rounded: '{rounded.none}'
    padding: '16px'
    height: '44px'
  button-warn-hover:
    backgroundColor: '{colors.warn}'
    textColor: '{colors.on-primary}'
  button-danger:
    backgroundColor: 'transparent'
    textColor: '{colors.danger}'
    rounded: '{rounded.none}'
    padding: '16px'
    height: '44px'
  button-danger-hover:
    backgroundColor: '{colors.danger}'
    textColor: '{colors.on-primary}'
  button-sm:
    typography: '{typography.label-sm}'
    padding: '10px'
    height: '28px'
  input:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.on-surface}'
    typography: '{typography.mono-md}'
    rounded: '{rounded.none}'
    padding: '12px'
    height: '44px'
  pill:
    backgroundColor: 'transparent'
    textColor: '{colors.on-surface}'
    typography: '{typography.label-sm}'
    rounded: '{rounded.none}'
    padding: '8px'
  stat-card:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.on-surface}'
    rounded: '{rounded.none}'
    padding: '24px'
  card:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.on-surface}'
    rounded: '{rounded.none}'
  modal:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.on-surface}'
    rounded: '{rounded.none}'
    padding: '0px'
  row-hover:
    backgroundColor: '{colors.surface-hover}'
  caption:
    textColor: '{colors.on-surface-dim}'
    typography: '{typography.label-sm}'
  divider:
    backgroundColor: '{colors.on-surface-faint}'
    height: '1px'
---

# Rembric — Dashboard Design System

Single source of truth for the visual identity and UI patterns served at
`/dashboard/*`. The YAML frontmatter above carries the machine-readable
design tokens; the prose below tells you **why** those values exist and
how to apply them.

If you are building or extending a dashboard page, read the whole file
before touching CSS or HTML. The recipes at the bottom show the canonical
patterns — match them rather than inventing new ones.

## Overview

Rembric's identity is **brutalist editorial**. The product is a
single-tenant, self-hosted memory layer for AI agents; it should feel
operational, terse, and unambiguous — like an oscilloscope, not a SaaS
landing page.

Visual choices:

- **Dark canvas, lime accent.** A near-black neutral (`#0a0a0a`) with a
  single vibrant lime accent (`#c6f24e`) used sparingly — as a
  highlighter/cinta, never wallpaper. Two semantic tones live alongside:
  warn (`#ff8c00`) for reversible-but-cautious actions, danger
  (`#ff3344`) for irreversible ones.
- **Editorial monospace.** All labels, IDs, table headers, and status
  pills use JetBrains Mono in uppercase with generous letter-spacing.
  Body text uses Inter; hero titles use Space Grotesk. Each font is
  self-hosted as woff2 — no CDN at runtime.
- **No radius, no shadow.** Everything is sharp-cornered; depth is
  conveyed by tonal layers and 1-px lines, never drop-shadows.
- **One product, one operator.** No theming, no light mode, no per-user
  preferences. The system looks the same for every operator.

Emotional response: precise, sober, in-control. The interface should
read as a control room — fast to scan, hard to misread.

## Colors

The palette is rooted in two near-black neutrals and a single
electric-lime accent. Two alert tones complete the vocabulary.

- **Primary (#c6f24e — Lime)**: the only "happy" colour. Reserved for
  primary actions, lime-block highlights on hero titles, active nav
  items, and active-state pills. Never used for ambient surfaces.
- **On-primary (#0a0a0a)**: text colour on lime surfaces; identical to
  the neutral so primary buttons read as "stamped ink".
- **Neutral (#0a0a0a — Near-black)**: the canvas. All pages, the
  sidebar, and the mobile bar share this background.
- **Surface (#141414 — Coal)**: cards, inputs, dialogs, filter bars —
  any contained surface that needs to lift from the canvas without using
  a shadow.
- **Surface-hover (#15170d — Coal w/ lime tint)**: row-hover background
  in tables. Faint enough to read as a hint, lime enough to feel
  on-brand.
- **On-surface (#f2f2f2 — Bone)**: primary text.
- **On-surface-dim (#9a9a9a — Ash)**: labels, captions, secondary copy.
- **On-surface-faint (#2a2a2a — Iron)**: borders, dividers, faint
  separators.
- **Warn (#ff8c00 — Ember)**: reversible-but-cautious actions (Archive
  memory, Archive project, Mark relation orphaned, Undo single op).
  Also used on the "superseded" pill.
- **Danger (#ff3344 — Signal)**: irreversible / impactful actions
  (Delete session, Revoke token, Undo entire run). Also used on the
  "orphaned" and "revoked" pills.

### Implementation

Tokens are mirrored as CSS custom properties in
`src/dashboard/styles/core/tokens.css`. Use the variables, never raw hex:

| Token              | CSS variable          |
| ------------------ | --------------------- |
| `primary`          | `var(--lime)`         |
| `on-primary`       | `var(--lime-ink)`     |
| `neutral`          | `var(--bg)`           |
| `surface`          | `var(--bg-elev)`      |
| `surface-hover`    | `var(--bg-row-hover)` |
| `on-surface`       | `var(--fg)`           |
| `on-surface-dim`   | `var(--fg-dim)`       |
| `on-surface-faint` | `var(--fg-faint)`     |
| `warn`             | `var(--warn)`         |
| `danger`           | `var(--danger)`       |

## Typography

Three faces, each with a deliberate role:

- **Space Grotesk** drives hero titles and stat values. Its geometric
  construction and tight letter-spacing make `REMBRIC OVERVIEW.` read
  as a section stamp rather than a marketing headline. Weight 700,
  uppercase, letter-spacing tight (-0.025em).
- **Inter** carries body text and paragraph copy at 14–16 px. It
  disappears into the page — that's the point.
- **JetBrains Mono** is the workhorse: labels, table headers, status
  pills, IDs, code snippets, sidebar items. Always uppercase, always
  with letter-spacing in the 0.1–0.14em range. The monospace cadence
  is what makes the dashboard read as an operator console.

### Page title pattern

Every view title is `Rembric <PageName>.` with the word `Rembric`
rendered inside a lime block (the `hl-lime` atom). Periods are part of
the title:

```
REMBRIC OVERVIEW.        ←  /dashboard
REMBRIC MEMORIES.        ←  /dashboard/memories
REMBRIC SESSION 01KR…    ←  /dashboard/sessions/:id
```

### Implementation

All faces are vendored as woff2 under `/dashboard/assets/fonts/` by
`scripts/fetch-fonts.mjs`. `@font-face` declarations live in
`tokens.css`. Use the CSS variables, never the family name directly:

| Stack   | CSS variable                                             |
| ------- | -------------------------------------------------------- |
| Display | `var(--f-display)` (Space Grotesk + system fallback)     |
| Body    | `var(--f-sans)` (Inter + system fallback)                |
| Mono    | `var(--f-mono)` (JetBrains Mono + ui-monospace fallback) |

## Layout

The layout follows a **fluid CSS Flexbox + CSS Grid** model. There is
no max-width container on `.main` — the dashboard fills the available
viewport.

A strict **8-px scale** governs spacing. Use the CSS custom properties,
never raw pixels:

| Token  | CSS                 | Use                           |
| ------ | ------------------- | ----------------------------- |
| `xs`   | `var(--s-1)` `4px`  | inner gaps in compact rows    |
| `sm`   | `var(--s-2)` `8px`  | between siblings, button gaps |
| `md`   | `var(--s-3)` `12px` | small block padding           |
| `base` | `var(--s-4)` `16px` | default block padding         |
| `lg`   | `var(--s-5)` `24px` | section padding, card body    |
| `xl`   | `var(--s-6)` `32px` | main vertical rhythm          |
| `2xl`  | `var(--s-7)` `48px` | `.main` horizontal padding    |
| `3xl`  | `var(--s-8)` `64px` | `.main` bottom padding        |

### Shell

The app frame is fixed at the side, the content fluid at the centre:

```
┌─────────────────────────────────────────────────────────────┐
│ <aside class="sb">     │ <main class="main">                │
│   brand                │   <header class="view-head">       │
│   nav (MAIN + ADMIN)   │   [optional <a class="view-back">] │
│   foot (logout)        │   …                                │
└─────────────────────────────────────────────────────────────┘
```

`.sb` is **196 px** wide. When the user collapses it (`.is-collapsed`
on both `.app` and `.sb`), it shrinks to **56 px** and hides labels
with a 140 ms `width` transition. The state persists in the
`rbr-sb-collapsed` cookie so the SSR HTML is correct on first paint
— no FOUC.

### Responsive breakpoints

```
≥1281 px   full desktop: sidebar 196 px, grids at max density
≤1280 px   sidebar still desktop; .grid-7 → 4 cols; .grid-6 → 3 cols
≤980 px    sidebar collapses into top drawer (transform translateY);
           multi-col grids stack; tables stay scrollable inside .tbl-host;
           filter bar stacks vertically with separators
≤640 px    single-column everywhere; stat grids 2-wide; login pane
           single; table min-width drops to 580 px
```

Minimum supported viewport: **320 px**. No horizontal page-level scroll
at any width — only `.tbl-host` and inline `<pre>` blocks scroll
horizontally. Touch targets at ≤980 px: **≥44 × 44 px**.

## Elevation & Depth

Rembric is a **flat** design system. There are no box-shadows anywhere
in production CSS. Visual hierarchy is conveyed by three mechanisms:

- **Tonal layers**: the canvas is `#0a0a0a`; cards and inputs sit on
  `#141414`; hovered rows shift to `#15170d`. Each step is small (~5%
  luminance) — enough to be felt, not seen.
- **1-px borders** in `#2a2a2a` separate everything that needs
  separation: card edges, table borders, view-head bottom border,
  section bars, filter bar boundaries.
- **Lime accents** (3-px left bars on `.sb-section`, lime borders on
  the append-only banner, lime underlines on the `u-lime` atom) act as
  navigational anchors and let the eye locate state changes quickly.

Hovers add saturation, not size — borders shift to lime, text colour
shifts to lime, but the element does not enlarge or float.

## Shapes

The shape language is **architectural sharpness**. Every interactive
element, container, input, pill, button, and dialog uses a corner
radius of **0**. The `rounded` token group in the frontmatter exposes
only `none: 0px` for this reason — there is no scale beyond it.

Rounded corners would soften the brutalist character and make the
dashboard read as a generic SaaS product. Pills, buttons, cards,
inputs — all rectangles.

## Components

Atoms live in `src/dashboard/styles/core/atoms.css`. Patterns live in
`src/dashboard/styles/core/patterns.css`. Element-level defaults inside
`.main` live in `src/dashboard/styles/core/content.css`.

### Buttons

Four tone variants share the same base. **Tone semantics are
load-bearing**:

| Class            | Tone     | When to use                                                                                       |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `.btn.primary`   | Lime     | Confirm / save / sign-in / filter — the affirmative action                                        |
| `.btn.secondary` | Outlined | Cancel, dismissive, navigation                                                                    |
| `.btn.warn`      | Orange   | Reversible-but-cautious (Archive memory, Archive project, Mark relation orphaned, Undo single op) |
| `.btn.danger`    | Red      | Irreversible (Delete session, Revoke token, Undo entire run)                                      |

`.btn.sm` shrinks padding + font for inline placements. Buttons inside
a `<td>` or `.actions` container are automatically downsized by
`content.css` — no need to add `.sm` by hand.

Every destructive button (warn/danger) MUST live inside a form marked
`data-confirm` so the global confirmation dialog opens before submit.

### Pills

`.pill` is a small bordered chip with a coloured leading bullet. Use
modifier classes for state: `active`, `superseded`, `archived`,
`pending`, `judged`, `orphaned`, `global`, `scope`, `project`, plus
type pills (`t-user`, `t-feedback`, `t-project`, `t-reference`) and
relation-kind pills (`k-supersedes`, `k-conflicts_with`, `k-related`,
`k-compatible`, `k-scoped`, `k-not_conflict`, `k-pending`).

### Inputs

`.inp` and `.sel` are the large form fields. Inside `.main`, bare
`<input type="text|password|search">` and `<select>` pick up the same
brutalist treatment from `content.css`. Use the classes only outside
`.main` (login page).

### Filters bar

A single, compact, informative row. Pattern:

```html
<form class="filters" method="get">
  <span class="group">
    <span class="k">SCOPE</span>
    <select name="project">
      …
    </select>
  </span>
  <span class="group search">
    <span class="k">SEARCH</span>
    <input type="search" name="q" placeholder="fts5 keyword" />
  </span>
  <span class="acts">
    <button class="btn primary" type="submit">FILTER</button>
    <a class="clear" href="/dashboard/X">CLEAR</a>
  </span>
</form>
```

On ≤980 px the bar stacks vertically, each group gets a border-bottom
separator (except the last, to avoid duplicating the border-top of
`.acts`), and the actions row gets clear breathing room above.

### Tables

Every dashboard table lives inside a `<div class="tbl-host">` so it
scrolls horizontally inside its container instead of pushing the page
width past the viewport. Inside `.main`, bare `<table>` picks up the
brutalist look from `content.css`.

To make a row navigate to a detail page, add `data-href="/dashboard/…"`
on the `<tr>`. The global `ROW_LINK` script intercepts clicks (skipping
links / buttons / forms) and navigates. Cursor turns into a pointer
automatically.

### Stat cards

`statCard({ k, v, tone, sub, href })` renders a single brutalist stat
tile (big number, label, optional sub text). Wrap rows of them in
`.grid-7` or `.grid-6` for the responsive collapse to work.

### View head + back link

`viewHead({ num, title, hl, meta })` + (on detail pages) `backLink({
href, label })` rendered immediately after. The back link sits at the
top of the content area (NOT inside the view-head meta strip).

### Pager

`pager({ page, hasMore, pageHrefBuilder, totalLabel })` — never roll
your own. Pagination uses **offset+limit with `LIMIT PAGE_SIZE + 1`**
to detect `hasMore` without a separate COUNT query. `PAGE_SIZE` is **10**
across all listings; exported from `components.ts`.

### Modal

The global `<dialog class="modal">` lives at the bottom of `<body>` in
`shell()`. Any `<form data-confirm="message">` opens it before
allowing submit. Tone via `data-confirm-tone` (`warn` / `danger`).

### Component reference

| Helper                                | File            | Purpose                                                   |
| ------------------------------------- | --------------- | --------------------------------------------------------- |
| `renderPage(c, sessions, body, opts)` | `page-shell.ts` | canonical entry for authenticated pages                   |
| `shell(body, opts)`                   | `templates.ts`  | lower-level layout — used only by login + by `renderPage` |
| `viewHead(opts)`                      | `components.ts` | hero header with lime-block highlight                     |
| `backLink(opts)`                      | `components.ts` | "← BACK TO …" sub-page link                               |
| `statCard(opts)`                      | `components.ts` | brutalist stat tile                                       |
| `pager(opts)`                         | `components.ts` | prev / next pager                                         |
| `sectionBar(opts)`                    | `components.ts` | soft section divider                                      |
| `flash(opts)`                         | `components.ts` | inline banner                                             |
| `btn(opts)`                           | `components.ts` | branded button                                            |
| `sparkline(data)`                     | `components.ts` | inline SVG sparkline                                      |
| `urlWithPage(url, page)`              | `components.ts` | preserve filters when paging                              |
| `formatTs(d)`                         | `templates.ts`  | local-time `<time>` with UTC fallback                     |
| `statusPill(s)` / `scopePill(s)`      | `templates.ts`  | brand-aware pills                                         |

## Do's and Don'ts

**Do**

- Use the CSS custom properties from `tokens.css` for every colour,
  spacing, and typography reference. Never raw hex, never raw `px`.
- Use `renderPage()` as the entry point for every authenticated route.
- Wrap every `<table>` in `<div class="tbl-host">` so it scrolls
  horizontally inside its container.
- Mark every destructive form with `data-confirm`. Pick the right tone
  (`warn` vs `danger`) — that's a semantic decision, not aesthetic.
- Add `data-href` to a `<tr>` to make the whole row navigable to its
  detail page. Don't add a separate "OPEN ›" button.
- Maintain WCAG AA contrast (4.5:1 for body text). The locked palette
  satisfies this; don't add new colours that don't.
- Keep touch targets ≥44 × 44 px at ≤980 px.

**Don't**

- Don't introduce inline `<style>` blocks in templates. The single
  inline style allowed is one-off content-driven values (a sparkline
  data array, a width %). Anything reusable belongs in CSS.
- Don't use `localStorage` for UI state. Cookies are the rule — they
  render correctly on first paint without a flash.
- Don't add `border-radius`. The shape language is square.
- Don't add `box-shadow`. Depth comes from tonal layers and borders.
- Don't use a CDN at runtime — vendor fonts, HTMX, favicons. The
  dashboard must work offline.
- Don't introduce a client-side JS framework (React, Vue, Svelte,
  Tailwind, Alpine). HTMX + tiny vanilla scripts is the cap.
- Don't use the lime accent on more than one element per "decision
  unit" — primary action, active nav item, or hero highlight. If two
  lime elements compete for attention on the same screen, demote one.
- Don't mix tone semantics. `Archive` is `warn`, `Delete` is `danger`.
  Don't downgrade a delete to warn to "soften" it — the colour is the
  warning.

---

The following sections are **Rembric-specific extensions** to the
canonical DESIGN.md spec. Per the spec, "Unknown section heading:
Preserve; do not error", so consumers should preserve these as-is.

## Recipe: add a new dashboard page

1. **CSS**: create `src/dashboard/styles/views/<view>.css` (can be
   empty — the file's mere existence registers a view bundle).
2. **Route handler** at `src/dashboard/<view>.ts`:

   ```ts
   import { backLink, PAGE_SIZE, pager, urlWithPage, viewHead } from './components.js';
   import { renderPage } from './page-shell.js';
   import { html, raw } from './templates.js';

   export function createXRouter(deps): Hono {
     const app = new Hono();
     app.get('/', (c) => {
       const session = getSession(c);
       if (!session) return c.redirect('/dashboard/login');
       const body = html`
         ${viewHead({
           num: 'NN',
           title: 'Rembric X.',
           hl: 'Rembric',
           meta: [{ k: 'TOTAL', v: '0' }],
         })}
         <div class="tbl-host">
           <table>
             …
           </table>
         </div>
         ${pager({ page, hasMore, pageHrefBuilder: (p) => urlWithPage(c.req.url, p) })}
       `;
       return c.html(renderPage(c, deps.sessions, body, { title: 'X', activeNav: 'x' }));
     });
     return app;
   }
   ```

3. **Mount** in `src/server/dashboard-router.ts` with
   `app.route('/x', createXRouter(...))`.
4. **Nav**: add the entry to `NAV` in `components.ts`.
5. **Tests**: cover the route in `src/test/dashboard-e2e.test.ts` if
   it surfaces user-visible data.

## Recipe: a destructive action

```ts
html`
  <form
    action="/dashboard/tokens/${t.name}/revoke"
    method="post"
    class="inline"
    data-confirm='Revoke token "${t.name}"? This is IRREVERSIBLE. Any agent using this token will lose access immediately.'
    data-confirm-label="REVOKE TOKEN"
    data-confirm-tone="danger"
  >
    ${csrfInput(session.session, deps.sessions, 'token.revoke')}
    <button class="danger" type="submit">Revoke</button>
  </form>
`;
```

Skip confirmation for: undelete, unarchive, rename, create (benign or
trivially reversible).

## Recipe: row navigation

```ts
html`
  <tr data-href="/dashboard/memories/${m.id}">
    <td class="mono"><a href="/dashboard/memories/${m.id}">${shortId(m.id)}</a></td>
    …
  </tr>
`;
```

The link inside the ID column is still there for keyboard users and
right-clickers; the `data-href` lets the whole row be clickable for
mouse users.

## JS enhancements (in `templates.ts`)

All scripts inline in `<head>`. Tiny vanilla JS. Every interaction has
a no-JS fallback.

| Script        | Purpose                                                      | Trigger                                                 |
| ------------- | ------------------------------------------------------------ | ------------------------------------------------------- |
| `TS_UPGRADER` | Localizes `<time data-rembric-ts>` via `Intl.DateTimeFormat` | `DOMContentLoaded` + `htmx:afterSwap`                   |
| `MOB_TOGGLE`  | Opens / closes mobile drawer                                 | Click on `.mob-toggle` / `.sb-mob-close` / `Escape` key |
| `SB_COLLAPSE` | Desktop sidebar collapse with width transition               | Submit on `form[action="/dashboard/_sidebar/toggle"]`   |
| `ROW_LINK`    | Whole-row navigation in tables                               | Click on `<tr data-href>` (skips interactive children)  |
| `CONFIRM`     | Native `<dialog>` confirmation for destructive forms         | Submit on `<form data-confirm>`                         |

## Reference files

```
src/dashboard/templates.ts            shell() + html`` + minifier + scripts
src/dashboard/page-shell.ts           renderPage() — authenticated entry
src/dashboard/components.ts           viewHead, statCard, pager, btn, …
src/dashboard/assets.ts               static asset middleware
src/dashboard/csrf.ts                 CSRF helpers
src/dashboard/styles/
  core/tokens.css                     CSS variables + @font-face
  core/base.css                       reset + global element defaults
  core/atoms.css                      .pill .btn .inp .flash .tag .bn …
  core/layout.css                     .app .sb .mob-bar .view-head
  core/patterns.css                   .stat .grid-7 .tbl .filters .pager …
  core/content.css                    bare element defaults inside .main
  views/*.css                         per-page extensions
scripts/build-css.mjs                 lightningcss build pipeline
scripts/fetch-fonts.mjs               woff2 vendor script
openspec/specs/dashboard/spec.md      spec contract that locks the design
```
