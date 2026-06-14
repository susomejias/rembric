## Context

`add-memory-review-state` landed the `review` axis as a derived, read-time-only signal: `reviewState` (`fresh` | `needs_review`) computed from `max(created_at, last confirmation) + REVIEW_TTL_MS[type]`, exposed to agents on `memory.search` / `memory.get` and as `memory.context.needsReview`. The operator dashboard was deliberately out of that change's scope.

The dashboard already renders memory `status` as a pill and supports project/type/status/search filters with HTMX (`apps/server/src/dashboard/memories.ts`, requirement "Memory browsing MUST support filters and pagination"). Adding review visibility is a natural extension of that view.

## Goals / Non-Goals

**Goals:**

- Show `needs_review` per row on `/dashboard/memories` (badge) and let the operator filter to it.
- Show the derived `reviewState`/`reviewAfter` on the memory detail page.
- Reuse the existing pure `deriveReviewState` so the dashboard and MCP agree by construction.

**Non-Goals:**

- **No new top-level page.** Review is an attribute of memories, not an entity (contrast `memory_relations` → `/dashboard/judgments`). A `/dashboard/review` page would just be the memories list with one filter pre-applied — rejected as duplication.
- **No design-token change.** Reuse the `.pill` atom and locked palette. The `dashboard` token contract is untouched, so no token amendment.
- **No new persisted state.** `reviewState` stays derived; this change adds only reads.
- **No mutation from the dashboard.** Re-affirming/superseding stays an agent action over MCP; the dashboard only _surfaces_ the signal (operators already cannot `memory.confirm` from the dashboard).

## Decisions

### D1: Extend `/dashboard/memories`, not a new page

Judgments earned a page because `memory_relations` rows have their own lifecycle (pending/judged/orphaned) and verdict actions. `reviewState` is a derived boolean-ish attribute of an existing `memory` row — the same category as `status`. It belongs as a **badge + filter** on the memories list, mirroring `status`.

### D2: Badge derived per listed row; filter via a dedicated admin query

Two paths with different needs:

- **Badge (display):** after `adminList` returns the page of rows, batch-fetch their latest confirmation timestamps and call `deriveReviewState` per row in the handler. Cheap, no pagination interaction.
- **Filter (`review=needs_review`):** filtering _then_ paginating must happen in SQL, or page counts drift. So the filter path uses an unscoped `adminFindNeedsReview` (the `admin*` sibling of the scoped `findNeedsReview` from `add-memory-review-state`), which already pushes the per-type TTL `CASE` + baseline predicate into SQL with `LIMIT/OFFSET`.

Filtering in the handler _after_ `LIMIT` (the tempting shortcut) is rejected: it would show fewer than `limit` rows per page and break "next page".

### D3: Reuse `deriveReviewState`; new reads carry the `admin*` prefix

The time math has one home (`services/review.ts`). The dashboard imports the pure helper — no duplication. The two new repository reads (`adminLatestConfirmationTsByIds` if a dashboard-only name is preferred, and `adminFindNeedsReview`) carry the `admin*` prefix so the data-access-confinement invariant keeps them callable only from `src/dashboard/` + the dashboard router, and all SQL stays in `db/`.

### D4: `review` filter is orthogonal to `status`

`needs_review` only applies to `active` memories. Selecting `review = needs_review` therefore implies `active`; the form keeps `status` and `review` as separate controls (an operator can still browse `archived` with `review = (any)`), and the two compose. Default `review = (any)` changes nothing.

## Rendering

```
/dashboard/memories — columns:  SCOPE | PROJECT | TYPE | CONTENT | STATUS | REVIEW | CREATED

   project  demo  project  "ship v1 by Q2…"   [ACTIVE]   [needs_review]   2026-02-01
   project  demo  reference "runbook…"        [ACTIVE]   —                2026-05-10
                                                status     review column
                                                (separate axis: needs_review only on active rows past shelf life)

filter form:  [ scope ▾ ] [ status ▾ ] [ type ▾ ] [ review ▾ ] [ search ____ ]
                                                    (any | needs_review)
```

`review` is its **own column**, not a second pill in the `status` cell — `status` is the lifecycle axis (active/superseded/archived) and `review` is the orthogonal freshness axis. Rendering them in one cell read as two competing statuses; a dedicated column makes the orthogonality legible.

Detail page metadata block gains: `REVIEW: needs_review` + `REVIEW AFTER: <ts via formatTs>` (omitted when the type has no TTL or the row is not active).

## Risks / Trade-offs

- **Confirmation lookup on every list render:** one extra grouped query per page of rows. Bounded by page size; same shape as the existing per-page work.
- **Badge vs filter divergence:** the badge derives in the handler while the filter derives in SQL — both must use the same TTL map and baseline. Mitigated by the SQL `CASE` being generated from `REVIEW_TTL_MS` (already the case in `findNeedsReview`) and the badge using the same helper; a test asserts a row badged `needs_review` also appears under the `needs_review` filter.

## Migration / rollout

None. Read-only dashboard additions; no schema change, no data change.
