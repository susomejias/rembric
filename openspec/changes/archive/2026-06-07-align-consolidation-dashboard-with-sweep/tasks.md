# Tasks: align-consolidation-dashboard-with-sweep

Consult `.agents/skills/rembric-dashboard-ui/` before touching `src/dashboard/`.

## 1. Plumbing — manual sweep trigger

- [x] 1.1 Extend `ConsolidationDeps` in `apps/server/src/dashboard/consolidation.ts` with `triggerSweep: () => ConsolidationRunSummary`; wire `runner.runAll({ force: true })` from `apps/server/src/server/bootstrap.ts` (same lambda the admin endpoint uses)
- [x] 1.2 Add `POST /run` to `createConsolidationRouter`: dashboard-session gate (redirect to login when absent), `readFormAndVerifyCsrf` with action `'sweep.run'`, invoke `triggerSweep`, redirect to `/dashboard/consolidation`
- [x] 1.3 Tests for the route: unauthenticated POST redirects and runs nothing; bad CSRF rejects and runs nothing; valid POST invokes the trigger and redirects (assert via injected fake `triggerSweep`)

## 2. Consolidation views

- [x] 2.1 Runs list: remove the `model` column (header + cell); add the `RUN SWEEP NOW` form posting to `/dashboard/consolidation/run` with `csrfInput`, `data-confirm` on the form, `data-confirm-tone="warn"`
- [x] 2.2 Empty-state copy: replace the `POST /admin/consolidation/run` curl reference with the button ("trigger one with RUN SWEEP NOW"), keeping the lazy-sweep description
- [x] 2.3 Run detail: render the `Model` stat card only when `run.llmModel` is non-null
- [x] 2.4 Run detail: parse `run.summary` as `{archives, orphaned}` (guard: both keys numeric); render "N archived · M orphaned" on success, raw text fallback otherwise; cover both paths with a unit test if a templates/consolidation test exists, otherwise assert via router test
- [x] 2.5 Scope cells in runs list + run detail render the project slug (`scopeLabel` helper, raw fallback for deleted projects / global)

## 3. Home health section (`apps/server/src/server/dashboard-router.ts`)

- [x] 3.1 Last-run query: drop `llm_model`; LEFT JOIN `projects` on `substr(r.scope, 9) = p.id` to select the slug; render `global` or the slug (fallback to raw scope when the join misses)
- [x] 3.2 Replace the NEXT RUN / MODEL cell with `TRIGGER` → `ON SESSION START`, sub `THROTTLED 6H / SCOPE · MANUAL FROM CONSOLIDATION`
- [x] 3.3 Thread the resolved `JUDGMENT_ORPHAN_AFTER_MS` / `JUDGMENT_ORPHAN_DEADLINE_MS` values into the dashboard router deps; rewrite the orphaned-pendings caption to deterministic-orphaning language using those values formatted as h/d (no hardcoded "96H")
- [x] 3.4 Grep gate: `git grep -n "CONSOLIDATION_CRON\|llm_model" apps/server/src/server/dashboard-router.ts` returns nothing

## 4. Seed refresh

- [x] 4.1 Rewrite `apps/server/src/scripts/seed-dev.ts:229` (session summary teaching the cron) and `:332` (memory citing `CONSOLIDATION_CRON`) to lazy-sweep-era content of equivalent shape and length

## 5. Gates

- [x] 5.1 `pnpm run typecheck` and `pnpm run lint` pass
- [x] 5.2 `pnpm test` passes
- [x] 5.3 OPERATOR/local: `pnpm run dev:docker:up`, then verify in a browser: home shows the trigger cell and slugged scope with no cron/model copy; `/dashboard/consolidation` has no model column and the RUN SWEEP NOW button forces a run through the confirm modal; a run detail shows the legible summary; reseeded content contains no cron references
