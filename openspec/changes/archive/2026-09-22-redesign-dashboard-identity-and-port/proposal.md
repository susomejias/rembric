## Why

The migration to Next.js has already delivered the surfaces the dashboard will sit on — `packages/{db,core,mcp}` and the ported `/api/<slug>/*` route handlers in `apps/web` — so the operator dashboard is the last large piece still living on `apps/server`'s Hono + HTMX + hand-written-CSS stack. The owner has decided its destination: **identity A (liquid-glass chrome) rendered with shadcn/ui over Tailwind v4, ported to React**. The port cannot start until the capability contract moves with it, because three requirements of `dashboard` are the exact contract that forbids the destination: "Dashboard MUST follow the brutalist visual identity" (tokens locked at `:root`, "Changing any of these tokens SHALL require a new OpenSpec change"), "Dashboard CSS MUST be organised as a layered design system" (`apps/server/src/dashboard/styles/`, two CSS links per page), and "No frontend build pipeline SHALL be required" (no bundler for first-party source, exactly one served third-party JS file, HTMX). This change is that contract move, plus the port it unblocks.

## What Changes

- **BREAKING** (visual identity): the locked brutalist token contract is replaced by the identity-A liquid-glass identity, expressed as CSS custom properties in the shadcn token slots plus a hand-authored glass chrome layer. The dashboard gains a light mode and a dark mode (`.dark` class); the previous requirement shipped "a single dark theme" and forbade a light theme, a theme switcher and per-user settings.
- **BREAKING** (capability contract): the CSS-organisation contract moves from `apps/server/src/dashboard/styles/{core,views}/` with two content-hashed links per page to Tailwind v4 (CSS-first `@theme`) plus shadcn/ui components copied into `apps/web/src/components/ui/`. The `views/<view>.css` per-route file rule is retired. The HTML-whitespace-minification requirement is retired (JSX emits no inter-tag whitespace) and the "no frontend build pipeline" requirement is replaced by the stack it prohibited.
- **BREAKING** (theme mechanism): mutations move from hand-rolled CSRF tokens on forms to Server Actions with framework origin/host verification; the `data-confirm*` attribute protocol and its HTMX rebind are replaced by a React confirmation dialog that preserves the `warn`/`danger` tone semantics; the timestamp upgrader and the other five inline scripts (`TS_UPGRADER`, `MOB_TOGGLE`, `SB_COLLAPSE`, `ROW_LINK`, `CONFIRM`, `MD_COPY`) are replaced by client components and Server Actions.
- **BREAKING** (self-update): the in-process self-upgrade orchestrator leaves the served application. Docker owns the swap by pulling the new image and the TUI installer owns it for non-Docker deployments, so the one-click update action, the update-progress view and the version-polling endpoint are retired; the version badge, the update-availability check, the changelog modal and the manual check remain, with the `available` branch rendering the copy-paste upgrade path instead of an in-app trigger.
- The 13 dashboard views — home (overview), memories, sessions, prompts, judgments, consolidation, projects, tokens, maintenance, update, entities, oauth-consent, login — are ported to `apps/web/src/app/dashboard/**` as React Server Components, one route per commit, each view green before the next. `apps/server/src/server/dashboard-router.ts` (876 lines), `apps/server/src/dashboard/**` (including `components.ts`'s 30 HTML-string helpers, `templates.ts`'s six inline scripts and the 3,819 lines of CSS) and the dashboard's Hono routes are deleted once their view is ported.
- The dashboard's per-view behavioural contracts are preserved verbatim — server-side filtering and pagination, true filtered totals, review-state derivation, judgment ordering, maintenance counts and purge journaling, Markdown rendering with raw HTML disabled, scope filters, and every escaping rule. The plan SHALL delete hand-rolled machinery rather than transliterate it.
- The dashboard application adopts the Next process model: bootstrap (database open plus migrations), admin-token bootstrap, session reaper and embedder drain move into `instrumentation.ts`'s `register()`; the consolidation sweep remains a throttled service call in the request path (no cron is introduced, and none is removed); the embedder stays lazily dynamic-imported and `/models` reaches the process through the image's `COPY` step.
- Data safety is a gate on the cutover, not a guideline: DS1–DS6 from `odd/tasks/migrate-to-nextjs.md` continue to govern, and no phase of this change may point `apps/web` and `apps/server` at the same `REMBRIC_DATA_DIR`.
- **Unchanged**: the `/mcp` route (owner decision, zero adaptation; the same `packages/mcp` serves both apps during the transition), the already-ported `/api/<slug>/*` surface, the `packages/{db,core,mcp}` boundaries, and the load-bearing invariants — append-only memory (no `DELETE`, no `content` `UPDATE`; the two purge escape hatches stay journaled and admin-gated), scope enforced at the service layer, `topic_key` convergence, and fresh-context judgment. No migration file is added, edited, renamed or renumbered (DS6).

## Capabilities

### New Capabilities

None. The redesign and the port are the same capability re-expressed: the `dashboard` capability owns the operator surface, its identity, its CSS organisation and its view behaviours, and every requirement this change adds or rewrites lands in that one capability.

### Modified Capabilities

- `dashboard`: rewritten visual-identity requirement (brutalist tokens → identity-A liquid-glass theme tokens), the layered-CSS-organisation requirement **removed and replaced** by a three-layer styles requirement (hand-written `core/*.css` + one file per route + two links per page → Tailwind v4 `@theme`, owned shadcn components, and one hand-authored glass layer), a rewritten content-hashing requirement, a rewritten font requirement (`@font-face` from `/dashboard/assets/fonts/` → `next/font/local` with hashed, preloaded output), the served-asset-origin requirement re-anchored to the framework's static-asset paths, the mutation protection and destructive-confirmation requirements re-expressed on Server Actions and a React dialog, the timestamp requirement re-expressed as a client component, the row-navigation requirement re-expressed on React links, the escaping requirement re-anchored on React's text-children boundary, the update-modal requirement's `available` branch re-expressed as a deployment-layer upgrade path, plus the removal of the requirements the port makes false ("No frontend build pipeline SHALL be required", "Dashboard HTML MUST be whitespace-minified in production", the layered-CSS-organisation requirement, and the two one-click-update requirements) and new requirements for the shadcn stack, the three-layer styles system, the shared data-table composition, the theme token slots, the glass layer, the Server Action mutation contract, the scoped React Query islands, the UI-mechanism translation table, the `instrumentation.ts` bootstrap and the removal of the scheduler/self-upgrade orchestrator from the served application.

## Impact

This change relocates the operator dashboard and rewrites its visual contract. It does NOT alter: append-only memory (no `DELETE`, no `content` `UPDATE`; both purge hatches stay journaled and admin-gated), scope-at-service, `topic_key` convergence, or judgment freshness. The data-access confinement boundary is unchanged — the ported views read through `@rembric/core` services and `admin*` repository reads exactly as `apps/server/src/dashboard/` does today, and no SQL moves into `apps/web`.

### Files created

- `apps/web/src/app/dashboard/**` — `layout.tsx`, `page.tsx` and one route per view: `memories/{page.tsx,[id]/page.tsx}`, `sessions/{page.tsx,[id]/page.tsx}`, `prompts/`, `judgments/{page.tsx,[id]/page.tsx}`, `consolidation/{page.tsx,[id]/page.tsx}`, `projects/`, `tokens/`, `maintenance/`, `update/`, `entities/`, `oauth/consent/`, `login/`
- `apps/web/src/app/globals.css` — Tailwind v4 `@import 'tailwindcss'` plus the `@theme`/`@layer` token declarations and the `.dark` block
- `apps/web/src/styles/glass.css` (or an equivalent `@utility`/`@layer components` block in `globals.css`) — the hand-authored liquid-glass chrome layer
- `apps/web/src/components/ui/**` — the shadcn components the port adopts (owned, editable copies)
- `apps/web/src/components/dashboard/**` — the React replacements for `apps/server/src/dashboard/components.ts` (sidebar, mobile bar, view head, stat card, kv grid, section bar, table primitives, filters, pager, flash, pills, back link, markdown body, confirm dialog, timestamp)
- `apps/web/src/lib/actions/**` — the Server Actions replacing the dashboard-router mutation handlers
- `apps/web/instrumentation.ts` — `register()`: database open plus migrations, admin-token bootstrap, session reaper, embedder drain
- `apps/web/components.json`, `apps/web/src/lib/utils.ts` — shadcn CLI configuration and the `cn` helper
- `apps/web/src/app/fonts/*.woff2` — the self-hosted brand fonts consumed by `next/font/local`

### Files edited

- `apps/web/package.json` — `tailwindcss` v4, `@tailwindcss/postcss`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, `@tanstack/react-query`, the adopted `@radix-ui/*` packages
- `pnpm-workspace.yaml` — the lifecycle-script inventory and the install cooldown review for those dependencies
- `pnpm-lock.yaml`, `apps/web/postcss.config.mjs`, `apps/web/tsconfig.json`
- `apps/web/next.config.ts` — only if the port's font/asset path requires it
- `apps/web/src/app/layout.tsx` — root shell, font variables, theme class
- `apps/web/src/lib/db.ts` — consumed from `instrumentation.ts` rather than only from route handlers
- `apps/server/src/server/http.ts`, `apps/server/src/server/bootstrap.ts` — stop mounting the dashboard and stop owning the moved bootstrap steps once their ported counterparts ship
- `apps/server/src/version.ts` or its consumer — the version the ported brand block renders
- The dashboard test files under `apps/server/src/dashboard/*.test.ts` (15 files, 98 `expect(html…)` assertions) — rewritten against the React components, or deleted with the view they assert

### Files deleted

- `apps/server/src/dashboard/**` — all 13 view modules, `templates.ts`, `components.ts`, `page-shell.ts`, `csrf.ts`, `assets.ts`, `parse.ts`, `styles/**` (3,819 CSS lines), `public/assets/**`, and the view test files
- `apps/server/src/server/dashboard-router.ts` (876 lines)
- `apps/server/scripts/build-css.mjs` (128 lines) and its `package.json`/`copy-assets.mjs` wiring
- `apps/server/src/dashboard/public/assets/htmx.min.js`
- The self-upgrade orchestrator module and its dashboard route, once the update view is ported

### Files deliberately NOT touched

- `apps/server/src/mcp/**` and `packages/mcp/**` — `/mcp` is unchanged by this change
- `apps/web/src/app/api/**` — the session-lifecycle and recall surface is already ported
- `packages/db/src/migrations/**` — no migration file is added, edited, renamed or renumbered (DS6)
- `apps/server/src/dashboard/sessions-xss.test.ts` (regression #252) — it SHALL REMAIN: React escapes text children, but rendered Markdown still requires `dangerouslySetInnerHTML`
