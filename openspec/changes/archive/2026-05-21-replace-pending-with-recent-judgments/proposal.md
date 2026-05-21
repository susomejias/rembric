## Why

The left tile of the dashboard home overview (`apps/server/src/server/dashboard-router.ts:326-376`) is currently anchored to `memory_relations WHERE status='pending'`. In normal operation that table is empty almost always — the agent closes candidates the moment they surface — so the most prominent column on the operator's home page is dead space showing `NO PENDING JUDGMENTS YET`. The same data is still reachable from the `PENDING JUDGMENTS` stat card a few pixels above, so the inline pending list is redundant when it does have content and wasteful when it does not.

What the operator actually wants on the home is _signal about what just happened_: which memories got merged, which conflicts were declared, which the consolidator gave up on. The judgment graph is the most interesting append-only stream Rembric produces, and the home page currently does not surface a single resolved verdict.

This change repurposes that tile to show the most recent **judged** relations with the same visual density as the current pending list (three lines per row, verdict pill + meta + source/target snippets). The legacy pending tile is removed; the `PENDING JUDGMENTS` stat card remains the canonical entry point to the backlog.

## What Changes

- **Home overview**
  - The left tile of the home `.row-2` no longer queries `memory_relations` filtered by `status='pending'`. It now queries `status='judged' ORDER BY judged_at DESC LIMIT 4` and renders one block per row.
  - Section header changes from `PENDING JUDGMENTS · QUEUE / OLDEST FIRST` to `RECENT JUDGMENTS · NEWEST FIRST`.
  - The `OPEN ALL ›` link target changes from `/dashboard/judgments?status=pending` to `/dashboard/judgments` (default unfiltered view, which lands judged rows first via the existing sort).
  - Each row renders, top-down: a verdict pill using the existing `pill k-<relation>` classes (`k-supersedes`, `k-conflicts_with`, `k-related`, `k-compatible`, `k-scoped`, `k-not_conflict`) followed by short judgment id and `judged_at` rendered via `formatTs`; one `mem` line with the source short id and content truncated to 70 chars; one `mem` line prefixed with `↳` for the target. The trailing `JUDGE` action button is removed (the row already represents a closed verdict).
  - The empty-state copy becomes `NO JUDGMENTS YET`.
- **Spec**
  - The `Sidebar links to the new URL` scenario inside `Requirement: The judgment-queue view MUST be served at /dashboard/judgments` is rewritten so the `OPEN ALL ›` row header no longer links to `?status=pending`; the pending-judgments stat card link is preserved verbatim.
  - The same `judgment-queue view` requirement is extended so the `source → target` column renders each side as a truncated content anchor instead of a bare short id, with a new scenario asserting the rendering.
  - A new requirement `The dashboard home page MUST surface a recent-judgments block` documents the new tile's data source, sort, density (anchored content links), and empty state.
- **Judgments list `/dashboard/judgments`**
  - The page's underlying query JOINs `memory` twice (source + target aliases) and selects `content` for both sides.
  - The `source → target` column renders each side as `<a href="/dashboard/memories/{id}">{truncated content}</a>` (60 chars). Short-id-only rendering is removed from this column.
- **Tests**
  - The e2e test that asserts the home pending block (`apps/server/src/test/dashboard-e2e.test.ts`) is updated: the pending-block assertions are replaced with assertions on the new RECENT JUDGMENTS block, including a fixture row of each verdict kind to confirm the pill class wiring.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `dashboard`: the home overview left tile changes data source and copy; one existing scenario is rewritten; one new requirement is added.

## Impact

**Server source**

- `apps/server/src/server/dashboard-router.ts` — replace the `pendingRows` query with a `recentJudgedRows` query (`status='judged' ORDER BY judged_at DESC LIMIT 4`), update the JSX block, change `sectionBar` name + meta + `more` href, drop the JUDGE button, replace empty-state copy. The per-row source/target lines render their truncated content as an `<a href="/dashboard/memories/{id}">` anchor (no standalone short id).
- `apps/server/src/dashboard/judgments.ts` — rewrite the page query as a raw `sql` JOIN against `memory` twice (aliased `ms` / `mt`) so source + target `content` flow through; replace the `source → target` column rendering so each side is `<a href="/dashboard/memories/{id}">{truncate(content, 60)}</a>` instead of a bare short id link.

**Dev tooling**

- `apps/server/src/scripts/seed-dev.ts` — add a fourth fixture block (`judgedPairs`) that creates four memory pairs and `compare()`s them with the four most-visible verdict kinds (`supersedes`, `conflicts_with`, `related`, `compatible`) so a fresh `pnpm run dev:docker:up` populates the new home tile with one row of each pill colour. Not on the spec surface — purely dev-experience.

**Spec deltas**

- `openspec/changes/replace-pending-with-recent-judgments/specs/dashboard/spec.md`

**Tests**

- `apps/server/src/test/dashboard-e2e.test.ts` — update the home-block assertions.

**No impact on**

- `memory_relations` schema, `RelationsService`, MCP tools, plugin clients, consolidator, the `/dashboard/judgments` view itself.
- The `PENDING JUDGMENTS` stat card (top-of-page counter) — keeps its link to `?status=pending`.
- The `add-prompts-dashboard-view` in-flight change — it edits `dashboard` spec deltas that are additive (new `/dashboard/prompts` requirement + sessions integration), with zero overlap on the home overview block or the `/dashboard/judgments` requirement modified here.
