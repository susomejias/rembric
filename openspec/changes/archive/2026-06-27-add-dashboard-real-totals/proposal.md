# Add real totals to dashboard list headers

## Why

Every paginated dashboard list header reports the page slice — not the true count — under a label that reads `TOTAL`, so the number an operator reads is silently capped at `PAGE_SIZE` (10). `apps/server/src/dashboard/memories.ts:177` renders `{ k: 'TOTAL', v: String(rows.length) }` where `rows` is `adminList({ limit: PAGE_SIZE + 1, … })` sliced to a page; the FTS branch (`adminSearchFts(query, PAGE_SIZE, offset)`, `memory-repository.ts:666`) only ever fetches one page, so a search across thousands of rows still prints `TOTAL 10`. The same slice-as-total bug exists for sessions (`sessions.ts:147`, `String(visibleRows.length)`), consolidation runs (`consolidation.ts:120`, `RUNS = String(runs.length)`), and judgments (`judgments.ts:150`) which labels the slice `SHOWING` and exposes no true count at all. "How many?" is the operator's first question and the header answers it wrong. Counting methods mostly already exist (`MemoryRepository.countByStatus`, `RelationsRepository.adminCountByStatus`), but they do not honour the dashboard's per-view filter sets, so the views cannot use them yet.

## What Changes

- Each affected list header's `TOTAL` meta SHALL render the true count for the **current filter set** (scope/status/type/review/search on memories; deleted-or-not on sessions; status/kind on judgments; all runs on consolidation), not the page slice. The `SHOWING N ROWS` indicator stays as the page-slice readout.
- Add a **filtered** `MemoryRepository.adminCount(opts)` that honours the same `status` / `type` / `project` filters as the existing `adminList(opts)`; add `adminCountFts(query)` that counts matching rows for the FTS-search branch; add `adminCountNeedsReview({ project, nowMs, ttlByType })` mirroring `adminFindNeedsReview`. These are `admin*`-prefixed, dashboard-only, unscoped reads.
- Add `RelationsRepository.adminCountWithFilters(filters)` mirroring `adminListWithContent`'s `status` / `kind` filters.
- Add `ConsolidationRepository.adminCountRuns()` and `AgentSessionsRepository.adminCount({ deleted })` mirroring their `adminList*` filters.
- Wire all four list handlers (`memories.ts`, `sessions.ts`, `judgments.ts`, `consolidation.ts`) to call the new count method and pass its result to `viewHead`'s `TOTAL` meta. Tokens (`tokens.ts:92`) already reports the true count because `deps.tokens.list()` is unpaginated — it is the reference pattern and requires **no change**.
- Edge case (documented, not a contract break): the memories list `needs_review` + free-text search combination resolves review state in TypeScript after the page slice (`memories.ts:115-117`), so an exact SQL count is not available there; that one combination SHALL render the page-slice count suffixed with `+` (e.g. `10+`) to signal "at least", never a wrong exact number.
- No MCP tool, plugin manifest, design token, HTTP route, or DB migration changes. All new SQL stays under `apps/server/src/db/repositories/` (grep-enforced by `invariants.test.ts`).

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `dashboard`: list-page headers report the true filtered total, not the paginated slice.

## Impact

- `apps/server/src/db/repositories/memory-repository.ts` — add `adminCount`, `adminCountFts`, `adminCountNeedsReview`.
- `apps/server/src/db/repositories/relations-repository.ts` — add `adminCountWithFilters`.
- `apps/server/src/db/repositories/consolidation-repository.ts` — add `adminCountRuns`.
- `apps/server/src/db/repositories/agent-sessions-repository.ts` — add `adminCount`.
- `apps/server/src/dashboard/memories.ts` — `TOTAL` meta uses filtered/FTS/needs-review count (with the `+` suffix edge case).
- `apps/server/src/dashboard/sessions.ts` — `TOTAL` meta uses `adminCount({ deleted: false })`.
- `apps/server/src/dashboard/judgments.ts` — header gains a `TOTAL` meta from `adminCountWithFilters`.
- `apps/server/src/dashboard/consolidation.ts` — `RUNS`/`TOTAL` meta uses `adminCountRuns`.
- `apps/server/src/test/invariants.test.ts` — unchanged; the new methods are `admin*`-prefixed and called only from `src/dashboard/`, satisfying the existing admin-method + data-access confinement invariants.
- `openspec/specs/dashboard/spec.md` — the list-pagination and counter requirements are updated via the spec delta.
