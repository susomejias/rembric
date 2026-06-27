## Context

Dashboard list pages share a `viewHead({ … meta: [{ k, v }] })` header (`apps/server/src/dashboard/components.ts:268-292`) whose first meta chip on most lists is labelled `TOTAL`. Every list handler fetches `PAGE_SIZE + 1` rows to compute `hasMore`, slices to `PAGE_SIZE` for the body, and then — incorrectly — feeds the slice length into `TOTAL`:

- `memories.ts:177` — `{ k: 'TOTAL', v: String(rows.length) }`; `rows` came from `adminList({ limit: PAGE_SIZE + 1, offset })`, or from `adminSearchFts(query, PAGE_SIZE, offset)` (FTS branch, never more than one page), or from `adminFindNeedsReview({ limit: PAGE_SIZE + 1, offset })`.
- `sessions.ts:147` — `{ k: 'TOTAL', v: String(visibleRows.length) }` (the non-deleted slice).
- `consolidation.ts:120` — `{ k: 'RUNS', v: String(runs.length) }`.
- `judgments.ts:150` — `{ k: 'SHOWING', v: \`${rows.length} ROWS\` }` (no true count anywhere).
- `tokens.ts:92` — `{ k: 'TOTAL', v: String(tokens.length) }`; here `tokens` is `deps.tokens.list()` → `TokensRepository.listAll()` (unpaginated), so this value is already correct.

Counting primitives partially exist but do not match the dashboard filter sets:

- `MemoryRepository.countByStatus(status)` (memory-repository.ts:381) and `countAll()` (:390) — no `type`/`project`/FTS/needs-review variants.
- `RelationsRepository.adminCountByStatus(status)` (relations-repository.ts:296) — no `kind` filter, no combined status+kind.
- `ConsolidationRepository` — no run-count method.
- `AgentSessionsRepository.countByStatus()` (agent-sessions-repository.ts:157) groups non-deleted by status — not a deleted-vs-non-deleted total matching `adminList({ deleted })`.

Two invariants constrain the implementation (`apps/server/src/test/invariants.test.ts`): all SQL must live under `src/db/` (data-access confinement, :413-443) and any `admin*`-prefixed repository read may be called only from `src/dashboard/` (admin-method confinement, :455-483). Both are satisfied by adding `admin*` count methods to the repositories and calling them only from the dashboard handlers.

## Goals / Non-Goals

Goals:

- The `TOTAL` chip on memories, sessions, judgments, and consolidation list pages equals the true number of rows matching the active filter set, independent of pagination.
- Keep `SHOWING N ROWS` as the page-slice indicator (in `viewHead` meta and/or the `pager` `totalLabel`).
- Confine all new counting SQL to the repository layer using the `admin*` prefix.

Non-Goals:

- No change to agent-facing counts, MCP tools, or the home overview stat strip (already its own requirement).
- No change to pagination size, ordering, or the `pager` component contract.
- No exact count for the memories `needs_review` + free-text-search combination (see Decisions); the rest of the memories filter matrix gets an exact count.
- No new design token, route, migration, or plugin-manifest churn.

## Decisions

### Decision 1: Extend the repositories with new `admin*` count methods rather than reuse `adminList(...).length` or add a generic `count(where)`

Chosen: one purpose-built `admin*Count*` method per view that mirrors the exact filter shape its `admin*List*` sibling already accepts (`adminCount(opts)` mirrors `adminList(opts)`; `adminCountWithFilters(filters)` mirrors `adminListWithContent(filters, …)`; etc.). The count query selects `count()` with the same `WHERE` and no `LIMIT/OFFSET/ORDER BY`.

Alternatives considered:

- **Fetch all rows and take `.length`.** Rejected: defeats pagination — it materialises every matching row (and, for memories, hydrates them) just to count, which is exactly the cost pagination exists to avoid.
- **A single generic `adminCount(where: SQL)` per repo.** Rejected: it would push `WHERE`-clause construction (Drizzle expressions, the FTS `MATCH`, the needs-review TTL `CASE`) up toward the dashboard or a shared helper, eroding the data-access confinement invariant and duplicating the filter logic that already lives inside each `adminList*`. Mirroring the existing list signature keeps the filter logic in one place per aggregate.
- **Compute totals in the dashboard from existing `countByStatus` plus arithmetic.** Rejected: `countByStatus` ignores the `type` and `project` filters the memories view exposes, so the arithmetic would be wrong whenever those filters are set.

### Decision 2: Surface the slice/total distinction by keeping `SHOWING` and making `TOTAL` the true number — no new component

Chosen: reuse the existing `viewHead` meta array. `TOTAL` becomes the true count; a `SHOWING` chip (already present on memories) carries the slice. Judgments and consolidation, which lacked a true-count chip, gain a `TOTAL` chip alongside their existing slice readout; consolidation keeps its domain label by rendering `TOTAL` as the run count (the previous `RUNS` chip value).

Alternatives considered:

- **A dedicated paginated-count component** (e.g. `1–10 of 248`). Rejected for this change: larger surface, touches the `pager` contract and every list, and is not required to fix the wrong number. Could be a follow-up; noted in Open Questions.
- **Drop `SHOWING` and show only the total.** Rejected: operators still benefit from knowing the page is capped at 10; removing it loses information.

### Decision 3: Backward-compatible repository extension, not a new tool or signature change

Chosen: add new methods; do not alter existing `adminList*` signatures or any MCP tool. This keeps the four plugin clients and their manifests untouched (no unified-plugin version bump for a dashboard-only fix) and leaves all current callers compiling unchanged.

Alternative considered: **fold a `withTotal` option into `adminList` returning `{ rows, total }`.** Rejected: it changes a widely-called signature and forces every caller (including non-dashboard ones for sessions/memories list variants) to adapt, for no benefit over a separate count method; the two queries (page + count) are independent anyway under SQLite's single synchronous connection.

### Decision 4: The memories `needs_review` + free-text-search combination renders an inexact `N+` total

Chosen: for that one combination, render the page-slice count with a `+` suffix (e.g. `10+`) meaning "at least N", because review state is derived in TypeScript (`deriveReviewState`, memories.ts:100-117) only over the already-fetched page, so an exact SQL count would require either pushing the TTL+confirmation baseline math into the FTS query or scanning all matches. Every other memories filter combination (plain list, FTS-only, needs-review-only, status/type/project) gets an exact count.

Alternatives considered:

- **Push needs-review derivation into the FTS count query** (combine the `adminFindNeedsReview` TTL `CASE`/baseline subquery with the FTS `MATCH`). Rejected for this change: meaningfully more complex SQL for a rare operator combination; deferred to Open Questions.
- **Count all FTS matches then over-report** (ignore the review filter in the count). Rejected: it would print a number larger than the filtered reality — worse than an honest `N+`.
- **Hide the total entirely for that combination.** Rejected: an `N+` lower bound is more useful than a blank.

## Risks / Trade-offs

- [Trade-off] Each affected list now issues a second query (count) per render. → Accepted because: it is a single indexed `COUNT(*)` against the same `WHERE`, on a single local SQLite file the dashboard already hits several times per page; the cost is negligible next to the row hydration already performed.
- [Risk] The count `WHERE` could drift from the list `WHERE`, reintroducing a wrong number. → Mitigation: each count method mirrors its `adminList*` sibling's exact filter construction in the same file, and the spec scenarios assert total-equals-true-count for representative filters so a drift fails a test.
- [Risk] A new method missing the `admin*` prefix, or called outside `src/dashboard/`, would either leak cross-scope rows or fail the confinement invariant. → Mitigation: all new methods carry the `admin*` prefix and are invoked only from the four dashboard handlers; `invariants.test.ts` (admin-method + data-access confinement) enforces both automatically.
- [Trade-off] The `needs_review` + search total is inexact (`N+`). → Accepted because: the combination is rare, an honest lower bound is correct-by-construction, and the exact path is captured as a follow-up rather than blocking the fix for the common cases.

## Migration Plan

No data migration. Pure additive code change. Steps: add the four repositories' count methods; switch each dashboard handler's `TOTAL`/`RUNS` meta to the count; verify the existing invariant suite still passes (no allow-list edits needed — the new methods already satisfy the prefix and call-site rules). No feature flag; the change is invisible except for a corrected number.

## Open Questions

- Should a future change introduce a real `1–10 of N` paginated-count component shared across all lists (and the `pager`), superseding the `TOTAL` + `SHOWING` pair? Out of scope here.
- Should the memories `needs_review` + free-text-search total be made exact by pushing the TTL/confirmation-baseline math into the FTS count query? Deferred; current change ships the `N+` lower bound.
