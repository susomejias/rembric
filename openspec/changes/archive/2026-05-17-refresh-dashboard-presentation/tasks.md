> This change documents work that has already shipped on `main` during the operator session of 2026-05-17. All boxes are pre-checked. The list is retained so a reader scanning the change archive can map each requirement in `specs/dashboard/spec.md` back to a concrete code touchpoint.

## 1. Rename the judgment-queue presentation layer

- [x] 1.1 `git mv src/dashboard/relations.ts src/dashboard/judgments.ts` (history preserved)
- [x] 1.2 Rename exports inside the file: `RelationsDeps` → `JudgmentsDeps`, `createRelationsRouter` → `createJudgmentsRouter`
- [x] 1.3 Update the route mount + import in `src/server/dashboard-router.ts` (`app.route('/judgments', createJudgmentsRouter(...))`)
- [x] 1.4 Replace the three overview hrefs in `src/server/dashboard-router.ts` (pending-judgments stat card, `OPEN ALL ›` link, per-row JUDGE button) to `/dashboard/judgments(...)`
- [x] 1.5 Update the sidebar entry in `src/dashboard/components.ts`: `NavKey` union (`'relations'` → `'judgments'`), `NAV_ICONS` map key, NAV entry `{ key, iconKey, href }`
- [x] 1.6 Update intra-file URLs in `src/dashboard/judgments.ts`: filter CLEAR link, orphan form `action`, post-orphan redirect
- [x] 1.7 Rename CSRF action token from `'relation.orphan'` to `'judgment.orphan'` (issue + verify, both ends in the same file)
- [x] 1.8 Update the `renderPage({ activeNav })` calls in `src/dashboard/judgments.ts` to use `'judgments'`
- [x] 1.9 Update the view CSS bundle: `git mv styles/views/relations.css styles/views/judgments.css`; rebuild the manifest via `pnpm run build:css`

## 2. Refresh the judgment-queue page copy

- [x] 2.1 `viewHead.title`: `Rembric Relations.` → `Rembric Judgments.`
- [x] 2.2 `<title>` via `renderPage(..., { title: 'Judgments' })`
- [x] 2.3 Empty-state cell: `No relations match this filter.` → `No judgments match this filter.`
- [x] 2.4 Column header: `relation` → `verdict`
- [x] 2.5 Flash error: `Relation not found or already closed.` → `Judgment not found or already closed.`

## 3. Refresh the login surface

- [x] 3.1 Replace the `■ REMBRIC` chip with a `.login-brand` flex container holding the transparent logo (`/dashboard/assets/logo-transparent.png`) and the `REMBRIC / SELF-HOSTED` mono labels
- [x] 3.2 Remove the `§ 00 / ACCESS` chip above the headline
- [x] 3.3 Remove `APPEND-ONLY` from the tagline (`SELF-HOSTED · APPEND-ONLY` → `SELF-HOSTED`)
- [x] 3.4 Change the headline from `OPERATOR DASHBOARD.` to `REMBRIC DASHBOARD.` with `REMBRIC` wrapped in `hl-lime`
- [x] 3.5 Remove the redundant `■ ADMIN TOKEN` chip above the input
- [x] 3.6 Remove the three disclosure lines under the submit button (`ADMIN-SCOPED TOKENS ONLY`, `STORED IN HTTPONLY COOKIE`, `PLAINTEXT SHOWN ONLY ONCE IN /TOKENS`)
- [x] 3.7 Add `HERMES` to `.login-stage .clients` between `CODEX CLI` and `MCP CLIENTS`
- [x] 3.8 Add `.login-logo` CSS rule (56 × 56 / 48 × 48 / 40 × 40 across breakpoints) with a subtle lime drop-shadow
- [x] 3.9 Adjust `.login-stage h1 { line-height }` from `0.9` / `0.95` to `1.35` / `1.3` so the lime highlight no longer clips the next line

## 4. Redesign the sidebar `NAV_ICONS` glyphs

- [x] 4.1 `memories`: filled square → outlined two-lobe brain silhouette (`<path>` curves with central fissure + 2 convolutions per hemisphere) — single exception to the all-rectangles rule
- [x] 4.2 `sessions`: 3 horizontal bars → double speech bubble (back outlined + front filled with pixel tail)
- [x] 4.3 `judgments`: dumbbell → balance scales (pomo + post + beam + 2 chains + 2 pans + base, all `<rect>`)
- [x] 4.4 `consolidation`: bordered box + bars → Y-merge (two diagonal `<polygon>` arms + vertical `<rect>` stem + triangular `<polygon>` arrowhead)
- [x] 4.5 `projects`: 4 squares → folder (tab + outlined body + inner document line)
- [x] 4.6 `tokens`: refined key (outlined square bow with keyhole + shaft + 2 teeth)
- [x] 4.7 `maintenance`: bar-chart bars → horizontal wrench (handle + C-shaped open jaw)

## 5. Tests, build, and verification

- [x] 5.1 Update e2e test `src/test/dashboard-e2e.test.ts`: rename the test, change the GET path to `/dashboard/judgments`, change the body assertion to `'Judgments'`
- [x] 5.2 Run `pnpm run typecheck` — passes
- [x] 5.3 Run `pnpm run build` — emits `views/judgments.<hash>.css` and updates the CSS manifest
- [x] 5.4 Spot-check the login page, the sidebar, and `/dashboard/judgments` against the local dev server

## 6. Documentation deltas in this change

- [x] 6.1 `proposal.md` — written
- [x] 6.2 `design.md` — written
- [x] 6.3 `specs/dashboard/spec.md` — delta with ADDED + MODIFIED requirements written
- [x] 6.4 `tasks.md` — this file
- [x] 6.5 `openspec validate refresh-dashboard-presentation --strict` — to be run before merging
