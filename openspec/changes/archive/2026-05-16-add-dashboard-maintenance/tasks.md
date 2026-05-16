## 1. Service layer

- [x] 1.1 Add `AgentSessionsService.purgeEmpty({ adminBypass: true }): { deletedIds: string[] }` in `src/services/agent-sessions.ts`. The method SHALL:
  - Throw `DomainError('forbidden', ...)` when `adminBypass !== true`.
  - Run the predicate (status ∈ {ended, abandoned}; deleted_at IS NULL; summary IS NULL; title_final = false; ended_at < now − 3_600_000 ms; NOT EXISTS in memory/prompts/confirmations) inside a single SQLite transaction.
  - `DELETE FROM sessions WHERE id IN (...)` for the matching ids in the same transaction.
  - Return the deleted ids.
- [x] 1.2 Add `MemoryService.purgeDisconnectedArchived({ adminBypass: true }): { deletedIds: string[] }` in `src/services/memory.ts`. The method SHALL:
  - Throw `DomainError('forbidden', ...)` when `adminBypass !== true`.
  - Run the predicate (status = 'archived'; no other memory row has this id in its `replaces`; no `consolidation_ops` row references it via `affected_ids` or `created_id`; no `memory_relations` row references it as source or target; no `confirmations` row references it as `memory_id`) inside a single SQLite transaction.
  - `DELETE FROM memory_vec` (and FTS shadow rows via the existing AFTER DELETE trigger) for the matching ids in the same transaction.
  - `DELETE FROM memory WHERE id IN (...)` last (so FTS/vec syncs aren't observed in a half-state).
  - Return the deleted ids.
- [x] 1.3 Co-located unit tests for `purgeEmpty`: empty-row case (deletes), non-empty session case (skipped), session within grace (skipped), soft-deleted session (skipped), session with summary set (skipped), session with prompt (skipped), `adminBypass` missing (throws).
- [x] 1.4 Co-located unit tests for `purgeDisconnectedArchived`: disconnected case (deletes from all three tables), referenced via `replaces` (skipped), referenced by `consolidation_ops.affected_ids` (skipped), referenced by `consolidation_ops.created_id` (skipped), referenced by `memory_relations` (skipped), referenced by `confirmations` (skipped), active status (skipped), superseded status (skipped), `adminBypass` missing (throws).

## 2. Schema + journaling

- [x] 2.1 Extend the `consolidation_ops.op_type` enum in `src/db/schema/consolidation.ts` with `'session_purge'` and `'archived_memory_purge'`. Drizzle migration is NOT required (the column is `text`); only the TS type changes. (Also brought the exported `ConsolidationOpType` type in line with the runtime enum, which had drifted to miss `orphan_promote`.)
- [x] 2.2 Write a journal row inside the same transaction as each purge. `affected_ids` = the deleted ids; `reasoning` = a static string (`"operator purge of empty sessions"` or `"operator purge of disconnected archived memories"`); `consolidation_id` = a fresh ULID; `applied_at` = now. Implemented inside each service's purge transaction; both services also write a `consolidation_runs` row with `scope='maintenance'` so the purge appears in the runs list.
- [x] 2.3 Update the consolidation runs view (`src/dashboard/consolidation.ts`) to render the two new `op_type` values with their own row colour / icon. Operator should be able to filter runs by op_type to find historical purges. (Renders purge ops with the `archived` pill tone and a "terminal (not undoable)" cell in place of the undo button; the runs list already groups by `op_type` via the per-run badge.)

## 3. Consolidation undo narrowing

- [x] 3.1 In the consolidation undo handler (`src/consolidation/operations.ts::undoOp`), look up every `affected_ids` row of the op being undone in `memory`. If any are missing, throw `PurgedRowMissingError` (carries `missing[]`) instead of attempting the undo. Added `NotUndoableError` thrown on `session_purge` / `archived_memory_purge` ops themselves.
- [x] 3.2 In the dashboard's undo route, surface the `purged_row_missing` response as an inline error on the consolidation runs view (red bar, copy: "Undo blocked — N memories were purged after this op. Affected ids: ..."). Implemented as `renderUndoError` shared between op-undo and run-undo routes; `NotUndoableError` rendered as an informational flash.
- [x] 3.3 Co-located test: build a fixture op with affected_ids; purge one of them; attempt undo; assert structured error. Plus tests for `NotUndoableError` on both purge op types.

## 4. Dashboard page

- [x] 4.1 Create `src/dashboard/maintenance.ts` with:
  - GET handler that queries the two pre-flight counts + DB breakdown (`PRAGMA page_count`, `PRAGMA page_size`, `PRAGMA freelist_count`, and per-table aggregation via `dbstat` when available — falls back to row counts when the dbstat module is not compiled in).
  - Two POST handlers: `/dashboard/maintenance/purge-sessions` and `/dashboard/maintenance/purge-archived-memories`. Both require CSRF and admin scope.
  - Renders the page through `renderPage` (i.e. uses `src/dashboard/page-shell.ts`).
- [x] 4.2 Add the page-scoped stylesheet `src/dashboard/styles/views/maintenance.css` (per the dashboard design system rule).
- [x] 4.3 Pass `view: 'maintenance'` to `renderPage` so the manifest loads `maintenance.css`.
- [x] 4.4 Sidebar entry: added a `maintenance` entry to `NAV` (`src/dashboard/components.ts`) plus its SVG icon. Since the dashboard login flow already rejects non-admin tokens at `dashboard-router.ts::POST /login`, every authenticated dashboard session is admin-scoped — the link is therefore visible to all logged-in operators. The maintenance route handler still re-checks `token.scope === '*'` as defense-in-depth.
- [x] 4.5 Route registration in `src/server/dashboard-router.ts`: mounted under `/maintenance`. The POST handlers:
  - Validate CSRF via the existing `csrfInput` / `readFormAndVerifyCsrf` helpers.
  - Check that `tokens.findById(session.tokenId).scope === '*'`. On mismatch, return `403` with a small HTML body explaining the requirement.
  - Call the service method with `adminBypass: true`.
  - Redirect with `303 See Other` to `/dashboard/maintenance?purged-sessions=N` or `?purged-memories=N`.

## 5. Invariant test update

- [x] 5.1 Update `src/test/invariants.test.ts`: the `DELETE FROM sessions` rule now carries an `allow: ['services/agent-sessions.ts']` allow-list. Any other source file containing the pattern still fails the test.
- [x] 5.2 Added the equivalent rule for `DELETE FROM memory` — `allow: ['services/memory.ts']`.
- [x] 5.3 Added positive assertions: two new tests confirm both `agent-sessions.ts` and `memory.ts` actually contain the expected `DELETE FROM ...` strings, preventing the relaxation from silently sliding into "no enforcement at all".
- [x] 5.4 `pnpm test -- invariants` runs the file; the full `pnpm test` includes it and is green (419 tests passing).

## 6. Documentation

- [x] 6.1 Added a "Maintenance: physical-purge escape hatches" subsection to `CLAUDE.md` under "Background workers". Covers the two predicates (one-liner each), the narrowed reversibility statement, and the pointer to the two service methods that own the `DELETE`s.
- [x] 6.2 Added a "Dashboard maintenance (manual purges)" top-level section to `README.md` between CLI operations and Configuration. Covers the page, the admin-scope requirement, irreversibility, and the `VACUUM` recommendation for disk reclaim.
- [x] 6.3 No `plugin/CHANGELOG.md` entry needed — this is server-only, no plugin surface changes.

## 7. Validation

- [x] 7.1 `pnpm typecheck` green.
- [x] 7.2 `pnpm lint` green.
- [x] 7.3 `pnpm test` green: 419 tests passing across 37 test files (includes invariants + the new co-located tests + the existing NAV count test updated for the new sidebar entry).
- [x] 7.4 `openspec validate add-dashboard-maintenance --strict` green.
- [x] 7.5 Manual smoke test (operator-only) — validated 2026-05-16 against `http://127.0.0.1:8788/dashboard/maintenance` with seeded data (4 empty sessions + 3 disconnected archived memories). Counts rendered correctly, both purge buttons fire the confirmation modal (after the form-level `data-confirm` bug fix), POST 303 + flash + counts to 0, two new `consolidation_ops` rows journaled. Side fix discovered during smoke: `data-confirm` attributes must live on the `<form>` (not on the `<button>`), now codified in `openspec/specs/dashboard/spec.md::"Destructive dashboard actions MUST gate submission with the confirmation modal"` and in `CLAUDE.md::Dashboard conventions`.
