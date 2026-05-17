---
name: rembric-dashboard-ui
description: |
  Brutalist Rembric dashboard UI work — building / editing / extending pages,
  styles, components, modals, tables, filters, pagination, mobile responsive,
  destructive confirmations. Use when the user asks for changes under
  `src/dashboard/`, mentions Rembric design tokens (lime, brutalist, sidebar,
  view-head, hl-lime), or requests a new dashboard page / form / table.
license: MIT
metadata:
  author: Rembric
  version: '1.0'
---

# Rembric Dashboard UI

Reach for this skill whenever the user wants UI work on the Rembric
dashboard (`/dashboard/*`). The **single source of truth** is
`DESIGN.md` at the repo root — a Google-spec-compliant DESIGN.md file
(`npx @google/design.md lint DESIGN.md` passes 0 errors / 0 warnings).
Read it before writing CSS or HTML.

## Trigger

Auto-trigger when the user asks for:

- A new dashboard page, route, or view
- Edits to an existing dashboard page (memories, sessions, relations,
  consolidation, projects, tokens, overview, login)
- New visual components (cards, pills, buttons, banners, modals)
- Mobile / responsive tweaks
- New destructive actions that need confirmation
- New tables, filters, paginators
- Anything that mentions: `lime`, `brutalist`, `view-head`, `hl-lime`,
  `sidebar`, `mob-bar`, `appendOnly banner`, `pending judgments queue`,
  `recent sessions timeline`, `consolidation health`, `stat card`,
  `kv-grid`, `tbl-host`, `dialog.modal`, `data-confirm`, `data-href`

Do NOT trigger for:

- Server / service / DB / MCP / consolidation backend work
- OpenSpec change scaffolding (use `openspec-*` skills for that)
- Plugin / hook / CLI / `bin/` work
- Anything outside `src/dashboard/` + `src/server/dashboard-router.ts`

## Mandatory first step

Before touching any UI code, do this in order:

1. **Read `DESIGN.md` (repo root) end to end.** It contains the YAML
   token frontmatter (colors, typography, spacing, rounded, components)
   and prose covering Overview, Colors, Typography, Layout, Elevation &
   Depth, Shapes, Components, Do's and Don'ts. The Rembric-specific
   recipes at the bottom show the canonical patterns for new pages,
   destructive actions, and row navigation.

2. **Skim the four CSS layer files** so you know what's already there:

   ```
   src/dashboard/styles/core/tokens.css     CSS variables + @font-face
   src/dashboard/styles/core/atoms.css      .pill .btn .inp .flash .tag .bn …
   src/dashboard/styles/core/layout.css     .app .sb .mob-bar .view-head
   src/dashboard/styles/core/patterns.css   .stat .grid-7 .tbl .filters .pager …
   src/dashboard/styles/core/content.css    bare element defaults inside .main
   ```

3. **Check `src/dashboard/components.ts`** for existing SSR helpers:
   `viewHead`, `backLink`, `statCard`, `pager`, `btn`, `flash`,
   `sectionBar`, `filtersBar`, `sel`, `inp`, `kv`, `kvGrid`,
   `sparkline`, `renderSidebar`, `renderMobileBar`, `NAV`, `NAV_ICONS`,
   `urlWithPage`, `PAGE_SIZE`.

4. **Check `src/dashboard/templates.ts`** for the shell + scripts:
   `shell`, `html`, `raw`, `escape`, `formatTs`, `statusPill`,
   `scopePill`, `shortId`, plus the inline scripts `TS_UPGRADER`,
   `MOB_TOGGLE`, `SB_COLLAPSE`, `ROW_LINK`, `CONFIRM`.

5. **Check `src/dashboard/page-shell.ts`** — `renderPage(c, sessions,
body, opts)` is the canonical entry point for every authenticated
   page.

## Hard rules (from DESIGN.md "Do's and Don'ts")

These are not stylistic preferences — break them and the dashboard
spec breaks too.

- **Use CSS custom properties from `tokens.css` only.** Never raw hex,
  never raw `px`. (`var(--lime)`, `var(--s-4)`.)
- **Wrap every `<table>` in `<div class="tbl-host">`** so it scrolls
  horizontally inside its container. Naked `<table>` overflows the
  page on mobile.
- **Use `renderPage()` for authenticated routes** — never call
  `shell()` directly except in the login handler and the home handler.
- **Mark every destructive form with `data-confirm`**: archive memory,
  archive project, mark orphaned, undo op → `data-confirm-tone="warn"`;
  delete session, revoke token, undo entire run →
  `data-confirm-tone="danger"`. Skip for undelete / unarchive / rename /
  create.
- **Row navigation via `<tr data-href="…">`** — never add a separate
  "OPEN ›" button alongside it. The link inside the ID cell coexists
  for keyboard / right-click use.
- **No inline `<style>`** in templates beyond one-off content-driven
  values (sparkline data array, a width %).
- **No localStorage** for UI state. Cookies are the rule
  (`rbr-sb-collapsed` is the precedent).
- **No `border-radius`, no `box-shadow`.** Shape language is square,
  depth is tonal + 1-px borders only.
- **No CDN at runtime.** Vendor fonts, HTMX, favicons.
- **No client-side JS framework.** Plain HTMX + tiny vanilla scripts
  in `templates.ts`. Add a new script there, not as a separate JS file.
- **Page title pattern**: `Rembric <PageName>.` with `hl: 'Rembric'`
  on `viewHead`. The word REMBRIC renders inside a lime block, the
  rest in white.
- **`PAGE_SIZE = 10`** for all paginated listings (memories, sessions,
  relations, consolidation). Import from `components.ts`.

## Recipes

The recipes are pasted in full inside `DESIGN.md` under the
"Rembric-specific extensions" header. Copy them verbatim; don't
re-invent.

- **Add a new page** — view CSS file + route handler + mount + nav
  entry + e2e test.
- **Destructive action** — `<form data-confirm data-confirm-label
data-confirm-tone>` + matching `<button class="warn|danger">`.
- **Row navigation** — `<tr data-href="/dashboard/…">` + keep the
  `<a>` inside the ID cell.

## Build, test, validate

After any change:

```bash
pnpm run typecheck   # tsc --noEmit, must be clean
pnpm run lint        # ESLint, must be clean
pnpm test            # 319+ tests, must stay green
pnpm run build       # full build (tsc + copy-assets + build:css)
```

For visual verification with the running dev server:

```bash
# server already booted on :18787 with admin token in /tmp/rembric-dev-token.txt
pnpm run build:css   # regenerate hashed CSS bundles + manifest.json
# kill + restart the start process if you changed any handler:
pkill -f 'node dist/server-entrypoint.js'
REMBRIC_ADMIN_TOKEN=$(cat /tmp/rembric-dev-token.txt) \
  REMBRIC_PORT=18787 \
  REMBRIC_DATA_DIR=$(cat /tmp/rembric-dev.env | cut -d= -f2) \
  CONSOLIDATION_ENABLED=false EMBEDDING_ENABLED=false OPENAI_API_KEY=dummy \
  pnpm start > /tmp/rembric-dev.log 2>&1 &
```

After significant token / structure changes to `DESIGN.md`:

```bash
npx --yes @google/design.md lint DESIGN.md
```

Must report `errors: 0, warnings: 0`.

## When to ask vs proceed

Proceed without asking when the change is mechanical and matches an
existing pattern (e.g., new column on a table, new pill variant, new
destructive button, new responsive tweak).

Ask the user first when:

- The change introduces a new colour, font face, or radius (any of
  these is a token change and locks against the OpenSpec contract).
- The change adds a new top-level nav item (affects the `NAV` array
  - sidebar order).
- The change touches behaviour: pagination model, modal flow, sidebar
  collapse semantics, mobile drawer behaviour.
- The change would require a new JS framework or runtime dependency.
- The user's request is ambiguous about destructive vs. reversible
  tone (`warn` vs `danger` is a semantic decision).

## Quick reference: helper signatures

```ts
viewHead({ num: string, title: string, hl?: string, meta?: Array<{k, v}> })
backLink({ href: string, label: string })
statCard({ k: string, v: number|string|SafeHtml, tone?: 'fg'|'lime'|'warn'|'danger'|'dim', sub?: SafeHtml|string, href?: string })
btn({ variant?: 'primary'|'secondary'|'warn'|'danger', size?: 'sm', label: string, href?: string, type?: 'submit'|'button' })
flash({ tone: 'lime'|'warn'|'danger'|'success'|'error', label: string, body: SafeHtml|string })
sectionBar({ name: string, meta?: SafeHtml|string, more?: SafeHtml|string })
pager({ page: number, hasMore: boolean, pageHrefBuilder: (p)=>string, totalLabel?: string })
kv({ k: string, v: SafeHtml|string|number, tone?: ..., mono?: boolean })
kvGrid(items: SafeHtml[])
sparkline(data: number[])
sel(name: string, options: Array<{value, label, selected?}>, opts?: { grow?: boolean })
inp(name: string, value: string, placeholder: string, opts?: { type?: string, grow?: boolean, autofocus?: boolean, size?: 'lg' })
urlWithPage(currentUrl: string, page: number)
formatTs(d: Date|string|number|null|undefined)
shortId(id: string|null|undefined)
statusPill(status: string)
scopePill(scope: string)
renderPage(c, sessions, body, { title, activeNav, view?, counters?, flash? })
```

## Files you will most likely touch

```
src/dashboard/<view>.ts                 route handler (existing or new)
src/dashboard/components.ts             SSR helpers (add a new one if needed)
src/dashboard/templates.ts              shell + inline scripts
src/dashboard/page-shell.ts             renderPage()
src/dashboard/styles/core/*.css         tokens / atoms / layout / patterns / content
src/dashboard/styles/views/<view>.css   per-page extension
src/server/dashboard-router.ts          mounting + home handler
src/dashboard/csrf.ts                   csrfInput + readFormAndVerifyCsrf
DESIGN.md                               update if you change tokens
openspec/specs/dashboard/spec.md        update via OpenSpec change if you
                                         change a load-bearing requirement
```

## Validation checklist before "done"

1. `pnpm run typecheck` → clean
2. `pnpm run lint` → clean
3. `pnpm test` → all green
4. `pnpm run build` → succeeds, hashed CSS in `dist/dashboard/public/assets/styles/`
5. If you touched `DESIGN.md`: `npx --yes @google/design.md lint DESIGN.md`
   → 0 errors, 0 warnings
6. Visual smoke: open at least the affected page in dev server,
   confirm at desktop + ≤980 px + ≤640 px viewports
7. If destructive action added: click the button, confirm the modal
   opens with the correct tone, Cancel doesn't submit, Confirm does
