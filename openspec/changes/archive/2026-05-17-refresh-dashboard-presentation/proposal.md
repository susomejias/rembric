## Why

The dashboard's presentation layer had drifted from its own nomenclature: the sidebar already said `JUDGMENTS` but the URL, file, function, CSS bundle, page title, table column, and CSRF action all called it `relations`. The login screen carried legacy copy from before Rembric supported three plugin clients (`OPERATOR DASHBOARD`, `APPEND-ONLY` tagline, no Hermes in the client footer) and had typographic bugs (the lime `OPERATOR` pill clipped the next line because `line-height: 0.9` made the line-box smaller than the glyph height). The sidebar icons were generic geometric shapes that did not communicate the domain (the "memories" icon was a solid square; "maintenance" looked like a bar chart). This change cleans up all three in one pass so the spec, URL, code, and copy line up with what the operator actually sees.

## What Changes

- **Rename the presentation layer for the judgment queue from `relations` to `judgments`** (the underlying DB table `memory_relations`, the service `RelationsService`, and the MCP `relations-tools` keep their names — those are the domain entity; the judgment is the lifecycle event over it).
  - URL: `/dashboard/relations` → `/dashboard/judgments`
  - Module: `src/dashboard/relations.ts` → `src/dashboard/judgments.ts` (via `git mv`)
  - Exports: `createRelationsRouter` → `createJudgmentsRouter`; `RelationsDeps` → `JudgmentsDeps`
  - View CSS bundle: `styles/views/relations.css` → `styles/views/judgments.css` (renamed; the CSS manifest resolves the new bundle automatically because the view key is derived from `activeNav`)
  - Sidebar `NavKey`: `'relations'` → `'judgments'`; `NAV_ICONS.relations` → `NAV_ICONS.judgments`; nav entry `key + iconKey + href`
  - Page copy: `Rembric Relations.` → `Rembric Judgments.`; `<title>` `Relations · Rembric` → `Judgments · Rembric`; empty state `No relations match this filter.` → `No judgments match this filter.`; column header `relation` → `verdict`; flash error `Relation not found or already closed.` → `Judgment not found or already closed.`
  - CSRF action token: `'relation.orphan'` → `'judgment.orphan'`
  - E2E test renamed and re-asserted

- **Refresh the login surface** (`renderLogin` + `styles/views/login.css`)
  - Replace the legacy `■ REMBRIC` chip with the transparent Rembric logo (`/dashboard/assets/logo-transparent.png`) placed in the top-left brand block at 56 / 48 / 40 px across desktop / tablet / phone
  - Remove the `§ 00 / ACCESS` chip above the headline
  - Remove `APPEND-ONLY` from the tagline (now `SELF-HOSTED`)
  - Change the headline from `OPERATOR DASHBOARD.` to `REMBRIC DASHBOARD.` (with `REMBRIC` in `hl-lime`)
  - Remove the redundant `■ ADMIN TOKEN` chip (the `<label>` on the input already covers it)
  - Remove the three "ADMIN-SCOPED TOKENS ONLY / STORED IN HTTPONLY COOKIE / PLAINTEXT SHOWN ONLY ONCE IN /TOKENS" disclosure lines under the submit
  - Add `HERMES` to the client footer (left of `MCP CLIENTS`)
  - Fix `line-height` on `.login-stage h1` (`0.9` → `1.35` desktop, `0.95` → `1.3` mobile) so the lime highlight box no longer clips the next line

- **Redesign all eight sidebar nav icons** (`NAV_ICONS` in `components.ts`)
  - **memories**: filled square → outlined two-lobe brain silhouette (uses `<path>` with curves; the only icon that breaks the all-rectangles convention because a 16-px brain is unreadable otherwise)
  - **sessions**: three horizontal bars → double speech bubble (back outlined, front filled with a pixel tail)
  - **judgments** (was `relations`): dumbbell → balance scales (top knob, post, beam, two chains, two pans, base — all rectangles)
  - **consolidation**: bordered rect with bars → downward Y-shape with two diagonal arms converging into a vertical stem topped by an arrowhead (uses `<polygon>` for the diagonals)
  - **projects**: 4 squares (visually identical to `overview`) → folder (tab + outlined body + inner document line)
  - **tokens**: refined key (outlined square bow with keyhole + shaft + two teeth)
  - **maintenance**: bar-chart bars → horizontal wrench (handle + C-shaped open jaw)

## Capabilities

### New Capabilities

<!-- none — this is a refresh, not a new capability -->

### Modified Capabilities

- `dashboard`: The judgment-queue view's canonical URL becomes `/dashboard/judgments` (was `/dashboard/relations`); the spec's existing reference to the "relations list" timestamp surface is updated; the spec's sidebar requirement keeps its existing nav labels (which already said "Judgments") and gains a clarifying URL mapping. No behavioural / authz / data requirement changes.

## Impact

- **Affected code (presentation only)**: `src/dashboard/components.ts` (NavKey union, NAV entry, NAV_ICONS map), `src/dashboard/page-shell.ts` (no edits — the view manifest resolves the renamed CSS via `activeNav`), `src/dashboard/judgments.ts` (renamed from `relations.ts`), `src/dashboard/styles/views/judgments.css` (renamed from `relations.css`), `src/dashboard/styles/views/login.css`, `src/server/dashboard-router.ts` (login template + import + mount + three overview hrefs), `src/test/dashboard-e2e.test.ts`.
- **Unaffected**: DB schema (`memory_relations` stays), Drizzle migrations, services (`RelationsService`, `MemoryService`, `ProjectsService`, `TokensService`, …), MCP tools (`mcp/relations-tools.ts`, `mcp/tools.ts`), background workers (consolidation, embeddings), plugin manifests (Claude / Codex / Hermes), CLI subcommands, append-only invariants, fresh-context judgment flow.
- **Externally visible**:
  - The route `/dashboard/relations` no longer responds; any operator bookmark on the old URL hits the dashboard 404 (no redirect — internal app, no public links).
  - The login URL/route is unchanged; only the visible copy and brand mark change.
  - No client / MCP / API contract is touched. Existing tokens, sessions, judgments, and memories continue to work without re-auth or migration.
- **Tests**: e2e dashboard test renamed; typecheck and `pnpm run build` (TS + CSS manifest) pass. No new tests; no test removed.
