---
version: alpha
name: Rembric
description: >-
  Dark monochrome zinc design system with the Rembric lime as the single accent
  for the self-hosted MCP memory dashboard. A Next.js App Router + React 19
  surface on Tailwind v4 + shadcn/Radix, with a `--radius` token scale. The
  canonical identity doc is `.agents/skills/rembric-dashboard-ui/SKILL.md`; the
  formal OpenSpec spec change is pending.

colors:
  primary: '#c6f24e'
  on-primary: '#09090b'
  background: '#09090b'
  card: '#101012'
  raised: '#18181b'
  accent: '#1c1c1f'
  border: '#1f1f23'
  input: '#27272a'
  ring: '#3f3f46'
  foreground: '#fafafa'
  foreground-secondary: '#a1a1aa'
  foreground-muted: '#71717a'
  warn: '#ff8c00'
  destructive: 'oklch(0.704 0.191 22.216)'

typography:
  display:
    fontFamily: Geist
    fontSize: 3rem
    fontWeight: 700
    lineHeight: 0.95
    letterSpacing: -0.025em
  display-lg:
    fontFamily: Geist
    fontSize: 5rem
    fontWeight: 700
    lineHeight: 0.9
    letterSpacing: -0.035em
  h1:
    fontFamily: Geist
    fontSize: 2.4rem
    fontWeight: 700
    lineHeight: 1
    letterSpacing: -0.02em
  h2:
    fontFamily: Geist Mono
    fontSize: 0.78rem
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: 0.14em
  h3:
    fontFamily: Geist Mono
    fontSize: 0.72rem
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: 0.12em
  body-md:
    fontFamily: Geist
    fontSize: 0.92rem
    fontWeight: 400
    lineHeight: 1.55
  body-sm:
    fontFamily: Geist
    fontSize: 0.82rem
    fontWeight: 400
    lineHeight: 1.5
  label-md:
    fontFamily: Geist Mono
    fontSize: 0.72rem
    fontWeight: 500
    lineHeight: 1
    letterSpacing: 0.12em
  label-sm:
    fontFamily: Geist Mono
    fontSize: 0.66rem
    fontWeight: 500
    lineHeight: 1
    letterSpacing: 0.14em
  mono-md:
    fontFamily: Geist Mono
    fontSize: 0.78rem
    fontWeight: 400
    lineHeight: 1.4
  mono-sm:
    fontFamily: Geist Mono
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
  button: 10px
  input: 12px
  card: 16px

components:
  button:
    rounded: '{rounded.button}'
    typography: '{typography.body-sm}'
    fontWeight: 500
    height: '36px'
    padding: '16px'
    gap: '8px'
  button-sm:
    height: '32px'
    padding: '12px'
  button-lg:
    height: '40px'
    padding: '24px'
  button-default:
    backgroundColor: '{colors.primary}'
    textColor: '{colors.on-primary}'
  button-outline:
    backgroundColor: 'rgba(39,39,42,.3)'
    textColor: '{colors.foreground}'
    borderColor: '{colors.input}'
  button-secondary:
    backgroundColor: '{colors.raised}'
    textColor: '{colors.foreground}'
  button-ghost:
    backgroundColor: 'transparent'
    textColor: '{colors.foreground}'
  button-warn:
    backgroundColor: 'rgba(255,140,0,.1)'
    textColor: '{colors.warn}'
    borderColor: 'rgba(255,140,0,.4)'
  button-destructive:
    backgroundColor: 'rgba(destructive,.2)'
    textColor: '{colors.destructive}'
  input:
    backgroundColor: 'rgba(39,39,42,.3)'
    textColor: '{colors.foreground}'
    typography: '{typography.body-sm}'
    rounded: '{rounded.input}'
    height: '36px'
  pill:
    typography: '{typography.body-sm}'
    rounded: '9999px'
    padding: '10px'
  alert:
    backgroundColor: '{colors.card}'
    rounded: '{rounded.input}'
    padding: '16px'
  card:
    backgroundColor: '{colors.card}'
    textColor: '{colors.foreground}'
    rounded: '{rounded.card}'
  modal:
    backgroundColor: '{colors.card}'
    textColor: '{colors.foreground}'
    rounded: '{rounded.card}'
    padding: '16px'
  row-hover:
    backgroundColor: '{colors.accent}'
  caption:
    textColor: '{colors.foreground-muted}'
    typography: '{typography.label-sm}'
  divider:
    backgroundColor: '{colors.border}'
    height: '1px'
---

# Rembric — Dashboard Design System

Single source of truth for the **current** visual identity and UI patterns
served at `/dashboard/*`. The YAML frontmatter above carries the
machine-readable design tokens; the prose below tells you **why** those values
exist and how to apply them.

The canonical, always-current identity doc is
`.agents/skills/rembric-dashboard-ui/SKILL.md` (v1.1). This file is the
repo-root overview that defers to it and to the live implementations. The
identity was **redesigned (2026-09, branch `feat/dashboard-identity-redesign`)**;
the previous identity is preserved as history at the end of this file.

If you are building or extending a dashboard page, read the whole file before
touching code. The recipes at the bottom show the canonical patterns — match
them rather than inventing new ones.

## Overview

Rembric's identity is **dark monochrome zinc with a single lime accent**. The
product is a single-tenant, self-hosted memory + sessions + dashboard for AI
coding agents; it should feel operational, terse, and unambiguous — a control
room, not a SaaS landing page.

Visual choices:

- **Dark canvas, one accent.** Near-black zinc surfaces (`#09090b`) carried by
  a layered surface ladder (`#101012` cards, `#18181b` raised/popover/muted) and
  1-px `#1f1f23` borders. Lime (`#c6f24e`) is the **only** accent — it marks
  primary actions, active state, and the chart's save series, never wallpaper.
  Amber (`#ff8c00`) and destructive stay for warn / danger tones.
- **Geist, self-hosted.** Geist drives UI and display output; Geist Mono owns
  labels, meta, counters and tabular data. Both are self-hosted woff2 — no CDN
  at runtime, no second display face.
- **Depth without heavy chrome.** Soft shadows only (`shadow-lg shadow-black/20`
  – `shadow-black/40`) plus **radial lime glows**; hierarchy comes from the
  surface ladder and 1-px lines, not from hard borders.
- **Rounded, restrained geometry.** `--radius: 1rem`; cards `rounded-2xl` (16),
  inputs `rounded-xl` (12), buttons `rounded-lg` (10), status pills
  `rounded-full`. Shape is a token decision, never a hard-coded zero.
- **Floating shell, no sidebar.** A floating centered command bar replaces the
  old fixed rail; login and OAuth consent render chrome-free.
- **One product, one operator.** No theming, no light mode, no per-user
  preferences. The surface looks the same for every operator.

Emotional response: precise, sober, in-control. The interface should read as a
control room — fast to scan, hard to misread.

## Colors

The palette is a zinc surface ladder plus a single lime accent, two alert tones,
and a zinc chart ladder that uses lime as `chart-1`.

- **Primary (#c6f24e — Lime)**: the only "happy" colour. Reserved for primary
  actions, active nav items, active-state pills, and the chart's save series.
- **On-primary (#09090b)**: text colour on lime surfaces, so primary buttons
  read as lime fill + near-black ink.
- **Background (#09090b)**: the canvas — every page and the floating command
  bar share it.
- **Card (#101012)**: the base contained surface for cards, panels, and stat
  tiles.
- **Raised (#18181b)**: raised / popover / secondary / muted surfaces that lift
  above a card (dropdowns, sheets, secondary buttons, empty pills).
- **Accent (#1c1c1f)**: hover and subtle-selected background (row-hover, active
  menu items).
- **Border (#1f1f23)**: 1-px borders on cards, tables, and chrome.
- **Input (#27272a)**: form-field background; **Ring (#3f3f46)**: focus rings.
- **Foreground (#fafafa)**: primary text. **Foreground-secondary (#a1a1aa)**:
  secondary copy. **Foreground-muted (#71717a)**: labels, captions, meta.
- **Warn (#ff8c00 — Amber)**: reversible-but-cautious actions (abandon, archive,
  supersede) and the chart's consolidation-ops series.
- **Destructive**: irreversible / impactful actions (delete session, revoke
  token). Kept as the shadcn `--destructive` token.
- **Charts (`--chart-1`…`--chart-5`)**: `#c6f24e` → `#a1a1aa` → `#52525b` →
  `#3f3f46` → `#27272a`; the zinc ladder with lime reserved for the primary
  series.

### The chrome-only rule

On **light** surfaces lime is **chrome only** — fills, borders, dots, and bars.
**Never lime text on a light background.** On the dark dashboard lime text is
legitimate (active nav item, active-state pill, positive metric), but it stays
rationed: one lime decision per screen.

### Implementation

Tokens are defined as CSS custom properties in
`apps/web/src/app/globals.css` and mapped into Tailwind v4 via `@theme inline`,
so utilities such as `bg-background`, `bg-card`, `bg-popover`,
`text-foreground`, `text-muted-foreground`, `border-border`, `bg-primary`,
`text-warn`, and `text-destructive` resolve to the tokens. Use the utilities and
variables, never raw hex.

| Token                  | CSS variable                | Tailwind utility              |
| ---------------------- | --------------------------- | ----------------------------- |
| `primary`              | `var(--primary)`            | `bg-primary` / `text-primary` |
| `on-primary`           | `var(--primary-foreground)` | `text-primary-foreground`     |
| `background`           | `var(--background)`         | `bg-background`               |
| `card`                 | `var(--card)`               | `bg-card`                     |
| `raised`               | `var(--popover)`            | `bg-popover` / `bg-secondary` |
| `accent`               | `var(--accent)`             | `bg-accent`                   |
| `border`               | `var(--border)`             | `border-border`               |
| `input`                | `var(--input)`              | `bg-input`                    |
| `ring`                 | `var(--ring)`               | `ring-ring`                   |
| `foreground`           | `var(--foreground)`         | `text-foreground`             |
| `foreground-secondary` | (zinc step)                 | `text-zinc-400`               |
| `foreground-muted`     | `var(--muted-foreground)`   | `text-muted-foreground`       |
| `warn`                 | `var(--warn)`               | `text-warn`                   |
| `destructive`          | `var(--destructive)`        | `text-destructive`            |

## Typography

Two families, each with a deliberate role:

- **Geist** drives UI and display output — titles, body copy, stat values. It is
  wired to `--font-sans` and `--font-display`, giving the product a single clean
  voice instead of a three-face stack.
- **Geist Mono** owns labels, counters, meta, and tabular data — table numbers,
  durations, IDs, code snippets, section labels. Its tabular cadence is what
  makes the dashboard read as an operator console.

Both are vendored as woff2 under `apps/web/src/app/fonts/` and loaded in
`apps/web/src/app/layout.tsx` with `next/font/local`. Use the CSS variables,
never the family name directly:

| Stack   | CSS variable                                  |
| ------- | --------------------------------------------- |
| UI      | `var(--font-geist)` → `var(--font-sans)`      |
| Display | `var(--font-geist)` → `var(--font-display)`   |
| Mono    | `var(--font-geist-mono)` → `var(--font-mono)` |

No CDN fonts and no second display face.

## Layout

The dashboard is laid out by a **floating command bar over a fluid content
column**. There is **no sidebar rail** — the old fixed 196 px rail is gone.

### Shell

`apps/web/src/components/dashboard/command-bar.tsx` renders `CommandFrame`:
a floating, centered header (`rounded-2xl border bg-card/90 backdrop-blur`) with
the primary nav, a "More" dropdown for secondary entries, badge counters, and a
mobile `Sheet` drawer. `apps/web/src/app/dashboard/layout.tsx` wraps every
authenticated route in it. Nav data lives in `apps/web/src/lib/nav.ts`
(`NAV` / `NAV_GROUPS`); add entries there and both the desktop bar and the mobile
sheet pick them up.

### Chrome-free screens

`/dashboard/login` and `/dashboard/oauth-consent` render **without** the frame.
They are listed in `CHROME_FREE_PATHS` in `apps/web/src/lib/nav.ts`, and
`CommandFrame` short-circuits on `isChromeFreePath()` — a route renders
standalone as soon as it is added to that list.

### Spacing

A strict **8-px scale** governs spacing:

| Token  | Value | Use                            |
| ------ | ----- | ------------------------------ |
| `xs`   | 4px   | inner gaps in compact rows     |
| `sm`   | 8px   | between siblings, button gaps  |
| `md`   | 12px  | small block padding            |
| `base` | 16px  | default block padding          |
| `lg`   | 24px  | section padding, card body     |
| `xl`   | 32px  | main vertical rhythm           |
| `2xl`  | 48px  | wide-screen horizontal padding |
| `3xl`  | 64px  | page bottom padding            |

### Responsive

Below **768 px** the command bar collapses to a compact bar with a `Sheet`
drawer, page content stacks to a single column, and tables stay scrollable
inside their panel rather than pushing page width. Minimum supported viewport:
**320 px** with no page-level horizontal scroll. Touch targets stay **≥44 × 44
px** on touch layouts.

## Elevation & Depth

Depth is conveyed by **tonal layers, soft shadows, and glows** rather than heavy
borders:

- **Tonal layers**: canvas `#09090b`; cards `#101012`; raised surfaces
  `#18181b`; hover accent `#1c1c1f`. Each step is small — felt, not seen.
- **Soft shadows only**: `shadow-lg` with `shadow-black/20`–`shadow-black/40`.
  There is no hard drop-shadow vocabulary and no stacked shadow decoration.
- **Radial lime glows**: a faint radial gradient anchors key surfaces, e.g.
  `bg-[radial-gradient(640px_260px_at_50%_-60px,rgba(198,242,78,0.09),transparent_70%)]`.
  This is the signature "lit from within" depth cue from the redesign mockups.
- **1-px borders** in `#1f1f23` separate chrome and panels where a line is
  clearer than a tonal step.

Hovers shift tone (surface or lime), they do not enlarge or float the element.

## Shapes

The shape language is driven by the `--radius` token scale (`--radius: 1rem`)
and expressed in Tailwind utilities:

| Role                    | Radius | Where it is set                                       |
| ----------------------- | ------ | ----------------------------------------------------- |
| Cards, panels, modals   | 16 px  | `rounded-2xl`; `DialogContent` / `AlertDialogContent` |
| Inputs, selects, alerts | 12 px  | `Input`, `SelectTrigger`, `Alert` (`rounded-xl`)      |
| Buttons                 | 10 px  | `Button` / `buttonVariants` (`rounded-[10px]`)        |
| Pills, quick filters    | full   | `StatusPill` / `TonePill` (`rounded-full`)            |

The radius lives inside the primitive. A consumer never passes a `rounded-*`
class to `Button`, `Input`, `SelectTrigger`, `DialogContent` or
`AlertDialogContent`; `apps/web/src/components/ui/shape-radii.test.tsx` pins the
values.

Keep the scale restrained. Character comes from the monochrome palette, the lime
accent, the typography, and 1-px lines — not from heavy rounding or mixed
radii. Don't hard-code a corner radius; use the scale so shape stays consistent
across primitives.

## Components

Server components compose the new identity directly. Shared primitives live in
`apps/web/src/components/dashboard/` and `apps/web/src/components/ui/`.

### Buttons

Every clickable control that looks like a button is the shadcn `Button`
(`apps/web/src/components/ui/button.tsx`). There is no second button style.

| Variant       | Look                  | Use it for                                                                  |
| ------------- | --------------------- | --------------------------------------------------------------------------- |
| `default`     | Lime fill, near-black | The one affirmative action of a region: Save, Connect, Create, Sign in      |
| `outline`     | Input border, raised  | Secondary actions next to a primary: Add by hand, Cancel in a dialog footer |
| `secondary`   | Raised fill           | Neutral actions on busy surfaces (Wrapped player controls)                  |
| `ghost`       | No fill until hover   | Tertiary and in-row actions: Change, Ignore, row `⋯` triggers, icon buttons |
| `warn`        | Amber tint            | Reversible but consequential: Archive, Abandon, Disconnect                  |
| `destructive` | Red tint              | Irreversible: Delete, Revoke, Purge                                         |
| `link`        | Lime text, underline  | Inline text actions inside a sentence (dark surface only)                   |

| Size                                    | Height | Use it for                                    |
| --------------------------------------- | ------ | --------------------------------------------- |
| `xs`                                    | 28 px  | Dense table cells                             |
| `sm`                                    | 32 px  | Row actions, bulk bar, menus                  |
| `default`                               | 36 px  | Page header actions, forms, dialog footers    |
| `lg`                                    | 40 px  | Hero calls to action (Play your recap), login |
| `icon`, `icon-xs`, `icon-sm`, `icon-lg` | square | Icon-only buttons; always with `aria-label`   |

Spacing is shadcn's standard (new-york): `default` is `h-9 px-4 gap-2`, and
`px-3` when it carries an icon; `sm` is `h-8 px-3`; `lg` is `h-10 px-6`. Inputs
and select triggers share the 36 px height (`sm` select: 32 px) so a field and
its button line up. Select and menu items are `py-1.5 pl-2` inside a `p-1`
viewport; a select list is capped at 18 rem and scrolls.

Rules:

- **No shape overrides.** `className` on a `Button` carries layout only
  (`w-full`, `flex-1`, `ml-auto`, `justify-start`). Never radius, height,
  font size or weight, letter case, tracking or colour. If a tone is missing,
  add a variant to `button.tsx`, as `warn` was.
- **One lime per region.** A header, a dialog footer or a row has at most one
  `default` button.
- **Links that look like buttons** are `<Button asChild><Link …/></Button>`. A
  button-looking label inside a larger link card (the Wrapped entry) is a
  `<span className={buttonVariants({ size: 'lg' })}>`: a link never nests
  another interactive element.
- **Icons** are lucide-react, sized by the button (`size-4`, `size-3.5` at `sm`),
  placed before the label; a trailing `ArrowUpRight` marks a call to action
  that leaves the page. Never a text glyph such as `↗` or `→`.
- **Labels** are sentence case: "Archive selected", not "ARCHIVE SELECTED".
- **Touch-target exception.** Only the Wrapped story player and the share
  dialog may add `min-h-11 min-w-11` for 44 px targets.

### Modals and panels

Pick the overlay by what it holds; never hand-roll a fixed overlay.

| Primitive                         | Holds                               | Example                           |
| --------------------------------- | ----------------------------------- | --------------------------------- |
| `AlertDialog` via `ConfirmSubmit` | A yes/no confirmation of a mutation | Archive project, Disconnect       |
| `Dialog`                          | A short form or a read-only panel   | Add a repository by hand, update  |
| `Sheet` (`side="right"`)          | A longer form tied to a list row    | New project, Edit project, tokens |

- `DialogContent` sets only its width (`sm:max-w-lg`); radius, padding and ring
  come from the primitive. Content is `DialogHeader` (`DialogTitle` +
  `DialogDescription`), the body, then `DialogFooter` with the buttons right
  aligned: Cancel `outline`, then the single primary.
- `ConfirmSubmit` renders Cancel as "Cancel" and the confirm action as
  `variant="warn"` for `tone="warn"` and `variant="destructive"` for
  `tone="danger"`. Its `confirmLabel` repeats the verb of the trigger.
- Sheets use `bg-card`, `sm:max-w-md` and scroll their body.

### Alerts

`Alert` (`apps/web/src/components/ui/alert.tsx`) is the only inline message:
form errors, created/failed results, conflict notices. Variants `default`,
`success` (lime), `warn` (amber) and `destructive`. Put a lucide icon first
(`CheckCircle2`, `AlertTriangle`), then `AlertDescription`, optionally
`AlertTitle`. Titles are sentence case; no `ERROR` / `CREATED` stamps.
`ActionForm` renders its error through `Alert`.

### Pills

`StatusPill` (`apps/web/src/components/dashboard/ui.tsx`) renders a status from
the `STATUS_TONE` map (active/judged → lime, abandoned/superseded → amber,
archived/ended/pending → dim, orphaned/deleted → danger). `TonePill` is the same
pill for anything that is not a lifecycle status: kinds ("new", "conflict"),
markers ("default", "legacy") and counts in tabs. Never hand-roll a
`rounded-full border` span.

### Tabs

- **Between routes** (Projects / Repositories): `RouteTabs`
  (`apps/web/src/components/dashboard/route-tabs.tsx`), an underline strip of
  `next/link`s with `aria-current="page"` and an optional `TonePill` badge.
- **Within a page**: `Tabs` from `apps/web/src/components/ui/tabs.tsx`.
- **Filtering a list**: the Spectrum data-table quick-filter pills.

### Selects and checkboxes

Use `Select` (`components/ui/select.tsx`) and `Checkbox`
(`components/ui/checkbox.tsx`); never a styled native `<select>`. When the value
must reach a server action, keep it in state and submit it as a hidden input of
the form.

### Spectrum data-table (list views)

Every list/table page goes through `DataTable` from
`@/components/spectrumui/data-table` with `variant="panel"`. The shared engine
provides:

- **quick-filter pills** with live counts,
- **client search**,
- **selectable rows** with a rising **bulk-action bar**,
- a contextual **`⋯` row menu** (`rowActions`),
- a **detail disclosure** (`renderDetail`),
- and `pageSize` for client-side pagination.

`apps/web/src/components/dashboard/sessions-table.tsx` is the **canonical
implementation** to copy. Siblings in the same pattern: `judgments-table.tsx`,
`prompts-table.tsx`, `memories-table.tsx`, `entities-table.tsx`,
`tokens-table.tsx`.

### Forms & mutations

Every mutation is a **server action through `ActionForm`**
(`@/components/dashboard/action-form`). Put a `<CsrfField form={FORM_NAME} />`
(`csrf-field.tsx`) in it and start the action with
`guardAction(formData, FORM_NAME)` / `guardFailure(...)`
(`@/lib/actions/guard`), which enforces session + admin + CSRF. The action
returns `ActionState = { error: string | null }`.

Inputs use the shadcn primitives bound to the tokens (`bg-input`,
`border-border`, `rounded-xl`). There is no second styling system.

### ConfirmSubmit

`ConfirmSubmit` (`confirm-submit.tsx`) wires a Radix `AlertDialog` to the
enclosing `ActionForm` via `useActionFormId`, so it only works **inside** an
`<ActionForm>`, wrapping a `<Button type="button">` trigger whose variant
matches the tone (`warn` or `destructive`). Pass `tone="danger"` for
irreversible actions, `"warn"` for reversible ones.

### Time

`<Time>` (`time.tsx`) emits `<time dateTime data-rembric-ts>` with a UTC
fallback and re-renders in the viewer's timezone after mount. Never hand-write
`toISOString` / `toLocaleString` in views.

### Nav

Nav entries live in the `NAV` array (`lib/nav.ts`): group, `num`, label, `href`,
lucide `icon`, optional `badgeKey`. The command bar and its mobile sheet both
read it. Chrome-free routes go in `CHROME_FREE_PATHS`.

### Charts

`activity-chart.tsx` is the reference for lime/zinc bar visuals: lime for saves,
amber for superseded/archived ops, rounded caps, hover tooltips on `bg-popover`
with soft `shadow-black/40`.

## Do's and Don'ts

**Do**

- Use the Tailwind utilities bound to the tokens in `globals.css` for every
  colour, spacing, and type reference. Never raw hex.
- Use `StatusPill` / `TonePill` for pills and the Spectrum `DataTable` for list
  views — copy `sessions-table.tsx` rather than inventing a table.
- Use `Button` for every button and `Alert` for every inline message.
- Route every mutation through `ActionForm` + `CsrfField` + `guardAction`.
- Wrap every destructive action in `ConfirmSubmit` and pick the right tone
  (`warn` vs `danger`) — that's a semantic decision, not aesthetic.
- Add new nav entries to `NAV` (and chrome-free routes to `CHROME_FREE_PATHS`)
  so the command bar and mobile sheet stay in sync.
- Put the ⋯ menu's "View details" as a `next/link`; there is no `data-href` /
  `ROW_LINK` script anymore.
- Send timestamps through `<Time>`.
- Maintain WCAG AA contrast (4.5:1 for body text). The palette satisfies this;
  don't add colours that don't.
- Keep touch targets ≥44 × 44 px on touch layouts.

**Don't**

- Don't introduce new CSS files or inline `<style>` blocks — style with Tailwind
  utilities bound to `globals.css`.
- Don't add a second client framework or a competing styling system on top of
  React + Tailwind v4.
- Don't use lime text on a light surface, and don't spend more than one lime
  element per decision unit.
- Don't hard-code a corner radius; the primitives carry the 16 / 12 / 10 scale.
- Don't style a `<button>`, `<a>` or `<span>` to look like a button, and don't
  pass radius, height, weight, case or colour classes to `Button`.
- Don't build an overlay by hand; use `AlertDialog`, `Dialog` or `Sheet`.
- Don't write `ALL CAPS` labels on buttons, dialog actions or alerts.
- Don't layer decorative `box-shadow`s. Depth comes from tonal layers, soft
  shadows, and radial lime glows.
- Don't add a CDN at runtime — fonts are self-hosted; the dashboard must work
  offline.
- Don't mix tone semantics. `Abandon` is warn, `Delete` is danger. Don't
  downgrade a delete to warn to "soften" it — the colour is the warning.
- Don't reach for the legacy primitives still exported from `ui.tsx` /
  `filters.tsx` (see **Pending items**) when building or restyling a page.

---

## Recipe: add a new dashboard page

1. **Route**: create `apps/web/src/app/dashboard/<name>/page.tsx` as an async
   server component with `export const dynamic = 'force-dynamic'`. `searchParams`
   is a `Promise` in this Next.js version — `const params = await searchParams`
   before reading. Data comes from `getServices()` (`@/lib/services`).
2. **Compose** the page from the new identity: a Spectrum `DataTable` for lists,
   `StatusPill` for status, `<Time>` for timestamps, `ActionForm` +
   `ConfirmSubmit` for mutations.
3. **Nav**: add the entry to the `NAV` array in `apps/web/src/lib/nav.ts`; the
   command bar and mobile sheet read it. Add a chrome-free route to
   `CHROME_FREE_PATHS` if it must render standalone.
4. **Table**: if the page lists rows, create
   `apps/web/src/components/dashboard/<view>-table.tsx` by copying
   `sessions-table.tsx` and swapping the columns.
5. **Tests**: add a co-located page test under
   `apps/web/src/test/dashboard/<name>.test.tsx`.

## Recipe: a destructive action

A server action with `guardAction`, a matching `<CsrfField>`, and a
`<ConfirmSubmit>` wrapping the trigger inside the same `<ActionForm>`:

```tsx
<ActionForm action={revokeToken}>
  <CsrfField form={FORM} />
  <ConfirmSubmit
    tone="danger"
    title="Revoke token"
    description="Revoke this token? This is IRREVERSIBLE. Any agent using it loses access immediately."
    confirmLabel="Revoke token"
  >
    <Button type="button" variant="destructive">
      Revoke
    </Button>
  </ConfirmSubmit>
</ActionForm>
```

Skip confirmation for undelete, unarchive, rename, and create (benign or
trivially reversible).

## Recipe: row navigation

There is no `data-href` / `ROW_LINK` script anymore. Row navigation lives in the
`⋯` menu as a `next/link`:

```tsx
rowActions={(row) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant="ghost" size="icon" aria-label="Row actions">
        <MoreHorizontal className="size-4" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      <DropdownMenuItem asChild>
        <Link href={`/dashboard/sessions/${row.id}`}>View details</Link>
      </DropdownMenuItem>
      {/* destructive items: confirm via ConfirmSubmit inside the ActionForm */}
    </DropdownMenuContent>
  </DropdownMenu>
)}
```

Bulk selection exposes the same actions in the table's rising bulk-action bar.

## Client components

Interactivity is React client components, not inline scripts. The shared ones:

| Component                   | Purpose                                                    |
| --------------------------- | ---------------------------------------------------------- |
| `command-bar.tsx`           | Floating command bar, More dropdown, mobile `Sheet`        |
| `time.tsx`                  | Locale-renders `<time data-rembric-ts>` after mount        |
| `action-form.tsx`           | `ActionForm` + `useActionFormId` for server-action forms   |
| `confirm-submit.tsx`        | Radix `AlertDialog` bound to the enclosing form            |
| `route-tabs.tsx`            | Underline tabs between sibling routes                      |
| `repositories-*.tsx`        | Repositories tab: waiting list, connected list, add dialog |
| `activity-chart.tsx`        | Lime/amber bar chart with hover tooltips                   |
| `spectrumui/data-table.tsx` | List-view engine: search, quick filters, selection, detail |

## Reference files

```
apps/web/src/app/dashboard/layout.tsx              CommandFrame wrapper
apps/web/src/app/dashboard/**/page.tsx             one async server component per route
apps/web/src/components/dashboard/command-bar.tsx  floating command bar + shell
apps/web/src/components/dashboard/sessions-table.tsx  canonical Spectrum data-table
apps/web/src/components/dashboard/ui.tsx           StatusPill, TonePill (live) + legacy primitives
apps/web/src/components/ui/button.tsx              Button variants and sizes (the only button)
apps/web/src/components/ui/alert.tsx               Alert (the only inline message)
apps/web/src/components/dashboard/route-tabs.tsx   RouteTabs
apps/web/src/components/spectrumui/data-table.tsx  shared list-view table engine
apps/web/src/components/dashboard/action-form.tsx  ActionForm + useActionFormId
apps/web/src/components/dashboard/csrf-field.tsx   CsrfField
apps/web/src/components/dashboard/confirm-submit.tsx ConfirmSubmit
apps/web/src/components/dashboard/time.tsx         Time
apps/web/src/components/dashboard/activity-chart.tsx  lime/zinc bar chart
apps/web/src/components/dashboard/support.ts       PAGE_SIZE, queryWithPage, …
apps/web/src/lib/nav.ts                            NAV / NAV_GROUPS / CHROME_FREE_PATHS
apps/web/src/app/globals.css                       Tailwind v4 theme + design tokens
apps/web/src/app/layout.tsx                        Geist / Geist Mono localFont wiring
apps/web/src/test/dashboard/*.test.tsx             per-page tests
.agents/skills/rembric-dashboard-ui/SKILL.md       canonical identity doc (v1.1)
odd/tasks/dashboard-identity-redesign.md           redesign task file (pending items)
```

---

## Superseded identity — brutalist editorial (2026-09 redesign)

**Historical record. Superseded — do not use for new work.**

The identity described in this section governed the Rembric dashboard until the
**2026-09 redesign (branch `feat/dashboard-identity-redesign`)**. It is kept here
so the record of why the surface once looked the way it did is not erased. Every
token, font, and pattern below is **superseded** by the zinc/lime/Geist system
documented above.

The dashboard began as a **brutalist editorial** design system: a near-black
canvas (`#0a0a0a`) with coal cards (`#141414`), a coal-with-lime-tint row hover
(`#15170d`), and iron borders (`#2a2a2a`); hero titles in Space Grotesk, body
copy in Inter, and labels in JetBrains Mono; a `--radius` scale that leaned to
hard 0-radii; and a fixed **196 px sidebar rail** (`196 px`, collapsing to
`56 px`). It was framed as "operational, terse, unambiguous — like an
oscilloscope, not a SaaS landing page," with the `hl-lime` lime-block title
(`REMBRIC <PAGE>.`) as its signature stamp.

**Why it was replaced.** The fixed sidebar rail, the hard-edged zero-radius
primitives, the three-face type stack, and the flat tonal palette read as
heavier and less scannable than the current floating command bar over a layered
zinc surface, and the old surface ladder was too compressed to carry depth
without borders. The redesign (owner-approved, explored in
OpenPencil) moved to a two-face Geist stack, a wider surface ladder with soft
shadows and radial lime glows, a floating shell, and the Spectrum UI
data-table listing model.

Superseded artifacts, retained only as history:

| Superseded token   | Old value | Status in the new identity        |
| ------------------ | --------- | --------------------------------- |
| `primary`          | `#c6f24e` | retained (still the only accent)  |
| `on-primary`       | `#0a0a0a` | replaced by `#09090b`             |
| `neutral`          | `#0a0a0a` | replaced by the background token  |
| `surface`          | `#141414` | replaced by `#101012` (card)      |
| `surface-hover`    | `#15170d` | replaced by `#1c1c1f` (accent)    |
| `on-surface`       | `#f2f2f2` | replaced by `#fafafa`             |
| `on-surface-dim`   | `#9a9a9a` | replaced by `#71717a` (muted)     |
| `on-surface-faint` | `#2a2a2a` | replaced by `#1f1f23` (border)    |
| `warn`             | `#ff8c00` | retained (amber)                  |
| `danger`           | `#ff3344` | replaced by the destructive token |

- **Type**: Space Grotesk (display), Inter (body), JetBrains Mono (labels) —
  all replaced by Geist / Geist Mono.
- **Shell & scripts**: the `.sb` sidebar, `renderPage()`, `shell()`, HTMX,
  `data-href` / `ROW_LINK`, and the inline `TS_UPGRADER` / `MOB_TOGGLE` /
  `SB_COLLAPSE` / `CONFIRM` scripts — the stack was Hono + HTMX + SSR helpers
  under `src/dashboard/`, which no longer exists.
- **Primitives**: `viewHead`, `statCard`, `pager`, the hard-bordered `Pill`,
  `FilterForm` / `Pager`, and the `app-sidebar.tsx` rail — now **LEGACY**
  (see below).

## Pending items

- **Legacy layout primitives still in use.** The settings, activity,
  maintenance and consolidation pages (plus a few detail pages) still compose
  `ViewHead`, `SectionBar`, `StatCard`/`StatGrid`, the legacy `DataTable`
  family, `TableEmpty`, `Bar` and `BackLink` from
  `apps/web/src/components/dashboard/ui.tsx`, and `filters.tsx`
  (`FilterForm`/`Pager`). Their buttons, alerts and pills already use the
  primitives above. When those pages are restyled, move them to the Spectrum
  `DataTable` and the new identity, not to another legacy primitive.
  `Flash`, `Notice`, `Pill`, `ReviewPill`, `Chip`, `MetaGrid` and `MetaRow`
  were removed; use `Alert` and `TonePill`.
- **Formal OpenSpec change pending.** The token unlock has not yet been
  formalized. Until the `dashboard` OpenSpec spec is updated and merged, the
  **live reference is the branch code** — `sessions-table.tsx`,
  `command-bar.tsx`, `activity-chart.tsx`, `ui.tsx`, and `globals.css` — and the
  canonical identity doc is `.agents/skills/rembric-dashboard-ui/SKILL.md`.
  Tracked as task 9 in `odd/tasks/dashboard-identity-redesign.md`. Do not edit
  `openspec/specs/dashboard/spec.md` or archived `design.md` files from UI work;
  that is a separate task.
