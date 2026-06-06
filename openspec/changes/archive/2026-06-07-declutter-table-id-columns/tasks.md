# Tasks — declutter-table-id-columns

## 1. Sessions (`apps/server/src/dashboard/sessions.ts`)

- [x] 1.1 Remove the `id` column (`<th>id</th>` + the `shortId` anchor cell) from `renderRow` and from BOTH list `<thead>`s (visible + Deleted); the `title` cell anchor already covers navigation
- [x] 1.2 Session detail → Memories table: drop the `id` column and wrap the truncated content in `<a href="/dashboard/memories/{id}">` so the row keeps one real anchor
- [x] 1.3 Session detail → Prompts table: drop the `id` column (plain text, no replacement)
- [x] 1.4 List query: prepend `CASE WHEN status = 'active' THEN 0 ELSE 1 END` to the `orderBy` (before `desc(startedAt)`) so active sessions sort first SQL-side; leave the deleted-rows query on plain `started_at DESC`

## 2. Memories (`apps/server/src/dashboard/memories.ts`)

- [x] 2.1 List table: drop the `id` column; wrap the truncated content cell in `<a href="/dashboard/memories/{id}">`; decrement the empty-state `colspan` 7→6
- [x] 2.2 Predecessors table on memory detail: drop the `id` column; wrap the truncated content in the anchor

## 3. Judgments (`apps/server/src/dashboard/judgments.ts`)

- [x] 3.1 Add `data-href="/dashboard/judgments/{id}"` to each list row
- [x] 3.2 Drop the `id` column; wrap the `created` cell's `formatTs(...)` output in `<a href="/dashboard/judgments/{id}">`; decrement the empty-state `colspan` 7→6
- [x] 3.3 Verify manually that memory anchors in `source → target` and the `Mark orphaned` form still work inside the clickable row (ROW_LINK bail-out)

## 4. Consolidation (`apps/server/src/dashboard/consolidation.ts`)

- [x] 4.1 Runs list: drop the `id` column; wrap the `started` cell's `formatTs(...)` output in `<a href="/dashboard/consolidation/{id}">`
- [x] 4.2 Run detail → Ops table: drop the op `id` column (plain text, no replacement); keep the memory shortId anchors in `affected` / `created` cells untouched

## 5. Projects & prompts

- [x] 5.1 `projects.ts`: drop the `id` column from the active AND archived tables (header + `shortId(p.id)` cell in `renderRow`)
- [x] 5.2 `prompts.ts`: drop the `id` column from the list table (header + `shortId(p.id)` cell); keep the session shortId link column as-is

## 6. CSS & spec sync

- [x] 6.1 Update the stale comment in `styles/core/content.css` ("links inside tables render in lime so the ID column feels clickable" → reflect that lime links mark the row's navigable cell)
- [x] 6.2 Apply the four MODIFIED requirements + one ADDED requirement from `specs/dashboard/spec.md` to `openspec/specs/dashboard/spec.md` at archive time (no manual action now — recorded for the archive step)

## 7. Tests & verification

- [x] 7.1 Update `apps/server/src/test/dashboard-e2e.test.ts`: the exact multiline anchor assertion for the judgments id link (~line 533) must match the relocated `created`-cell anchor; the loose `href="/dashboard/judgments/${rel.id}"` containment assertions should pass unchanged
- [x] 7.2 Grep the test suites for assertions on removed markup (`<th>id`, `colspan="7"`, shortId cells) and update: `pnpm vitest run apps/server/src/test/dashboard-e2e.test.ts apps/server/src/test/smoke.test.ts` passes
- [x] 7.2b Add/extend an e2e assertion for active-first ordering: seed an old active session + a newer ended one, assert the active row renders first in `/dashboard/sessions`
- [x] 7.3 `pnpm run typecheck` and `pnpm run lint` pass
- [x] 7.4 Full `pnpm test` passes
- [x] 7.5 Visual smoke against `pnpm run dev:docker:up` (operator-assisted): every list page renders without the id column, every navigable row cmd-clicks open in a new tab via its semantic-cell anchor, judgments rows whole-row navigate, action forms (Delete/Abandon/Mark orphaned/Undo) still work
