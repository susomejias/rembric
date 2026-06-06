# Declutter table id columns

## Why

Dashboard tables spend a column on `shortId(...)` values that carry no operator-readable information: rows already navigate via `data-href` (or could), and the id duplicates a link that belongs on the semantic cell (title, content, timestamp). Removing the dead id columns recovers horizontal space for the cells operators actually read (memory content, judgment `source → target`, prompt title/content) and reduces visual noise across every list view.

## What Changes

- Remove the `id` column from ten dashboard tables:
  - Sessions list (`sessions.ts` — title cell already carries the anchor)
  - Memories list (`memories.ts` — anchor moves to the content cell)
  - Consolidation runs list (`consolidation.ts` — anchor moves to the `started` cell)
  - Session detail → Memories table (anchor moves to content cell)
  - Memory detail → Predecessors table (anchor moves to content cell)
  - Judgments list (`judgments.ts` — see below)
  - Projects list, active + archived tables (id was never a link; pure noise)
  - Prompts list (no detail page exists; id was plain text)
  - Session detail → Prompts table (same)
  - Consolidation run detail → Ops table (op id is plain text; ops have no detail page). The `affected` / `created` cells keep their memory shortId links — those are functional navigation, out of scope here.
- Make judgments list rows whole-row clickable (`data-href="/dashboard/judgments/{id}"`), consistent with sessions/memories/consolidation. The real `<a>` to the judgment detail relocates from the removed `id` cell to the `created` timestamp cell. The existing `ROW_LINK` interactive-element bail-out keeps the memory anchors in `source → target` and the `Mark orphaned` form working.
- Every whole-row-clickable table keeps exactly one real `<a href>` to the row's detail page (cmd-click / middle-click / keyboard navigation preserved).
- Sessions list ordering changes: rows with `status = 'active'` sort first, then everything else; within each group the existing `started_at DESC` order is kept. The ordering stays SQL-side so pagination remains correct.
- Update the stale CSS comment in `styles/core/content.css` ("…so the ID column feels clickable").
- Adjust empty-state `colspan` values and any tests asserting the removed `<th>`/cells.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `dashboard`: column contracts change in four requirements — sessions list (drop "session id (short form)" column; title no longer "left of session id"; ordering becomes active-first then `started_at DESC`), prompts list (drop "short prompt id" column), session detail prompts section (drop "short prompt id" column), judgments queue (drop leftmost `id` column, rows become `data-href`-clickable, detail anchor moves to the `created` cell; the "Judgments list id column links to the detail page" scenario is replaced accordingly).

## Impact

- `apps/server/src/dashboard/sessions.ts` — list table (×2: visible + deleted), detail memories table, detail prompts table
- `apps/server/src/dashboard/memories.ts` — list table, predecessors table
- `apps/server/src/dashboard/judgments.ts` — list table (row `data-href`, anchor relocation, `colspan` 7→6)
- `apps/server/src/dashboard/projects.ts` — active + archived tables
- `apps/server/src/dashboard/prompts.ts` — list table
- `apps/server/src/dashboard/consolidation.ts` — runs list, ops table
- `apps/server/src/dashboard/styles/core/content.css` — stale comment
- `openspec/specs/dashboard/spec.md` — four requirement deltas (above)
- Tests touching these templates (e.g. any asserting `<th>id</th>`, `colspan`, or the judgments id-anchor scenario)

No DB, MCP, HTTP-API, or plugin surface changes. No load-bearing invariants touched — presentation-only within the dashboard layer; the locked design tokens (brutalist theme, lime accent, fonts) are unchanged.
