---
name: rembric-dashboard-ui
description: |
  Rembric dashboard UI work (dark monochrome zinc surfaces, lime accent, Geist
  type, Spectrum data-tables) — building / editing / extending pages, styles,
  components, modals, tables, filters, pagination, mobile responsive,
  destructive confirmations. Use when the user asks for changes under
  `apps/web/src/app/dashboard/` or `apps/web/src/components/dashboard/`, mentions
  Rembric design tokens (lime, zinc, command bar, StatusPill, hl-lime, data-table),
  or requests a new dashboard page / form / table.
license: MIT
metadata:
  author: Rembric
  version: '1.1'
---

# Rembric Dashboard UI

Reach for this skill whenever the user wants UI work on the Rembric dashboard
(`/dashboard/*`). The dashboard is a **Next.js App Router + React 19** surface
styled with **Tailwind v4** and **shadcn/Radix** primitives. It is no longer the
Hono/HTMX/SSR-helper stack the old version of this skill described — there is no
`src/dashboard/`, `dashboard-router.ts`, `components.ts`, or `templates.ts`.

## Trigger

Auto-trigger when the user asks for:

- A new dashboard page, route, or view
- Edits to an existing dashboard page (memories, sessions, entities, judgments,
  consolidation, prompts, projects, tokens, maintenance, settings, activity,
  overview, login, OAuth consent)
- New visual components (cards, pills, buttons, banners, modals)
- Mobile / responsive tweaks
- New destructive actions that need confirmation
- New tables, filters, paginators
- Anything that mentions: `lime`, `zinc`, `command bar`, `StatusPill`,
  `data-table`, `hl-lime`, `ConfirmSubmit`, `ActionForm`, `Time`

Do NOT trigger for:

- Server / service / DB / MCP / consolidation backend work
- OpenSpec change scaffolding (use the `openspec-*` skills for that)
- Plugin / hook / CLI / `apps/plugin/` work

## The surface, verified

```text
apps/web/src/app/dashboard/layout.tsx          CommandFrame wrapper (command bar, counters, version)
apps/web/src/app/dashboard/**/page.tsx         one async server component per route
apps/web/src/components/dashboard/command-bar.tsx  CommandFrame + floating CommandBar (no sidebar)
apps/web/src/components/dashboard/sessions-table.tsx  canonical Spectrum data-table usage
apps/web/src/components/dashboard/ui.tsx       StatusPill (canonical) + LEGACY primitives
apps/web/src/components/spectrumui/data-table.tsx   the shared list-view table engine
apps/web/src/components/dashboard/filters.tsx   LEGACY FilterForm/Field/Input/Select/Actions + Pager
apps/web/src/components/dashboard/action-form.tsx   ActionForm + useActionFormId
apps/web/src/components/dashboard/csrf-field.tsx    CsrfField
apps/web/src/components/dashboard/confirm-submit.tsx ConfirmSubmit (AlertDialog ↔ form)
apps/web/src/components/dashboard/app-sidebar.tsx   LEGACY Sidebar rail (only updaterReadState is live)
apps/web/src/components/dashboard/time.tsx      Time (client, UTC fallback → viewer TZ)
apps/web/src/components/dashboard/support.ts    PAGE_SIZE, queryWithPage, relativeTime, …
apps/web/src/components/dashboard/{markdown-panel,nav-user,site-header}.tsx
apps/web/src/components/ui/*                    shadcn primitives (alert-dialog, button, table, …)
apps/web/src/app/layout.tsx                     Geist / Geist Mono localFont wiring (--font-geist*)
apps/web/src/app/fonts/                         self-hosted Geist + Geist Mono woff2
apps/web/src/app/globals.css                    Tailwind v4 theme + design tokens
apps/web/src/lib/nav.ts                         NAV / NAV_GROUPS / navEntryForPath / CHROME_FREE_PATHS
apps/web/src/lib/utils.ts                       cn()
apps/web/src/test/dashboard/*.test.tsx          per-page tests
```

Pages are **async server components**. `searchParams` is a `Promise` in this
Next.js version — `const params = await searchParams` before reading. Data comes
from `getServices()` (`@/lib/services`) — `const { repos, ... } = getServices()`.

## Identity

The dashboard was **redesigned** to a dark monochrome zinc system with the Rembric
lime as the single accent. `apps/web/src/app/globals.css` is the live token
surface, mapped into Tailwind via `@theme inline` so utilities like `bg-background`,
`bg-card`, `bg-popover`, `text-foreground`, `text-muted-foreground`, `border-border`,
`bg-primary`, `text-warn`, `text-destructive` resolve to the tokens.

- **Surfaces (dark monochrome zinc).** Background `#09090b`; cards `#101012`;
  raised / popover / muted / secondary `#18181b`; accent `#1c1c1f`; borders
  `#1f1f23` (1px); input `#27272a`; ring `#3f3f46`. Text ladder: `#fafafa`
  (`--foreground`) → `#a1a1aa` → `#71717a` (`--muted-foreground`).
- **Lime is the ONLY accent.** `--primary: #c6f24e`, `--primary-foreground:
#09090b`. Primary buttons are lime fill + near-black text. On light surfaces
  lime is **chrome only** (fills, borders, dots, bars) — **never lime text on a
  light background**. Amber `--warn: #ff8c00` and `--destructive` stay for warn /
  danger tones; charts use the zinc ladder with lime as `--chart-1`.
- **Fonts.** UI and display output use **Geist** (`--font-geist`, wired to
  `--font-sans` / `--font-display`). **Geist Mono** (`--font-geist-mono`,
  `--font-mono`) owns labels, meta, counters and tabular data. Both are
  self-hosted woff2 in `apps/web/src/app/fonts/` and loaded in
  `apps/web/src/app/layout.tsx`. No CDN fonts, no second display face.
- **Radius & depth.** Radius `--radius: 1rem`: cards `rounded-2xl` (16), inputs
  `rounded-xl` (12), buttons `rounded-lg` (10). Soft shadows only
  (`shadow-lg shadow-black/20`–`shadow-black/40`). Depth comes from **radial lime
  glows** — e.g. `bg-[radial-gradient(640px_260px_at_50%_-60px,rgba(198,242,78,0.09),transparent_70%)]`
  — instead of heavy borders.
- **`StatusPill`** (`ui.tsx`) is the shared app-wide status pill: a
  `rounded-full` container with a dot plus a tinted background/border per tone
  (`TONE_PILL`), driven by the `STATUS_TONE` map (active/judged → lime,
  abandoned/superseded → amber, archived/ended/pending → dim, orphaned/deleted →
  danger). Use it for status, never a hand-rolled badge.
- **List views: Spectrum UI data-table.** Every list/table page goes through
  `DataTable` from `@/components/spectrumui/data-table` (variant `"panel"`):
  quick-filter pills with live counts, client search, selectable rows with a
  rising bulk-action bar, contextual `⋯` row menu, and a detail disclosure.
  **`apps/web/src/components/dashboard/sessions-table.tsx` is the canonical
  implementation** to copy from — see also `judgments-table.tsx`,
  `prompts-table.tsx`, `memories-table.tsx`, `entities-table.tsx`,
  `tokens-table.tsx`.
- **Charts.** `activity-chart.tsx` is the reference for lime/zinc bar visuals:
  lime for saves, amber for superseded/archived ops, rounded caps, hover tooltips
  on `bg-popover` with soft `shadow-black/40`.
- **Shell: floating command bar, no sidebar.** `command-bar.tsx` renders a
  floating centered header (`rounded-2xl border bg-card/90 backdrop-blur`) with
  primary nav, a "More" dropdown, counters and a mobile `Sheet`. There is **no
  sidebar rail**. `/dashboard/login` and `/dashboard/oauth-consent` are
  **chrome-free standalone screens** — `CHROME_FREE_PATHS` in
  `apps/web/src/lib/nav.ts` plus `isChromeFreePath()` short-circuit the frame.

### Pending OpenSpec change

The formal OpenSpec `dashboard` spec update for this identity is **pending**
(branch `feat/dashboard-identity-redesign`). Until it is written and merged, the
**LIVE reference is the branch code** — `sessions-table.tsx`,
`command-bar.tsx`, `activity-chart.tsx`, `ui.tsx` and `globals.css` — **not** the
old spec text or `DESIGN.md`, whose prose still describes the previous brutalist
identity. Do not touch `openspec/specs/dashboard/spec.md` or archived change
`design.md` files from UI work; that is a separate task.

### Legacy primitives (do NOT use for new work)

The old brutalist primitives are still exported from `ui.tsx` and remain in
unrestyled pages (consolidation, maintenance, and several detail pages) pending
migration. Marked **LEGACY**; do not document or copy them as the standard:
`ViewHead`, `SectionBar`, `StatCard`/`StatGrid`, `Kv`/`KvGrid`,
`Panel`/`PanelHead`, `DataTable`/`DataHead`/`DataTh`/`DataBody`/`DataTr`/`DataTd`,
`TableEmpty`, `Pill`/`ReviewPill`/`Chip`/`Tag`, `Bar`, `Notice`, `Flash`. The
hard-bordered `Pill` and the `ViewHead` lime-block title belong to the old
identity. `filters.tsx` (`FilterForm`/`Pager`) and the `app-sidebar.tsx` rail are
legacy too — list pages now use the Spectrum data-table's own toolbar and
pagination. When you restyle a legacy page, replace these with the new identity,
not with another legacy primitive.

## Hard rules

- **New list views use the Spectrum `DataTable`.** Import
  `DataTable`/`DataTableColumn` from `@/components/spectrumui/data-table`, pass
  `variant="panel"`, and mirror `sessions-table.tsx`: `searchable`,
  `quickFilter`, `selectable` + `bulkActions`, `rowActions` (the `⋯` menu),
  `renderDetail`, `pageSize`. Do not hand-roll a table and do not reach for the
  legacy `DataTable` from `ui.tsx`.
- **Use `StatusPill` for status.** One pill, tone-driven, app-wide. Don't invent
  a second status badge.
- **Every mutation is a server action through `ActionForm`.** Import
  `ActionForm`/`ActionState` from `@/components/dashboard/action-form`, put a
  `<CsrfField form={FORM_NAME} />` in it, and start the action by calling
  `guardAction(formData, FORM_NAME)`/`guardFailure(...)` from `@/lib/actions/guard`
  (session + admin + CSRF gate). The action returns `{ error: string | null }`.
- **Destructive actions MUST use `ConfirmSubmit`.** It wires a Radix `AlertDialog`
  to the enclosing `ActionForm` via `useActionFormId`, so it only works **inside**
  an `ActionForm`, wrapping the trigger button (`<Button type="button">`). Pass
  `tone="danger"` for irreversible actions, `"warn"` for reversible ones. Mirror
  the call sites in `sessions-table.tsx` (row `⋯` menu + bulk bar) and under
  `apps/web/src/app/dashboard/`.
- **Timestamps go through `<Time>`.** It emits `<time dateTime data-rembric-ts>`
  with a UTC fallback and re-renders in the viewer's timezone after mount. Never
  hand-write `toISOString` / `toLocaleString` in views.
- **Nav lives in `apps/web/src/lib/nav.ts`.** Add entries to the `NAV` array
  (group, `num`, label, `href`, lucide `icon`, optional `badgeKey`); the command
  bar and its mobile sheet both read it. Chrome-free screens are listed in
  `CHROME_FREE_PATHS` in the same file.
- **`export const dynamic = 'force-dynamic'`** on dashboard routes/layouts — the
  dashboard reads per-request session + DB state.
- **No new CSS files and no inline `<style>`.** Style with Tailwind utilities
  bound to the tokens in `globals.css`.
- **`PAGE_SIZE`** (from `support.ts`) stays the single page size for paginated
  data queries — import it, never hard-code a second one. The Spectrum table's
  `pageSize` prop controls rows per page in the client.

## Recipes

- **Add a new page** — create `apps/web/src/app/dashboard/<name>/page.tsx` (an
  async server component with `export const dynamic = 'force-dynamic'`), compose
  it from the new identity (Spectrum `DataTable` for lists, `StatusPill` for
  status), add the nav entry in `apps/web/src/lib/nav.ts`, and add a co-located
  test in `apps/web/src/test/dashboard/`.
- **Filterable listing** — a `<DataTable>` with `searchable`, `quickFilter`
  (pills keyed on the status column), `selectable` + `bulkActions`, `rowActions`
  for the `⋯` menu, and `pageSize`. Copy `sessions-table.tsx` verbatim, then swap
  the columns.
- **Destructive action** — server action (`guardAction` + `verifyCsrf`) inside an
  `<ActionForm>`, `<CsrfField>`, and a `<ConfirmSubmit tone="warn|danger"
title=… description=… confirmLabel=…>` wrapping a `type="button"` trigger.
- **Row navigation** — the `⋯` menu carries "View details" as a `next/link`; there
  is no `data-href`/`ROW_LINK` script anymore.
- **Chrome-free screen** — if a route must render without the command bar, add it
  to `CHROME_FREE_PATHS` in `lib/nav.ts`; `CommandFrame` short-circuits on
  `isChromeFreePath()`.

## Quick reference: helper signatures

```ts
// spectrumui/data-table.tsx (canonical for list views)
DataTable<T>({
  data, columns, rowId, rowLabel,
  variant?: 'default'|'bordered'|'striped'|'minimal'|'panel', density,
  searchable?, searchPlaceholder?, searchText?,
  quickFilter?: { columnId, label?, getValue?, options?, allLabel? },
  selectable?, bulkActions?: (ctx) => ReactNode,
  renderDetail?: (row) => ReactNode, rowActions?: (row, actions) => ReactNode,
  onDelete?, pageSize?, emptyState?, totals?, stickyHeader?, …
})
DataTableColumn<T>({ id, header, cell?, value?, sortable?, numeric?, hideBelow?, … })

// ui.tsx — LIVE
StatusPill({ status })   Time({ value, className? })   LABEL

// ui.tsx — LEGACY (unrestyled pages only), see Legacy primitives above
ViewHead({ num?, title, hl?, meta?, titleVisible? })   BackLink({ href, label })
SectionBar({ name, meta?, more? })   StatCard / StatGrid   Kv / KvGrid
Panel / PanelHead   DataTable / DataHead / DataTh / DataBody / DataTr / DataTd
TableEmpty   Pill / ReviewPill / Chip / Tag / Bar / Notice / Flash

// filters.tsx — LEGACY
FilterForm({ action, children, className? })   FilterField / FilterInput / FilterSelect
FilterActions({ clearHref })   Pager({ page, hasMore, total, totalLabel, path, query })

// action-form.tsx
ActionForm({ action, children, className? })   // action: FormAction
useActionFormId()   ActionState = { error: string | null }
```

## Files you will most likely touch

```text
apps/web/src/app/dashboard/<view>/page.tsx        server component route
apps/web/src/app/dashboard/layout.tsx             CommandFrame wrapper
apps/web/src/components/dashboard/<view>-table.tsx  Spectrum data-table (copy sessions-table.tsx)
apps/web/src/components/dashboard/command-bar.tsx shared shell / nav (floating, no sidebar)
apps/web/src/components/dashboard/ui.tsx          StatusPill (live) + legacy primitives
apps/web/src/components/dashboard/confirm-submit.tsx / action-form.tsx / csrf-field.tsx
apps/web/src/lib/nav.ts                           NAV array + CHROME_FREE_PATHS
apps/web/src/app/globals.css                      design tokens (Tailwind v4 theme)
apps/web/src/app/layout.tsx                       Geist / Geist Mono localFont wiring
apps/web/src/test/dashboard/<view>.test.tsx       co-located page test
```

## Build, test, validate

After any change:

```bash
pnpm run typecheck   # tsc --noEmit, must be clean
pnpm run lint        # ESLint, must be clean
pnpm test            # turbo test across workspaces, must stay green
pnpm run build       # next build
```

Dashboard component tests are Vitest + Testing Library under
`apps/web/src/test/dashboard/*.test.tsx`; run one file with
`pnpm --filter @rembric/web exec vitest run src/test/dashboard/<name>.test.tsx`.

For visual verification, bring up the host dev server (see `docs/docker.md` →
"Local dev (host)"):

```bash
REMBRIC_DATA_DIR=./data-dev REMBRIC_ADMIN_TOKEN=<16+-char-token> pnpm run dev
# → http://127.0.0.1:3000/dashboard
```

`next dev` hot-reloads, so there is no build-and-restart step. Point a fresh
`REMBRIC_DATA_DIR` at a scratch directory; never aim a dev server at a real
deployment's database.

## When to ask vs proceed

Proceed without asking when the change is mechanical and matches an existing
pattern (e.g. new column on a data-table, new `StatusPill` status mapping, new
destructive row action, new responsive tweak).

Ask the user first when:

- The change introduces a new colour, font face, or radius (a token change). The
  new identity is not yet locked by an OpenSpec spec — the formal `dashboard`
  spec update is pending on `feat/dashboard-identity-redesign` — so token edits
  need an agreed OpenSpec change rather than a drive-by.
- The change adds a new top-level nav item (affects the `NAV` array / command-bar
  order and the mobile sheet).
- The change touches behaviour: pagination model, modal flow, mobile sheet
  behaviour.
- The change would add a new runtime dependency or client-side framework.
- The user's request is ambiguous about destructive vs. reversible tone (`warn` vs
  `danger` is a semantic decision).

## Validation checklist before "done"

1. `pnpm run typecheck` → clean
2. `pnpm run lint` → clean
3. `pnpm test` → all green
4. `pnpm run build` → succeeds
5. Visual smoke at the affected page in the host dev server, at desktop +
   narrow viewports
6. If a destructive action was added: the dialog opens with the correct tone,
   Cancel doesn't submit, Confirm does
