---
name: rembric-dashboard-ui
description: |
  Brutalist Rembric dashboard UI work — building / editing / extending pages,
  styles, components, modals, tables, filters, pagination, mobile responsive,
  destructive confirmations. Use when the user asks for changes under
  `apps/web/src/app/dashboard/` or `apps/web/src/components/dashboard/`, mentions
  Rembric design tokens (lime, brutalist, sidebar, view-head, hl-lime), or requests
  a new dashboard page / form / table.
license: MIT
metadata:
  author: Rembric
  version: '1.0'
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
- Anything that mentions: `lime`, `brutalist`, `view-head`, `hl-lime`, `sidebar`,
  `StatCard`, `Kv`, `Pill`, `ConfirmSubmit`, `ActionForm`, `FilterForm`, `Pager`

Do NOT trigger for:

- Server / service / DB / MCP / consolidation backend work
- OpenSpec change scaffolding (use the `openspec-*` skills for that)
- Plugin / hook / CLI / `apps/plugin/` work

## The surface, verified

```
apps/web/src/app/dashboard/layout.tsx          SidebarFrame wrapper (nav, counters, version)
apps/web/src/app/dashboard/**/page.tsx         one async server component per route
apps/web/src/components/dashboard/ui.tsx       design primitives (Page, ViewHead, StatCard, Data* …)
apps/web/src/components/dashboard/filters.tsx   FilterForm/Field/Input/Select/Actions + Pager
apps/web/src/components/dashboard/action-form.tsx   ActionForm + useActionFormId
apps/web/src/components/dashboard/csrf-field.tsx    CsrfField
apps/web/src/components/dashboard/confirm-submit.tsx ConfirmSubmit (AlertDialog ↔ form)
apps/web/src/components/dashboard/app-sidebar.tsx   SidebarFrame + Sidebar rail
apps/web/src/components/dashboard/time.tsx      Time (client, UTC fallback → viewer TZ)
apps/web/src/components/dashboard/support.ts    PAGE_SIZE, queryWithPage, relativeTime, …
apps/web/src/components/dashboard/{markdown-panel,nav-user,site-header}.tsx
apps/web/src/components/ui/*                    shadcn primitives (alert-dialog, button, table, …)
apps/web/src/app/globals.css                    Tailwind v4 theme + design tokens
apps/web/src/lib/nav.ts                         NAV / NAV_GROUPS / navEntryForPath
apps/web/src/lib/utils.ts                       cn()
apps/web/src/test/dashboard/*.test.tsx          per-page tests
```

Pages are **async server components**. `searchParams` is a `Promise` in this
Next.js version — `const params = await searchParams` before reading. Data comes
from `getServices()` (`@/lib/services`) — `const { repos, ... } = getServices()`.

## Design system

`DESIGN.md` at the repo root documents the locked brutalist identity (dark canvas,
lime accent, monospace-forward, flat). Treat it as design intent for token values,
but note its prose predates the Next.js port — it still says "SSR-only (no client
framework)", which is no longer true. **For what actually renders, trust the code**:
`apps/web/src/app/globals.css` is the live token surface, mapped into Tailwind via
`@theme inline` so utilities like `bg-primary`, `text-muted-foreground`,
`border-border`, `bg-card`, `text-warn`, `text-destructive` resolve to the tokens.

Verified token values (`globals.css`): brand lime `--primary: #c6f24e` and amber
`--warn: #ff8c00`, declared identically in `:root` and `.dark`; the rest of the
palette is the stock shadcn theme. Compose classes with `cn()` from `@/lib/utils`.

## Hard rules

- **Use the primitives in `ui.tsx`.** Don't hand-roll markup a primitive already
  covers: `Page`, `ViewHead`, `BackLink`, `SectionBar`, `StatCard`/`StatGrid`,
  `Kv`/`KvGrid`, `Panel`/`PanelHead`, `DataTable`/`DataHead`/`DataTh`/`DataBody`/
  `DataTr`/`DataTd`, `TableEmpty`, `Pill`/`StatusPill`/`ReviewPill`/`Chip`/`Tag`,
  `Bar`, `Notice`, `Flash`, `Time`, and `LABEL`. Tones are `'fg' | 'lime' | 'amber'
| 'dim' | 'danger'`.
- **Tables go through `DataTable`.** It wraps the shadcn `Table` in
  `overflow-x-auto` with a `min-w-[720px]`, which is what keeps wide tables from
  overflowing on mobile. Don't render a bare `<Table>`.
- **Every mutation is a server action through `ActionForm`.** Import
  `ActionForm`/`ActionState` from `@/components/dashboard/action-form`, put a
  `<CsrfField form={FORM_NAME} />` in it, and start the action by calling
  `guardAction(formData, FORM_NAME)`/`guardFailure(...)` from `@/lib/actions/guard`
  (session + admin + CSRF gate). The action returns `{ error: string | null }`.
- **Destructive actions MUST use `ConfirmSubmit`.** It wires a Radix `AlertDialog`
  to the enclosing `ActionForm` via `useActionFormId`, so it only works **inside**
  an `ActionForm`, wrapping the trigger button (`<Button type="button">`). Pass
  `tone="danger"` for irreversible actions, `"warn"` for reversible ones. Mirror
  the call sites under `apps/web/src/app/dashboard/` (e.g. `projects/page.tsx`,
  `judgments/page.tsx`).
- **Timestamps go through `<Time>`.** It emits `<time dateTime data-rembric-ts>`
  with a UTC fallback and re-renders in the viewer's timezone after mount. Never
  hand-write `toISOString` / `toLocaleString` in views.
- **Nav lives in `apps/web/src/lib/nav.ts`.** Add entries to the `NAV` array
  (group, `num`, label, `href`, lucide `icon`, optional `badgeKey`), not to the
  sidebar component.
- **`export const dynamic = 'force-dynamic'`** on dashboard routes/layouts — the
  dashboard reads per-request session + DB state.
- **No new CSS files and no inline `<style>`.** Style with Tailwind utilities
  bound to the tokens in `globals.css`.
- **Page title pattern**: `Rembric <PageName>.` with `hl: 'Rembric'` on `ViewHead`.
  The word REMBRIC renders inside a lime block, the rest in white.
- **`PAGE_SIZE`** (from `support.ts`) is the single page size for paginated
  listings — import it, never hard-code a second one.

## Recipes

- **Add a new page** — create `apps/web/src/app/dashboard/<name>/page.tsx` (an
  async server component with `export const dynamic = 'force-dynamic'`), compose
  it from the `ui.tsx` primitives under a `<Page>`, add the nav entry in
  `apps/web/src/lib/nav.ts`, and add a co-located test in
  `apps/web/src/test/dashboard/`.
- **Destructive action** — server action (`guardAction` + `verifyCsrf`) inside an
  `<ActionForm>`, `<CsrfField>`, and a `<ConfirmSubmit tone="warn|danger"
title=… description=… confirmLabel=…>` wrapping a `type="button"` trigger.
- **Filterable listing** — `FilterForm`/`FilterField`/`FilterInput`/`FilterSelect`
  (GET form) + `Pager` for pagination, with `queryWithPage` building the hrefs.
- **Row navigation** — wrap the target in `next/link`; there is no
  `data-href`/`ROW_LINK` script anymore.

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
pattern (e.g. new column on a table, new pill variant, new destructive button, new
responsive tweak).

Ask the user first when:

- The change introduces a new colour, font face, or radius (a token change, which
  is locked against the OpenSpec dashboard contract).
- The change adds a new top-level nav item (affects the `NAV` array / sidebar order).
- The change touches behaviour: pagination model, modal flow, sidebar collapse
  semantics, mobile drawer behaviour.
- The change would add a new runtime dependency or client-side framework.
- The user's request is ambiguous about destructive vs. reversible tone (`warn` vs
  `danger` is a semantic decision).

## Quick reference: helper signatures

```ts
// ui.tsx
ViewHead({ num?, title, hl?, meta?, titleVisible? })
BackLink({ href, label })
SectionBar({ name, meta?, more? })
StatCard({ k, v, tone?, sub?, href?, className?, compact? })
StatGrid({ children, className?, variant?: 'frame' | 'cards' })
Kv({ k, v, tone?, mono? })
KvGrid({ children, className? })
Panel({ children, className?, padded? })
PanelHead({ eyebrow, title, action?, className? })
DataTable / DataHead / DataTh / DataBody / DataTr / DataTd ({ children, className? })
TableEmpty({ children })
Pill({ children, tone? })   StatusPill({ status })   ReviewPill()   Chip / Tag / Bar / Notice / Flash
Time({ value, className? })   LABEL

// filters.tsx
FilterForm({ action, children, className? })
FilterField({ label, htmlFor, className?, children })
FilterInput({ id, name, value, placeholder? })
FilterSelect({ id, name, value, options })
FilterActions({ clearHref })
Pager({ page, hasMore, total, totalLabel, path, query })

// action-form.tsx
ActionForm({ action, children, className? })   // action: FormAction
useActionFormId()   ActionState = { error: string | null }
```

## Files you will most likely touch

```
apps/web/src/app/dashboard/<view>/page.tsx        server component route
apps/web/src/app/dashboard/layout.tsx             SidebarFrame wrapper
apps/web/src/components/dashboard/ui.tsx          shared primitives (extend when needed)
apps/web/src/components/dashboard/filters.tsx     filters + pager
apps/web/src/components/dashboard/confirm-submit.tsx / action-form.tsx / csrf-field.tsx
apps/web/src/lib/nav.ts                           NAV array + groups
apps/web/src/app/globals.css                      design tokens (Tailwind v4 theme)
apps/web/src/test/dashboard/<view>.test.tsx       co-located page test
DESIGN.md                                          update if you change locked tokens
openspec/specs/dashboard/spec.md                   update via OpenSpec change if a
                                                    load-bearing requirement changes
```

## Validation checklist before "done"

1. `pnpm run typecheck` → clean
2. `pnpm run lint` → clean
3. `pnpm test` → all green
4. `pnpm run build` → succeeds
5. Visual smoke at the affected page in the host dev server, at desktop +
   narrow viewports
6. If a destructive action was added: the dialog opens with the correct tone,
   Cancel doesn't submit, Confirm does
