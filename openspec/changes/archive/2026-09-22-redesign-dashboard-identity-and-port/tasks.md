# Tasks — redesign-dashboard-identity-and-port

Ordering is load-bearing: no view is ported before the theme exists, no old file is deleted before its replacement is green, and the mutation-protection probe (2.5) runs before the first view because every view depends on its outcome. Block and component choices per view come from `design.md` D10; the identity contract comes from `specs/dashboard/spec.md`.

## 1. Stack initialisation and theme (`apps/web`) — no view ported

- [ ] 1.1 Consult `.agents/skills/npm-security-best-practices/` before editing any manifest; record the decision for every new dependency (cooldown against `pnpm-workspace.yaml::minimumReleaseAge: 4320`, `blockExoticSubdeps`, and whether any needs a lifecycle entry).
- [ ] 1.2 Initialise Tailwind v4 and shadcn in `apps/web`: `components.json`, `postcss.config.mjs`, `@import 'tailwindcss'` plus the `@theme` block in `apps/web/src/app/globals.css`, and `apps/web/src/lib/utils.ts` exposing `cn`. Confirm `pnpm --filter @rembric/web run build` exits 0.
- [ ] 1.3 Adopt the component set the port needs by copying it into `apps/web/src/components/ui/**`, pruned per `design.md` D10; confirm the manifest declares no runtime component library, no `@dnd-kit/*` and no `@tabler/icons-react`, and that `@tanstack/react-table`, `class-variance-authority`, `clsx`, `tailwind-merge` and `lucide-react` are present.
- [ ] 1.4 Declare the theme tokens in `globals.css` — the shadcn semantic set, the brand `--primary` lime fill, the olive-family light-surface accent, the warn/danger roles, the three font variables and the `--glass-*` slots — in `:root` plus `.dark`; add a test asserting the declaration exists exactly once and that no retired brutalist token name (`--bg`, `--lime-ink`, `--f-grotesk`-style family aliases) survives anywhere in the tree.
- [ ] 1.5 Hand-author the liquid-glass layer (a `@layer components` block or `apps/web/src/styles/glass.css`) with the `@supports not (backdrop-filter: blur(1px))` opaque fallback, consuming only `--glass-*` and semantic tokens.
- [ ] 1.6 Move the brand fonts into `apps/web` and wire `next/font/local` to the theme's font variables; confirm no request is issued to `fonts.googleapis.com` or any other host, and that the built output contains hashed woff2 files.
- [ ] 1.7 Give `apps/web` a test runner (vitest config plus a `test` script) so the ported view tests run under the root `pnpm test` Turborepo task graph.
- [ ] 1.8 Green gate for the stack: `pnpm --filter @rembric/web run typecheck`, `pnpm --filter @rembric/web run build`, the token test from 1.4 and the font check from 1.6 all pass, and one page renders a shadcn component, a glass surface and the font variables in both modes.
- [ ] 1.9 Commit the initialisation as one work unit, recording the installed versions and the cooldown decision from 1.1.

## 2. Layout shell and the mutation-protection probe

- [ ] 2.1 Adopt the `sidebar-07` collapsible block (its provider, trigger, inset, nav-group/nav-item with badges and the user area); confirm the provider's mobile sheet replaces the custom mobile bar, and delete nothing from `apps/server` yet.
- [ ] 2.2 Port the navigation table to a typed module with the same entries, keys, ordering and badges — including `PROMPTS` between `SESSIONS` and `JUDGMENTS` — and a test pinning the order.
- [ ] 2.3 Implement the persisted collapse contract: read `rbr-sb-collapsed` (`Path=/dashboard`, `SameSite=Lax`) server-side into the first render, and expose the toggle as a Server Action that flips the cookie and returns to the originating page; test that the server-rendered markup reflects the cookie, and that a submission failing the mutation protection is refused with `403` without flipping it.
- [ ] 2.4 Port the shared primitives: view head, back link, stat/section cards, kv grid, filter controls, pager, flash, the badge set (status, review, verdict, RAW), the confirmation dialog, the Markdown body with its copy control, the timestamp component, and the shared data-table composition whose sort/filter/page controls drive the URL (design D10).
- [ ] 2.5 Run the mutation-protection probe: a cross-origin submission to a Server Action that must be refused, plus a same-origin control that must succeed. Record the command and both observed outcomes. If equivalence to the retired session token is not observed, keep a session-bound token checked inside the action boundary and say so in the design's D4 entry.
- [ ] 2.6 Green gate: the shell renders, the primitives' unit tests pass, and the probe transcript from 2.5 is recorded in the change's verification notes.

## 3. memories (list + detail)

- [ ] 3.1 Port `/dashboard/memories` onto the shared data-table composition: the review column as a badge, `needs_review` filtering with the TTL pushed into SQL, server-side pagination, the `TOTAL`/`SHOWING` header contract and its `N+` lower-bound case, and the sanitized FTS branch redisplaying the operator's original text.
- [ ] 3.2 Port `/dashboard/memories/[id]` as Card + Tabs + state badge: heading from `title` with the id as a metadata chip, `last_seen_at`/`reviewState`/`reviewAfter`, the predecessor `replaces` chain, the forward "Superseded by" link, and the judgments section ordered by the shared relations comparator (not a second ordering rule).
- [ ] 3.3 Rewrite `memories-totals`, `memory-detail-hub`, `fts-search-robustness` and the memory parts of `list-showing` against the React components in `apps/web`; the replaced assertions are deleted with the view they described.
- [ ] 3.4 Delete the memories routes from `apps/server/src/server/dashboard-router.ts`, the view module `apps/server/src/dashboard/memories.ts` and `apps/server/src/dashboard/styles/views/memories.css` (plus its `build-css.mjs` view registration).
- [ ] 3.5 Green gate: `pnpm --filter @rembric/web run typecheck` and the ported memories suites pass; `grep -rn "memory-detail-hub\|memories-totals" apps/server/src` returns only the deleted-file diff.

## 4. sessions (list + detail)

- [ ] 4.1 Port `/dashboard/sessions` onto the data-table composition: the title cascade, separate memory/prompt count columns, active-first ordering applied in SQL before `LIMIT`, the project/agent/status filters, the `include_deleted` toggle, and the inline Abandon control declared with its tone/sentence/label per the confirmation contract.
- [ ] 4.2 Port `/dashboard/sessions/[id]`: metadata block, description and curated summary as Markdown, an uncurated summary as escaped preformatted text with the RAW badge, the `Memories (N)` table before the `Prompts (N)` table, and the token-name `(revoked)` suffix.
- [ ] 4.3 Rewrite `sessions-filters`, `sessions-resume` and `session-detail-curation` against the React components; keep `sessions-xss.test.ts` (regression #252) and re-point it at the ported view's Markdown boundary.
- [ ] 4.4 Delete the sessions routes from the dashboard router, the view module and `styles/views/sessions.css`.
- [ ] 4.5 Green gate: the ported sessions suites pass, and the XSS suite fails when the Markdown parser's `html: false` is weakened (mutation check).

## 5. prompts

- [ ] 5.1 Port `/dashboard/prompts` onto the data-table composition: the title cascade, project slug, session link, agent, tags and created columns, the sanitized `prompts_fts` search, the `Delete`/`Undelete` actions with their confirmation declarations, and the `REFINED` badge rule.
- [ ] 5.2 Replace the HTMX `<details>` expansion with a client-side inline expansion of long content, so no detail route is introduced.
- [ ] 5.3 Rewrite `prompts-totals` against the React components.
- [ ] 5.4 Delete the prompts route from the dashboard router, the view module and `styles/views/prompts.css`.
- [ ] 5.5 Green gate: the ported prompts suite passes; the search box redisplaying `what's the plan?` verbatim is asserted.

## 6. judgments

- [ ] 6.1 Port `/dashboard/judgments` onto the data-table composition: the `verdict` column via the shared badge component, the source → target anchors, the title labels, the `created`-cell link to the detail view and the `Mark orphaned` action with its confirmation declaration.
- [ ] 6.2 Port `/dashboard/judgments/[id]`: stat strip, Source/Target Markdown, Reason as a plain paragraph, Evidence as preformatted JSON, and the closed-state "no actions available" line.
- [ ] 6.3 Rewrite `judgments.test.ts` against the React components, including the legacy `/dashboard/relations` 404 and the verdict-pill reuse assertion.
- [ ] 6.4 Delete the judgments routes from the dashboard router, the view module and `styles/views/judgments.css`.
- [ ] 6.5 Green gate: the ported judgments suite passes; the not-found path returns the standard dashboard 404 body.

## 7. consolidation

- [ ] 7.1 Port `/dashboard/consolidation` as SectionCards (consolidation health, thresholds derived from the configured orphaning values, last-run scope rendered as a project slug) plus the runs list.
- [ ] 7.2 Port `/dashboard/consolidation/[id]`: per-op reasoning, `Undo` per op and `Undo entire run`, the legible sweep-summary rendering with its raw fallback, and the manual-sweep trigger with its `warn` confirmation declaration.
- [ ] 7.3 Rewrite `consolidation.test.ts` against the React components.
- [ ] 7.4 Delete the consolidation routes from the dashboard router, the view module and `styles/views/consolidation.css`.
- [ ] 7.5 Green gate: the ported consolidation suite passes, including the forced-sweep action's protection check.

## 8. projects

- [ ] 8.1 Port `/dashboard/projects` onto the data-table composition with archived rows badged, the create action as a Server Action in a Dialog, and the archived-project slug resolution.
- [ ] 8.2 Rewrite `projects-default.test.ts` against the React components.
- [ ] 8.3 Delete the projects route from the dashboard router, the view module and `styles/views/projects.css`.
- [ ] 8.4 Green gate: the ported projects suite passes.

## 9. tokens

- [ ] 9.1 Port `/dashboard/tokens` onto the data-table composition: the scope/project/created/revoked/expires columns, project slugs resolved by name (never ids), set-token enumeration in slug-ascending order, the five-state precedence, and the revoke action with its `danger` confirmation declaration.
- [ ] 9.2 Port the mint form as a Server Action using the `Field` primitives: the `project` multi-selection plus the `access` selector, the refusal of a retired `scope` field and of an absent/unrecognised `access`, and the one-time plaintext view stating the minted scope and every reached slug.
- [ ] 9.3 Port the tokens view tests (there is no dedicated file today: the assertions live in the template/component suites) and pin the state-precedence table.
- [ ] 9.4 Delete the tokens route from the dashboard router, the view module and `styles/views/tokens.css`.
- [ ] 9.5 Green gate: the ported tokens suite passes, including both refusal paths creating no row.

## 10. maintenance

- [ ] 10.1 Port `/dashboard/maintenance` as Cards: the DB breakdown (`dbstat` aggregation, freelist), the three purge cards with their fresh per-GET counts and disabled-at-zero copy, and the backup card with the `VACUUM INTO` snapshot and authenticated download.
- [ ] 10.2 Port the three purge actions as Server Actions gated by admin scope and the mutation protection, each re-running its predicate inside the delete transaction, each journaled in `consolidation_ops`, each confirmed through the `danger`-tone AlertDialog; keep the redirect-plus-flash contract.
- [ ] 10.3 Rewrite `maintenance.test.ts` against the React components, keeping the `403`-before-service-call and the count-grew-between-render-and-click cases.
- [ ] 10.4 Delete the maintenance routes from the dashboard router, the view module and `styles/views/maintenance.css`.
- [ ] 10.5 Green gate: the ported maintenance suite passes; no maintenance action is reachable without a resolved admin scope.

## 11. update (version check and badge only — the orchestrator is retired)

- [ ] 11.1 Port the version line into the shell's brand block, with the update badge when a newer version is known and the quiet link to `/dashboard/update` otherwise, and nothing when the check is disabled.
- [ ] 11.2 Port `/dashboard/update`: the up-to-date state, the manual check action with its honest "still up to date" / "check unreachable" / "check disabled" outcomes, and the per-version dismissable modal with the changelog and the capability-appropriate deployment-layer path.
- [ ] 11.3 Delete the in-process self-upgrade orchestrator, its dashboard route, and the update-progress and version-polling endpoints; confirm no route answers on them.
- [ ] 11.4 Rewrite the update assertions from the component/template suites against the React components, including that no capability state renders an in-app update trigger.
- [ ] 11.5 Delete the update routes from the dashboard router, the view module, `update-modal.ts` and `styles/views/update.css`.
- [ ] 11.6 Green gate: the ported update suite passes, and `grep -rn "update-progress\|upgrade" apps/web/src/app` returns no route.

## 12. entities

- [ ] 12.1 Port the entity view onto the data-table composition: entity kind and linked-memory count columns, sort by count, the single-reference filter, and every row naming its project slug with no `global` label.
- [ ] 12.2 Rewrite `entities.test.ts` against the React components, keeping the cross-project row and no-`GLOBAL` assertions.
- [ ] 12.3 Delete the entities route from the dashboard router, the view module and `styles/views/entities.css`.
- [ ] 12.4 Green gate: the ported entities suite passes.

## 13. oauth-consent

- [ ] 13.1 Port the consent view as a server-rendered Card + Button whose decision control is a form `POST` to the authorization endpoint — no Server Action, no client-side JavaScript requirement.
- [ ] 13.2 Rewrite `oauth-consent.test.ts` against the React components, asserting the protocol `POST` shape.
- [ ] 13.3 Delete the consent route from the dashboard router, the view module and `styles/views/oauth-consent.css`.
- [ ] 13.4 Green gate: the ported consent suite passes, and the view renders and submits with client JavaScript disabled.

## 14. login

- [ ] 14.1 Port `/dashboard/login` on the `login-01` split layout with the Rembric brand mark, the version line, the admin-token form (labelled input plus primary submit) and the client footer in its canonical order ending with the generic `MCP CLIENTS` entry.
- [ ] 14.2 Rewrite the login assertions against the React components, keeping the non-vacuous footer test (extract the labels, assert the extracted list is non-empty first, then compare against the single canonical list) and the no-redundant-chips assertions.
- [ ] 14.3 Delete the login route from the dashboard router, its view module and `styles/views/login.css`; keep the `/dashboard/assets/**` images reachable from the application's public tree.
- [ ] 14.4 Green gate: the ported login suite passes; deleting one client label from the canonical list reds the footer test (mutation check).

## 15. home (overview)

- [ ] 15.1 Port `/dashboard` on the `dashboard-01` composition: the SectionCards stat strip in its declared order, the area-chart sparkline, the recent-judgments tile with the shared verdict badge and `VIEW →` link, the recent-sessions tile, the consolidation-health section, and the sidebar-link contract for `OPEN ALL ›`.
- [ ] 15.2 Delete the home route from `apps/server/src/server/dashboard-router.ts` and `styles/views/home.css`.
- [ ] 15.3 Rewrite the home assertions from the template/component suites against the React components in `apps/web`.
- [ ] 15.4 Green gate: the ported home suite passes, and the stat strip renders exactly six cards with no `PENDING JUDGMENTS` card.

## 16. Process model in `apps/web`

- [ ] 16.1 Add `apps/web/instrumentation.ts` with `register()` opening the database (migrations run inside the factory) and logging the resolved absolute database path plus whether the file pre-existed; test both the fresh and pre-existing cases (DS1).
- [ ] 16.2 Move the admin-token bootstrap, the session reaper and the embedder drain into `register()`, and remove them from `apps/server`'s bootstrap once its dashboard stops being served.
- [ ] 16.3 Confirm no scheduler, interval or timer performs consolidation or any other background mutation in the served process, and that the sweep is reachable only through the request path.
- [ ] 16.4 Confirm the embedder is not imported at boot (lazy dynamic import) and that the model assets reach the process through the image's copy step.
- [ ] 16.5 Green gate: the application starts, logs the database path and provenance, applies migrations, and reports no embedder import before a request needs one.

## 17. Delete the dead machinery and close residual references

- [ ] 17.1 Delete `apps/server/src/server/dashboard-router.ts`, the whole `apps/server/src/dashboard/**` tree (view modules, `templates.ts`, `components.ts`, `page-shell.ts`, `csrf.ts` only if the probe in 2.5 showed equivalence, `assets.ts`, `parse.ts`, `styles/**`, `public/assets/**`), `apps/server/scripts/build-css.mjs` with its `package.json` and `copy-assets.mjs` wiring, and the vendored HTMX bundle; confirm no remaining import references them.
- [ ] 17.2 Rewrite or delete the remaining dashboard test files (`templates.test.ts`, `components.test.ts`, `parse.test.ts`, the remainder of `list-showing.test.ts`): each assertion dies with the view it described, and `sessions-xss.test.ts` REMAINS.
- [ ] 17.3 Close the residual requirement references the delta deliberately left untouched — `data-href` in "The dashboard MUST surface a sessions list view at `/dashboard/sessions`", the `judgment.orphan` CSRF action token and `hl-lime` in "The judgment-queue view MUST be served at `/dashboard/judgments`", the `data-confirm*`/CSRF wording in "The dashboard MUST surface an Abandon action for active sessions", the HTMX `<details>` toggle in "The dashboard MUST surface a prompts list view at `/dashboard/prompts`", the `components.ts::NAV` anchor in "The dashboard sidebar MUST include a `PROMPTS` entry", the `:root` token clause in "Tokens MUST be manageable from the dashboard", and `hl-lime` in the login brand requirement — by modifying each requirement to name the React mechanism that replaced it.
- [ ] 17.4 Green gate: `pnpm run typecheck`, `pnpm run lint` and `pnpm test` pass with the old dashboard gone, and `node scripts/check-delta-freshness.mjs` still passes after 17.3's spec edits.

## 18. Cutover preparation (operator-only unless noted)

- [ ] 18.1 (operator-only) Take a `VACUUM INTO` snapshot before the new code applies any migration against a real data directory; record the snapshot path and size (DS5).
- [ ] 18.2 (operator-only) Run the seeded-volume smoke: mount a volume seeded with a known row, boot the image, read that row back through the running container, and record the transcript with hostnames and paths redacted (DS3).
- [ ] 18.3 (operator-only) Repoint the deployment and confirm `apps/web` and `apps/server` never share a `REMBRIC_DATA_DIR` and never run on the same port (DS4); confirm the container does not create an empty `data.db` in its ephemeral layer.
- [ ] 18.4 Produce DS6 evidence that no migration file was added, removed, edited, renumbered or renamed: list the migration directory before and after and record the filenames plus content-hash comparison.
- [ ] 18.5 (operator-only) Retire `apps/server` after the cutover window, including its release component and image wiring, as its own reviewed change.
- [ ] 18.6 (operator-only) Run the installer e2e per the `rembric-tui-installer-e2e` playbook before the cutover is announced.

## 19. Verification

- [ ] 19.1 `pnpm run typecheck` exits 0 from the repository root.
- [ ] 19.2 `pnpm test` is green, excluding only the two pre-existing `bridge.test.ts` failures documented as environmental in `odd/tasks/migrate-to-nextjs.md`.
- [ ] 19.3 `pnpm run lint` and `pnpm run format:check` exit 0.
- [ ] 19.4 `openspec validate redesign-dashboard-identity-and-port --strict` passes.
- [ ] 19.5 `node scripts/check-delta-freshness.mjs`, `node scripts/check-delta-sections.mjs` and `node scripts/check-spec-crossrefs.mjs` pass.
- [ ] 19.6 (operator-only) The production image builds from the monorepo root and the container boots with the volume mounted, logging the resolved database path and its provenance.

## 20. Recurring maintenance

- [ ] 20.1 Recurring: merge `main` into `migrate/nextjs` and rerun the suite after each merge, since `release-please` keeps moving `main` while this branch lives.
