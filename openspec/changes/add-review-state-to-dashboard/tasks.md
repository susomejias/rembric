## 1. Repository reads (admin, unscoped — dashboard only)

- [ ] 1.1 In `apps/server/src/db/repositories/memory-repository.ts`, add `adminFindNeedsReview({ project, nowMs, limit, offset, ttlByType })` — an unscoped sibling of `findNeedsReview` returning full `Memory` rows past their shelf life, with optional project filter (mirroring `adminList`'s project handling) and `LIMIT/OFFSET`. Reuse the same generated per-type TTL `CASE` + baseline predicate.
- [ ] 1.2 Confirm the existing `latestConfirmationTsByIds` (by-id, scope-agnostic) is reusable for the badge path from the dashboard; if a dashboard-only name is preferred for the grep-enforced boundary, add `adminLatestConfirmationTsByIds` delegating to it. Verify the data-access-confinement invariant (`apps/server/src/test/invariants.test.ts`) still passes.

## 2. Memories list — badge + filter

- [ ] 2.1 In `apps/server/src/dashboard/memories.ts`, read the `review` query param (`''` default | `needs_review`). When `needs_review`, source rows from `adminFindNeedsReview` (respecting the project filter, `limit`, `offset`); otherwise keep the current `adminList` path.
- [ ] 2.2 For the rendered page of rows, batch-fetch latest confirmation timestamps and compute `reviewState` per row via the pure `deriveReviewState` (`apps/server/src/services/review.ts`). Render a `needs_review` badge next to `statusPill` for `active` rows that derive `needs_review`, using the existing `.pill` atom (no new token).
- [ ] 2.3 Add a `review` `<select>` to the filter form (`(any)` | `needs_review`), selected-state preserved, included in the HTMX-preserved query string alongside project/type/status/search and pagination.
- [ ] 2.4 Ensure pagination ("next page") preserves the `review` filter and that page sizes are correct under the filter (filtering happens in SQL, not post-`LIMIT`).

## 3. Memory detail — derived fields

- [ ] 3.1 In the `/dashboard/memories/:id` handler, derive `reviewState`/`reviewAfter` for the active head (reuse `deriveReviewState` + confirmation lookup) and render them in the metadata block. Omit when the row is not `active` or the type has no TTL. Use `formatTs` for `reviewAfter` (never hand-write timestamps).

## 4. Tests

- [ ] 4.1 `apps/server/src/dashboard/*.test.ts` (or the dashboard e2e): a `needs_review` active memory renders the badge; a fresh / non-active / no-TTL memory does not.
- [ ] 4.2 Filter: `?review=needs_review` returns only stale active rows, respects the project filter, and paginates correctly (page size honored; next page preserves the filter).
- [ ] 4.3 Consistency: a row that shows the badge also appears under the `needs_review` filter (badge ↔ filter agree).
- [ ] 4.4 Detail page renders `reviewState`/`reviewAfter` for a stale active memory and omits them for a non-active one.

## 5. Validation

- [ ] 5.1 `openspec validate add-review-state-to-dashboard --strict` passes.
- [ ] 5.2 `pnpm run typecheck` and `pnpm run lint` pass.
- [ ] 5.3 `pnpm test` passes; consult the `rembric-dashboard-ui` skill for token/markup conventions before finalizing the badge.
