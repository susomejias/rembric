## Context

The owner decided (2026-09-20) the dashboard's destination in one move: **identity A (liquid-glass chrome) rendered with shadcn/ui over Tailwind v4, total redesign, React port of every view**. That decision is recorded in `odd/tasks/migrate-to-nextjs.md` under "UI STACK (owner decision, 2026-09-20)", and it supersedes an earlier hand-rolled-CSS recommendation under the governing objective ("maximum framework leverage, best possible end state") — the CSS rewrite is work the identity redesign does anyway.

The predecessor change `extract-workspace-packages` delivered the packages this one builds on (`packages/{db,core,mcp}`), the Turborepo task graph, and — through the earlier scaffold commit `dc1ed6f0` and the ported `/api/<slug>/*` surface — a `apps/web` that already opens the same database, traces the native bindings and the migrations directory, and serves the session-lifecycle contract. What remains on `apps/server` is the dashboard: 13 views, 876 lines of Hono router, 734 lines of HTML-string component helpers, 550 lines of template shell with six inline scripts, and 3,819 lines of CSS across six `core/*.css` files and thirteen `views/*.css` files.

The blocker is a spec-level one, not a scheduling one. Three requirements of the `dashboard` capability are the exact contract that forbids the destination:

- **"Dashboard MUST follow the brutalist visual identity"** — tokens locked at `:root`, `--bg: #0a0a0a`, `--lime: #c6f24e`, and the sentence _"Changing any of these tokens SHALL require a new OpenSpec change"_; a single dark theme, no light theme, no theme switcher.
- **"Dashboard CSS MUST be organised as a layered design system"** — source files under `apps/server/src/dashboard/styles/{core,views}/`, one `views/<view>.css` per route, two content-hashed links per page, no `<style>` in the body.
- **"No frontend build pipeline SHALL be required"** — no bundler or transpiler over first-party source, exactly one served third-party JS file (HTMX), first-party client JS inline and under 2 KB per script, no client-side framework or component system.

The port cannot begin until those three are moved, and moving them is this change's first deliverable. Two further constraints outrank the rest, inherited from the migration brief: **no data loss, ever** (DS1–DS6), and **delete, do not transliterate** (the port removes hand-rolled machinery rather than re-implementing it in React).

## Goals / Non-goals

### Goals

- Rewrite the dashboard capability's identity, CSS-organisation and front-end-stack contract to the identity-A liquid-glass identity on shadcn/ui over Tailwind v4.
- Port all 13 views (home, memories, sessions, prompts, judgments, consolidation, projects, tokens, maintenance, update, entities, oauth-consent, login) to `apps/web/src/app/dashboard/**`, one route per commit, each green before the next.
- Preserve every behavioural contract the ported views carry: server-side filtering and pagination, true filtered totals, review-state derivation and its badge, judgment ordering via the shared comparator, maintenance counts and journaled purges, Markdown rendering with raw HTML disabled, escaping of user-supplied text, and the scope-filter vocabulary.
- Delete the hand-rolled machinery once its replacement ships: `apps/server/src/server/dashboard-router.ts`, the 13 view modules, `templates.ts`, `components.ts`, `page-shell.ts`, `csrf.ts`, the CSS tree, `build-css.mjs`, the vendored HTMX bundle, and the dashboard's Hono routes.
- Move the process model into `apps/web`: `instrumentation.ts` `register()` owns bootstrap (database open plus migrations, proven in the standalone smoke), the admin-token bootstrap, the session reaper and the embedder drain; the consolidation sweep stays a request-path service call; the in-process self-upgrade orchestrator leaves the served application.
- Keep the data-safety contract in force: DS1–DS6 gate the cutover, no phase points both apps at one `REMBRIC_DATA_DIR`, and no migration file changes.

### Non-goals

- No change to `/mcp` (owner decision, zero adaptation) or to the already-ported `/api/<slug>/*` surface. `packages/mcp` serves both applications unchanged.
- No change to the load-bearing invariants: append-only memory, scope-at-service, `topic_key` convergence, judgment freshness, or the SQL-confinement boundary (no SQL enters `apps/web`).
- No new capability. The redesign and the port are one capability re-expressed; nothing here creates a second dashboard-like surface.
- No destructive migration, and no edit, renumbering or rename of any migration file (DS6).
- No redesign of `apps/landing` — it stays static and untouched.
- No `packages/brand` extraction. The duplicated brand fonts move into `apps/web` for `next/font/local`; sharing fonts with `apps/landing` remains the recorded deferred opportunity, not part of the port.

## Decisions

### D1 — shadcn/ui over Tailwind v4, components copied into the app

**Chosen.** Tailwind v4 in CSS-first form (`@import 'tailwindcss'` plus `@theme`) and shadcn/ui with its components **copied** into `apps/web/src/components/ui/`. The repo owns and edits them. Supporting pure-JS dependencies: `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, and the `@radix-ui/*` packages the adopted components require.

**Alternative A — hand-write the CSS system (the earlier recommendation).** A 3,819-line CSS rewrite into a new identity, keeping the existing `components.ts` string helpers and the Hono shell. Rejected by the owner: it is the same work the identity redesign performs anyway, and it keeps a hand-rolled layout system where a component library already exists.

**Alternative B — a component library with a runtime dependency (MUI, Chakra, Mantine).** Rejected: those libraries ship their own theme engine and their own styling layer, so adopting one means replacing the theme system instead of expressing the palette in it, and their default visual language fights the glass identity rather than accepting it as a layer. shadcn's components are source, not a runtime, and its theming is CSS variables — which is exactly the shape the colour theme needs.

**Alternative C — headless primitives only (Radix) with hand-written styles.** Rejected: it discards shadcn's component layer (the largest part of "maximum component use") while paying the same Radix dependency cost.

**Alternative D — keep HTMX and restyle only.** Rejected: the port to `apps/web` is the change's purpose; restyling the Hono surface would make the CSS work disposable.

**[Trade-off]** Tailwind's utility vocabulary forks the styling system away from the named, spec-pinned class vocabulary (`.pill`, `.stat`, `.tbl`, `.filters`, `.kv-grid`). → Accepted because the rewrite _is_ the redesign: the spec pins those names only because the current contract does, and the new contract pins components and theme tokens instead.

**[Trade-off]** Copied components have no upstream upgrade path; a shadcn release does not reach this repo by `pnpm update`. → Accepted because "the repo owns the component" is the property being bought; upgrades become deliberate diffs against the upstream template.

### D2 — the glass chrome is hand-authored CSS layered over the theme

**Chosen.** The identity-A glass layer (`backdrop-filter` plus saturation, translucent surfaces, specular edge highlights) is a hand-authored utility/component layer in `apps/web/src/styles/` (or an equivalent `@layer components` block in `globals.css`) sitting **above** shadcn's token theming. No library provides it, and none SHALL be adopted to provide it. The layer SHALL define its own variables (`--glass-*`) so glass surfaces can be retuned without editing components, and SHALL degrade when `backdrop-filter` is unsupported.

**Alternative A — a glass-morphism library or a Tailwind plugin.** Rejected: the requirement is a small, specific surface treatment; a dependency for it adds supply-chain risk, a cooldown window, and a version to track, in exchange for a handful of declarations the repo can own.

**Alternative B — bake the glass into the shadcn theme tokens themselves (make `--card` translucent).** Rejected: shadcn's tokens carry semantic roles (a card is a card, in either mode); making every card translucent removes the ability to use an opaque surface where legibility demands one, and it welds the identity to a single visual trick.

**Consequence — the layer is not the sole carrier of information.** Glass may express hierarchy, never state: status, tone and confirmation semantics keep their colour and text carriers, including on surfaces where the fallback applies.

### D3 — RSC-first, with React Query limited to scoped islands

**Chosen.** Route components under `apps/web/src/app/dashboard/**` are React Server Components that read through `@rembric/core` services and `admin*` repository reads, exactly as today's dashboard handlers do. Mutations are Server Actions. `@tanstack/react-query` is adopted **only** for islands that need client-side state over time: the update-progress/version polling, incremental (as-you-type) search, and optimistic toggles. Data-dense tables stay server-rendered.

**Alternative A — a client-side SPA (the whole dashboard as client components).** Rejected: it moves filtering, pagination and totals into the browser, which is precisely where the current contract's guarantees live (server-side filtering, true filtered totals, correct pagination with the review-state TTL pushed into SQL). It also discards the framework's data path.

**Alternative B — a global client store (Redux/Zustand) plus fetch-on-mount.** Rejected: it makes the client cache a second source of truth for data the server already owns, and creates exactly the cache-coherence problem the dashboard's filter/pagination contract would have to re-solve.

**Alternative C — no client data library at all.** Rejected: polling the update-progress endpoint and debounced search would be hand-rolled `setInterval` and `AbortController` code — the class of machinery this port is deleting.

**[Trade-off]** Two data paths exist in one app (RSC reads, React Query islands), so a reviewer must know which one a given screen uses. → Accepted because the island list is enumerable and fixed by the spec (polling, search, optimistic actions), and the alternative is a single-but-wrong path.

### D4 — Server Actions for mutations, and a CSRF equivalence that is NOT yet verified

**Chosen.** Every dashboard mutation becomes a Server Action invoked from a React form: validated at the action boundary, executed against the same service call the Hono route makes today, `revalidatePath` after success, form-state errors (`useActionState`) instead of rendered flash pages, and redirect-plus-query-param flashes preserved where an action returns to a list.

**The verification this decision depends on, stated honestly.** Today's mutation protection is hand-rolled: `apps/server/src/dashboard/csrf.ts` mints and checks a per-session token, and the dashboard capability's "Mutating dashboard requests MUST be CSRF-protected" requirement is what enforces it. Server Actions are POST requests to the same origin and Next verifies origin/host for them. **Whether that verification is equivalent to the hand-rolled token has NOT been measured.** The requirement's rewrite in this change is a statement of intent, not evidence, and it SHALL NOT be cited as evidence. Concretely:

- The probe SHALL be behavioural and SHALL include a control: a cross-origin POST to a Server Action SHALL be rejected (failing case), and the same-origin POST SHALL succeed (control). A failing case alone cannot distinguish a real guard from a broken probe.
- **If the equivalence cannot be demonstrated, `csrf.ts` and its token SHALL stay** — a hand-rolled token inside the action boundary is a legitimate outcome, and it is strictly better than a spec that claims a protection nobody measured.
- The token vocabulary is part of the surface being replaced: current action tokens include `judgment.orphan`, `session.abandon`, `prompt.delete` and `prompt.undelete`, and at least two untouched requirements name them. This is tracked as spec debt under R7.

**Alternative A — keep the Hono mutation routes and have React forms POST to them.** Rejected: it keeps a second HTTP surface alive inside a framework that already owns form submission, and it forces the ported app to keep carrying the old router.

**Alternative B — Server Actions plus the existing CSRF token mechanism transplanted.** Kept as the fallback in the paragraph above; not the primary path because it perpetuates machinery the framework may already provide, but it is the honest fallback rather than an unverified claim.

### D5 — `next/font/local` replaces `@font-face`

**Chosen.** The brand fonts move into `apps/web` (`apps/web/src/app/fonts/*.woff2`) and are loaded through `next/font/local`, exposing Space Grotesk, Inter and JetBrains Mono as CSS variables wired into the shadcn font tokens.

**Alternative A — keep the fonts under `public/` and hand-write `@font-face` in `globals.css`.** Rejected as a regression on a measured point: Next's `public/` is not content-hashed, so the current requirement's `Cache-Control: public, max-age=31536000, immutable` promise could only be kept by keeping a bespoke header rule. `next/font/local` hashes, self-hosts, preloads and eliminates layout shift, and it needs no header configuration.

**Alternative B — a font package (`next/font/google` locally mirrored, or a `@fontsource` package).** Rejected: the fonts are already committed byte-identically in the tree (the recorded `packages/brand` observation), and a font package adds a dependency plus an install-time fetch in exchange for files the repo already has.

**[Trade-off]** The fonts are duplicated again — `apps/server/src/dashboard/public/assets/fonts/` and `apps/web/src/app/fonts/` — until `apps/server` is retired. → Accepted because `apps/server` keeps serving the live dashboard through the transition, and the deferred `packages/brand` extraction is the correct fix once one consumer remains.

### D6 — the port order: shell, then one view per commit, memories first

**Chosen.** (1) Tailwind v4 plus shadcn initialisation and the theme tokens; (2) the layout shell (sidebar, mobile bar, view head, table/filter primitives, confirm dialog, timestamp component); (3) the 13 views one route per commit, **memories first** (the largest and the one that owns filters, pagination, true totals, review state and the search sanitizer), then sessions, prompts, judgments, consolidation, projects, tokens, maintenance, update, entities, oauth-consent, login, home. Each route lands with its own deletion commit for the corresponding Hono route and view module once it is green.

**Alternative A — port everything then delete.** Rejected: it produces one enormous diff with no intermediate green state, which is the review-workload failure this migration has been guarding against.

**Alternative B — build all shared components first, then all views.** Partially adopted: the shell phase is exactly this, but it is bounded to the primitives the first view provably needs. Building the full primitives inventory before any view is guessing at component APIs from a spec rather than deriving them from a live screen.

**Alternative C — port by domain (all session-related screens, then all memory-related screens).** Rejected: routing and layout are shared across domains, so slices would touch the same shell repeatedly and land partial navigation.

### D7 — the process model moves to `instrumentation.ts`, with no scheduler and no in-app updater

**Chosen.**

- **Bootstrap → `apps/web/instrumentation.ts` `register()`.** Next's once-per-boot hook replaces `apps/server/src/server/bootstrap.ts`: open the database (migrations run inside `createDb`; the standalone smoke already applied all 37), log the resolved absolute database path and whether the file pre-existed (DS1), then the admin-token bootstrap, the session reaper, and the embedder drain.
- **Consolidation sweep → no cron.** There is nothing to port: the sweep is deterministic and throttled on session activity by design, and its trigger is a service call in the request path. The ported routes fire it exactly as today. If a time-based sweep is ever wanted it is a separate script plus an OS scheduler — not invented here, and not placed in a Next route where it would be a second, unaccounted scheduler.
- **Updater → split, and the orchestrator leaves the app.** The version check (badge, availability, changelog modal, manual check) ports as a server-side read. The self-upgrade orchestrator is deleted from the served application: in the primary distribution (Docker) the upgrade is pulling the new image, and in the TUI flow `install.sh` owns the swap at the deployment layer. The one-click action, the progress view and the version-polling endpoint retire with it. The consequence for the two-shot process is recorded as a spec removal, not left implicit.
- **Embedder → unchanged in shape.** Lazy dynamic import, fired when a route needs embeddings; `/models` reaches the process through the image's `COPY` step (absolute path, immune to tracing).

**Alternative A — a Next route handler on a timer, or `setInterval` inside `register()`.** Rejected: a scheduler hidden inside the web process is unreviewable, duplicates work across replicas, and turns a documented "no cron" design into an accidental one.

**Alternative B — keep the orchestrator, running in a sidecar process.** Rejected for this change: it multiplies the process model during a migration whose whole point is to reduce surface, and the Docker/TUI layers already own the swap.

**[Trade-off]** Operators on a non-Docker, non-TUI deployment lose the in-app one-click update. → Accepted because a process that replaces its own container while serving is the fragile path, and `docs/updates.md` plus the modal's copy-paste command remain the documented route.

### D8 — the identity is specified as token slots, not as new hardcoded hexes

**Chosen.** The rewritten identity requirement SHALL name the token **slots** — the shadcn semantic set (`--background`, `--foreground`, `--card`, `--border`, `--primary`, `--ring`, `--radius`, the font variables), the semantic `warn`/`danger` roles, and the glass layer's own variables (`--glass-*`) — plus the roles the retained brand colours occupy (`--primary` as the lime brand fill, unchanged from the current contract; a light-surface text accent in the olive family). It SHALL NOT hardcode the glass surfaces, because the glass palette is **not decided**. The exact values are finalised at implementation against the design reference and recorded once, in `globals.css`.

**Alternative A — freeze the full identity-A palette as hexes in the spec now.** Rejected: it would invent values the owner has not chosen and then immediately make them spec-locked, which is the failure mode of the requirement being replaced. The old contract's "changing any of these tokens requires a new OpenSpec change" is not carried over.

**Alternative B — copy the brutalist hexes across unchanged.** Rejected: it would freeze the old identity under a new heading.

### D10 — Blocks and components per view (the port's block map)

**Measured registry facts** (measured against the v4 registry, `https://ui.shadcn.com/r/styles/new-york-v4/`, and recorded as a decision input by the owner's block-mapping decision; not re-measured while authoring this change): all 15 `sidebar-NN` blocks resolve; `dashboard-01` resolves; `dashboard-02` … `dashboard-07` return 404 in the v4 registry — they are docs-only compositions and SHALL NOT be referenced as blocks; `login-01` … `login-05` resolve; `signup-01` resolves. `dashboard-01` ships `page.tsx`, `data.json`, `app-sidebar`, `chart-area-interactive`, `data-table` (TanStack), `nav-{documents,main,secondary,user}`, `section-cards` and `site-header`; its dependency set is `@dnd-kit/*`, `@tabler/icons-react`, `@tanstack/react-table` and `zod`, and its registry dependency list is `sidebar, breadcrumb, separator, label, chart, card, select, tabs, table, toggle-group, badge, button, checkbox, dropdown-menu, drawer, input, avatar, sheet, sonner`.

**Chosen map (block → view):**

| View                | Block / components                                                                      | Note                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| shell / navigation  | `sidebar-07` collapsible (AppSidebar, NavMain, NavUser, badges)                         | the provider's mobile `Sheet` replaces the custom mobile bar and its inline drawer script |
| home (`/dashboard`) | `dashboard-01` — SectionCards (stat strip), ChartAreaInteractive (sparkline), DataTable | the recents table is a capped set, so the block's client-side mode is legitimate here     |
| memories list       | `dashboard-01` DataTable (TanStack) with `needs_review` as a Badge                      | table state driven by the URL (see the resolution below)                                  |
| memory detail       | Card + Tabs + state Badge                                                               | the `replaces` chain and the judgments section become cards/tabs inside the page          |
| sessions list       | DataTable                                                                               |                                                                                           |
| session detail      | Card + Markdown summary + turns list                                                    | the escaped-`<pre>` RAW pattern for an uncurated summary is preserved verbatim            |
| judgments           | DataTable                                                                               | verdict via the shared badge component                                                    |
| prompts             | DataTable                                                                               | inline expansion replaces the HTMX `<details>` toggle                                     |
| projects            | DataTable + Dialog (create) + Badge (archived)                                          |                                                                                           |
| entities            | DataTable                                                                               | cross-project rows, each naming its project slug                                          |
| tokens              | DataTable + mint form (Server Action + `Field` primitives)                              | the one-time plaintext view stays a server-rendered card                                  |
| consolidation       | SectionCards (health) + runs list                                                       |                                                                                           |
| maintenance         | Card + AlertDialog for the destructive purges                                           |                                                                                           |
| update              | Card + version Badge                                                                    | orchestrator gone (D7); the modal keeps changelog + manual path                           |
| oauth-consent       | server-rendered Card + Button                                                           | protocol surface: a form `POST` to the authorization endpoint, no client JS (see D3/D4)   |
| login               | `login-01` (split layout) with the Rembric brand mark                                   | the client footer list and its non-vacuous test are preserved                             |

**Prune decisions (measured).** `@dnd-kit/*` is NOT adopted — the dashboard has no drag interaction. `@tabler/icons-react` is NOT adopted — `lucide-react` is the shadcn default and every adopted component already uses it. `@tanstack/react-table` IS adopted: the data tables are the majority of the dashboard's surface. `react-hook-form` is NOT adopted — mutations are Server Actions validated at the action boundary with the schemas the services already use, and the `Field` primitives render the returned error. `sonner` is pruned unless a client island needs transient feedback; the flash contract stays server-rendered through the URL. `nav-documents` is pruned (no document tree); `nav-user` is adopted into the sidebar's user area; `site-header` is adopted as the header inside `SidebarInset`; the block's `data.json` sample is replaced by real data and not shipped. The glass chrome is hand-authored CSS on top of `SidebarInset` and the site header (D2) — no library provides it.

**The tension inside `dashboard-01`, resolved.** The block's `DataTable` sorts, filters and paginates client-side over a fully loaded dataset. Six dashboard views have a contract that pins filtering, ordering and counting on the **server** — the review-state TTL pushed into SQL, true filtered totals, `PAGE X OF Y` — and adopting the block's client-side table state verbatim would break them: re-sorting a server page on the client reorders a set the client did not receive, and a client-side filter cannot see rows the server did not send. **Chosen resolution:** the composition is adopted once, with its sort/filter/page controls driving the **URL** so every change requests a new server page; the fully client-side mode is used only where a view genuinely holds the complete set (the home recents table). This keeps "maximum component use" without trading away a behavioural contract, and it is why the shared data-table composition is specified as a contract of its own rather than left as an implementation detail.

**Alternative considered — adopt `dashboard-01`'s DataTable with client-side state everywhere.** Rejected: it silently converts server-side contracts into client-side ones, which is a behavioural regression in exchange for less code.

**Alternative considered — skip the block and keep hand-written tables.** Rejected: it discards the largest component reuse available in the registry for the surface that dominates the dashboard.

### D9 — the process-model requirements land in `dashboard`, not in a new capability

**Chosen.** The bootstrap requirement and the no-scheduler/no-orchestrator requirement are added to `dashboard`, because the dashboard is the served application whose lifecycle they describe in this change, and because the operator-visible consequences (the retired update flow, the badge that survives) are dashboard requirements.

**Alternative — a new `web-runtime` capability.** Rejected as scope growth: it would split one application's contract across two capabilities to describe a bootstrap hook and a deletion. If a second served surface ever needs the same contract, extraction becomes a real question then.

## Risks / Trade-offs

**[Risk]** The XSS surface is not eliminated, it moves: React escapes text children, but rendered Markdown still requires `dangerouslySetInnerHTML`, so a misapplied boundary can reintroduce exactly the class of defect that regression #252 recorded. → **Mitigation:** `apps/server/src/dashboard/sessions-xss.test.ts` REMAINS and is rewritten against the ported view rather than deleted; the Markdown parser keeps `html: false`; the spec SHALL NOT claim the framework removes this class of defect; and the rendered-Markdown boundary is mutation-checked (weaken `html: false` or the escaping path and confirm the test goes red).

**[Risk]** React Query islands break the server/client data boundary: a query cache that hydrates a list becomes a second source of truth for filtered, paginated, server-counted data, and hydration mismatches produce visible flicker. → **Mitigation:** the island list is closed by spec (polling, as-you-type search, optimistic actions); initial render never depends on a client fetch; dense tables and every list read stay server-rendered; the polling island's first render carries the server value so hydration has nothing to disagree with.

**[Risk]** R3 — Server Actions origin/host verification is assumed to be equivalent to `csrf.ts`, and it is **not yet verified** (D4). A spec that asserts equivalence without a probe is exactly the "claims need evidence" failure this repository guards against. → **Mitigation:** keep `csrf.ts` and its token if the probe (failing case plus same-origin control) does not demonstrate equivalence; the requirement rewrite is intent, never evidence; the probe is a task with a recorded transcript.

**[Risk]** 13 views plus a component layer plus a protocol retirement is the largest review unit of the whole migration. → **Mitigation:** route-by-route commits, each with its view green and its old route deleted in the same commit; the shared shell lands once and is reviewed once; the change's tasks name every route explicitly so a reviewer can take it one file at a time.

**[Risk]** New dependencies land in a repository that denies lifecycle scripts by default (`ignore-scripts=true`), pins `minimumReleaseAge: 4320` (three days), and pins the lifecycle allow-list by test. → **Mitigation:** consult `.agents/skills/npm-security-best-practices/` before editing `package.json`; every adopted dependency is checked as pure JS with no lifecycle script; anything that needs a lifecycle entry reds `apps/server/src/test/supply-chain-inventory.ts::ALLOWED_BUILD_SCRIPTS` until the inventory is edited deliberately.

**[Risk]** The two-link, content-hashed, immutable-caching contract disappears and nothing reasserts it: the assumption "Next hashes and caches CSS properly" is a claim, not a measurement. → **Mitigation:** the rewritten requirement pins the observable outcome (production build output is content-hashed and served immutable) and a task verifies it against a production build; if the framework's behaviour differs, the requirement is corrected rather than the observation.

**[Risk]** Tailwind v4 plus PostCSS integration with the app's Next/Turbopack toolchain is unproven in this repository. → **Mitigation:** the first commit is the initialisation plus the theme plus one component rendered on one page; no view is ported until that commit's build and dev-server render are observed.

**[Risk]** R7 — residual spec debt: requirements whose text names machinery the port deletes were deliberately left untouched to bound this delta. The measured list: "The dashboard MUST surface a sessions list view at `/dashboard/sessions`" (`data-href` whole-row click), "The judgment-queue view MUST be served at `/dashboard/judgments`" (the `judgment.orphan` CSRF action-token scenario), "The dashboard MUST surface an Abandon action for active sessions" (`data-confirm*` attributes plus a CSRF token), "The dashboard MUST surface a prompts list view at `/dashboard/prompts`" (an HTMX `<details>` toggle), "The dashboard sidebar MUST include a `PROMPTS` entry" (`apps/server/src/dashboard/components.ts::NAV`), and the token-creation requirement's clause "no new design tokens: the existing `:root` token set". → **Mitigation:** the added "UI mechanisms MUST translate to the React stack" requirement states the replacement rule for each of these mechanisms, and a task in this change lists the exact requirements and closes them by modification before the change is archived. Leaving them is a tracked debt with a named list, not an oversight.

**[Risk]** R7b — the archive mechanics constrain how honestly a requirement can be rewritten. `openspec archive` replaces a MODIFIED requirement wholesale and refuses when a published `#### Scenario:` title is absent from the delta, and this repository's CI enforces that with `scripts/check-delta-freshness.mjs` (blocking; measured: a first draft of this delta failed with 10 blocking problems across 7 requirements). Four consequences are recorded rather than hidden: (1) the layered-CSS-organisation requirement is **removed and replaced** by the three-layer styles requirement instead of being modified, because both of its scenarios ("A page renders with two CSS links", "Adding a new view requires adding its CSS file") assert a structure that no longer exists and no rewrite of their bodies would make their titles true; (2) the rest of the removed requirements carry no scenarios, so nothing is lost; (3) five published scenario titles are retained verbatim while their bodies describe the React mechanism that replaced them — "Tokens are declared once in core.css", "HTMX swap re-applies the upgrade", "Dashboard layout includes the upgrader script exactly once", "A destructive form with attributes only on the button submits without prompting (forbidden)", and "Manual quadrant" — because the gate refuses their removal and the body is what a test asserts; (4) the same gate reports 22 body differences on this delta as advisories, every one of them a deliberate rewrite. → **Mitigation:** the five retained titles and their rewritten bodies are named here so a reviewer can check each one; the removal of the CSS-organisation requirement carries a Reason that names its two dying scenarios; and the change's own task 17.3 closes the untouched requirement references listed in R7.

**[Risk]** R8 — the identity-A glass palette is undecided, and a spec written before the design reference exists can either invent values or say nothing useful. → **Mitigation:** D8 — the requirement names slots, roles and variables, never new hexes; the exact values land once, in `globals.css`, at implementation. **Open question for the owner:** whether a design mockup reference is required before those values are frozen.

**[Risk]** The block map assumes each view maps cleanly onto a registry block, but three contracts do not fit the block's defaults: server-side table state (D10), the uncurated session summary's escaped `<pre>`, and the OAuth consent decision's protocol `POST`. → **Mitigation:** each is resolved explicitly before its view is ported — the URL-driven table composition, the preserved preformatted pattern, and the consent exception recorded in the mutation requirement — and the per-view green gate is what proves the resolution survived the block's defaults.

**[Risk]** R9 — the silent-empty-database hazard: `better-sqlite3` creates an empty `data.db` when `REMBRIC_DATA_DIR` resolves elsewhere, the process starts normally, and the operator sees an empty dashboard with no error. → **Mitigation:** DS1–DS6 continue to govern, and every phase of this change inherits them unchanged — the resolved absolute database path and its pre-existence are logged at startup, no snapshot uses anything but `VACUUM INTO`, `apps/web` and `apps/server` never share a data directory, and the cutover is gated on a snapshot.

**[Risk]** The port changes the login and consent surfaces, which are authentication boundaries: a visual rewrite that drops a redirect, a cookie attribute or an admin-scope gate is a security regression, not a style change. → **Mitigation:** the authentication and OAuth-consent requirements are untouched except where they name dying mechanisms; the ported views are covered by the existing auth and consent tests, rewritten against the new components rather than deleted with them.

**[Trade-off]** The dashboard no longer has a "no build pipeline" development story — `next dev` (or Turborepo's task graph) is now required to see a page. → Accepted because the repository already runs Turborepo and pnpm-cached task graphs, and the property that requirement protected (a contributor needs nothing beyond `pnpm install`) is preserved verbatim.

**[Trade-off]** During the transition the repository carries two dashboard implementations and two copies of the brand fonts. → Accepted because both apps must serve during the cutover, and the alternative — a flag day — is what DS4 forbids.

## Migration

The order is load-bearing: no view is ported before the theme exists, and no old file is deleted before its replacement is green.

1. **Initialise the stack.** Tailwind v4 plus shadcn in `apps/web`, the `@theme` token block, the glass layer, `next/font/local`, and one component rendered on one page. Observe the dev server render and the production build before writing a view.
2. **Build the shell.** The collapsible sidebar block with its persisted-collapse contract (the provider's mobile sheet replacing the custom mobile bar), the nav table, the view head, the stat and section cards, the kv grid, the shared data-table composition, the filters/pager/flash primitives, the badge set, the back link, the Markdown body, the confirmation dialog and the timestamp component. Nothing but the shell is ported in this step; the probe that decides the mutation protection (D4) runs here, because every view depends on that decision.
3. **Port one view per commit, memories first.** Each commit: the route lands, its block map (D10) is applied, its tests are rewritten against the React components, the corresponding Hono route and view module are deleted, and the suite is green. Order: memories, sessions, prompts, judgments, consolidation, projects, tokens, maintenance, update (version check and badge only — the orchestrator is gone), entities, oauth-consent, login, home.
4. **Move the process model.** `instrumentation.ts` owns bootstrap, the admin-token bootstrap, the reaper and the embedder drain; `apps/server`'s bootstrap stops owning the moved steps.
5. **Delete the dead machinery.** `apps/server/src/server/dashboard-router.ts`, the dashboard tree, `styles/**`, `build-css.mjs`, the vendored HTMX bundle, and the now-unused tests; close the residual requirement references listed in R7.
6. **Cut over (operator-only, DS4/DS5).** Take a `VACUUM INTO` snapshot before the new code touches a real data directory, repoint the deployment, verify the seeded-volume read-back, then retire `apps/server`.

Data safety runs alongside, not after: the DS1 startup log and the DS5 snapshot land before any phase touches a real data directory.

## Open questions

- **Does the identity-A glass palette need a design mockup reference before the token values are frozen?** Until it exists the spec pins slots and roles (D8) and nothing else.
- **How wide is the delta?** R7 lists six requirements that still name deleted machinery. They are covered by the added translation requirement and a closing task; widening the delta now would make this change's spec file the largest artifact of the migration.
- **Does Next's Server Action origin/host verification satisfy the CSRF requirement behaviourally?** Unverified (D4). The probe design — a cross-origin POST that must be rejected, plus a same-origin control — is the measurement; until it runs, `csrf.ts` stays.
- **Do the adopted dependencies require any lifecycle-script entry?** Resolved by the supply-chain skill and the inventory test at initialisation time; the expectation (all pure JS) is a hypothesis until the install is observed.
- **Is `apps/web/src/globals.css` the right home for the glass layer, or a separate file imported from it?** Resolved by the initialisation commit, where the Tailwind v4 layering rules decide it.
