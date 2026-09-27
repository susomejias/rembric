# dashboard-nav-datatable-consistency

Owner report (2026-09-27, prod v0.28.14): dashboard navbar badges and datatables
disagree, and non-overview pages have excess mobile padding. All fixes land
directly on `main` (owner decision: minor adjustments).

## Tasks

### 1. Mobile padding on non-overview pages — DONE (commit 97494e8f)

- `CommandFrame`'s `<main>` already carries `px-4 sm:px-6`; `<Page>` added a
  redundant `px-5 md:px-8`, so every page but the overview (which doesn't use
  `<Page>`) rendered 36px side padding on mobile.
- Fix: drop the horizontal padding from `Page` (`apps/web/src/components/dashboard/ui.tsx`).
- Commit: (pending)

### 2. Judgments: badge shows 7.5k, table loads only 50 rows

- Badge = pending(62) + judged(6975) + orphaned(452) historical total; page
  loads `pending(PAGE_SIZE) + judged(PAGE_SIZE)` sliced to 50.
- Owner decision (asked 2026-09-27): keep the total badge, add pagination so
  judged/orphaned history is browsable.
- Plan: server-driven `?status=all|pending|judged|orphaned&page=N` tabs with
  real counts; rows via `adminListWithContent({status}, PAGE_SIZE, offset)`;
  shared server-pager component; drop the client quickFilter (replaced by
  status tabs); keep search + select + row actions.
- Commit: (pending)

### 3. Entities: badge 2k, table "500 in view · 2001 matching"

- `adminListEntities(rowFilters, LIST_LIMIT=500, 0)` — hard window, no paging.
- Plan: URL-driven `?page=N` server pagination through the full matching set
  via the existing `kind` filter param; shared server-pager component.
- Commit: (pending)

## Conventions for both conversions

- Shared pager: `apps/web/src/components/dashboard/pager.tsx` (one
  implementation; renders Prev/Next + "Page X of Y · N rows" as Links preserving
  other searchParams). Written by the parent (committed with task 2).
- Filter dimensions (status / kind) become SERVER-side link chips with
  full-corpus counts; the client quickFilter (window-local counts) is dropped
  where replaced.
- Server window per page = `PAGE_SIZE` (50) from `@/components/dashboard/support`.
- Header line keeps honest totals ("X in view · Y matching · Z indexed" /
  "X rows · A pending · B judged · C orphaned").
- Client DataTable keeps its 10-row client paging, client search, selection,
  and row actions inside the loaded window.

### 4. SYSTEMATIC AUDIT (owner: "revisa todas las secciones, parece sistemático") — DONE

- Audit (gentle-ai-explore muk6g0mb-1-le8u) mapped every nav section. Ranked:
  judgments > memories > sessions > entities > prompts > activity (minor);
  projects + consolidation consistent (consolidation is the reference pattern).
- NEW BUG found: `tokens.count()` (tokens-repository.ts) returned
  `select({id}).limit(1).all().length` — always 0 or 1. Fixed by the parent with
  drizzle `count()`. Latent (More menu renders no totals) but `lib/process.ts:96`
  depends on it.
- OWNER DECISION (2026-09-27): "la spec se debe violar en este caso" — the
  memories badge KEEPS counting the full corpus (active+superseded+archived),
  overriding openspec/specs/dashboard/spec.md:1314-1328 (needs-review badge).
  The mismatch is resolved on the table side (server pagination), same as
  judgments. Spec update pending via OpenSpec.

### 5. Round 2 conversions — DONE

- memories: `832366fe` — `?page=N` over the existing server filters (status/type/project/review/q);
  status chips server-rendered with full-corpus counts; combined q + needs-review now loads
  every FTS match, filters by derived review state, and the pager total matches the yielded
  rows (the in-memory post-filter over a 50-row FTS window would have produced ghost pages).
- sessions: `985ddac0` — `?page=N` + real `status` param; status chips server-rendered with
  full counts; include_deleted window loads one page at the same offset with its own count;
  header uses the unfiltered total. NOTE: `apps/web/src/app/dashboard/sessions/filters.ts`
  found dead (imported by nothing) — cleanup candidate, untouched.
- prompts: `fb656c17` — `?page=N` over `adminList`; client status quickFilter removed (no
  repo status-count method exists, so no faithful full-corpus chip row was invented); the
  server-side Show deleted toggle stays.
- activity: `4e6338fc` — chip reports the rendered count ("X OF Y SIGNALS").
- Verified per unit: `pnpm --filter @rembric/web test` 58 files / 1087 passed, typecheck + lint clean.
