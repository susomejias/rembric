# Tasks — polish-dashboard-consistency

## 1. Inventory & shared utilities (behavior-preserving)

- [x] 1.1 Inventory the catch-DomainError sites (~10) and the `getSession`/`truncate` copies; assert current status codes/flash behavior in a characterization test before touching them.
- [x] 1.2 Move `getSession`, `truncate`, `domainErrorPage` into `components.ts`; migrate all routers; delete the local copies. Dashboard e2e suite green.
- [x] 1.3 Extract the duplicated `projectOptions` builder (memories/prompts) into `components.ts`.

## 2. Helper adoption / cleanup (behavior-preserving)

- [x] 2.1 Unify all list empty states on `tblEmpty` (replacing the four coexisting markups); fix the helper in place if signatures don't fit real usage.
- [x] 2.2 Migrate the memories/prompts/judgments filter bars to `sel`/`inp`/`filtersBar`; every filter control gains an associated `<label>` (visual parity with the current `span.k` chips — no token changes; styles in `styles/` only).
- [x] 2.3 Adopt `kv`/`kvGrid` on detail metadata blocks where they fit; DELETE any helper still unused after 2.1-2.3 (end state: zero exported-but-unused helpers in `components.ts`).

## 3. Fixes

- [x] 3.1 Judgments `SHOWING` chip uses `visible.length` (`judgments.ts:152`); regression test locks page-size behavior for all list views (the new spec scenario).

## 4. Prompts TOTAL

- [x] 4.1 `prompts-repository.ts`: `adminCount(filters)` mirroring the list read's conditions; wire the TOTAL chip in `prompts.ts`; test with filtered fixtures.

## 5. Sessions filters

- [x] 5.1 `agent-sessions-repository.ts`: extend `adminList`/`adminCount` with `{ projectId?, agent?, status? }` (SQL-side, affects rows + total).
- [x] 5.2 `sessions.ts`: filter bar (project/agent/status) via the shared helpers; filters apply to the non-deleted table only; pager preserves query params; tests for the combined-filter scenario.

## 6. Memory detail hub

- [x] 6.1 Render `source` in the metadata block (spec catch-up); test.
- [x] 6.2 Judgments section via `listTouching` (add `admin*` wrapper if needed per confinement rule): kind, status, title-linked counterpart, timestamp via `formatTs`, row links to judgment detail; unified empty state; test.
- [x] 6.3 Link `session_id` to the session detail; render raw `replaces` ids as links; test.
- [x] 6.4 Confirm action: CSRF POST `/dashboard/memories/:id/confirm` → `MemoryService.confirm(id, scope, 'dashboard-operator')`; flash on success; visually associated with the needs-review notice when applicable; NO destructive modal (non-destructive action); tests including the fresh-after-confirm reload.

## 7. Gates

- [x] 7.1 `pnpm run typecheck && pnpm run lint && pnpm test` green (incl. `dashboard-e2e.test.ts` and invariant tests).
- [x] 7.2 `openspec validate polish-dashboard-consistency --strict` green.
