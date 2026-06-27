## 1. Repository count methods

- [x] 1.1 Add `MemoryRepository.adminCount(opts: AdminListMemoriesOpts-without-limit/offset)` returning a `number`, building the SAME `WHERE` conditions as `adminList` (status, optional type, optional `project` global/project) with `select({ value: count() })` and no `LIMIT/OFFSET/ORDER BY`, in `apps/server/src/db/repositories/memory-repository.ts`.
- [x] 1.2 Add `MemoryRepository.adminCountFts(query: string)` returning the count of rows matching `memory_fts MATCH ${query}` (mirroring the `adminSearchFts` `JOIN`, no `LIMIT/OFFSET`), in the same file.
- [x] 1.3 Add `MemoryRepository.adminCountNeedsReview({ project, nowMs, ttlByType })` returning the count of active in-scope rows past their review shelf life, reusing the same TTL `CASE` + baseline predicate as `runNeedsReview` with `count()` and no `LIMIT/OFFSET`, in the same file. Return `0` when `ttlByType` is empty.
- [x] 1.4 Add `RelationsRepository.adminCountWithFilters(filters: AdminRelationFilters)` returning a `number`, applying the SAME `status` / `kind` (`'pending'` → `relation IS NULL`) conditions as `adminListWithContent`, no `LIMIT/OFFSET`, in `apps/server/src/db/repositories/relations-repository.ts`.
- [x] 1.5 Add `ConsolidationRepository.adminCountRuns()` returning the total `consolidation_runs` count, in `apps/server/src/db/repositories/consolidation-repository.ts`.
- [x] 1.6 Add `AgentSessionsRepository.adminCount(opts: { deleted: boolean })` returning the count of rows matching the same `deleted_at IS NULL` / `IS NOT NULL` predicate as `adminList`, in `apps/server/src/db/repositories/agent-sessions-repository.ts`.
- [x] 1.7 Confirm all six methods carry the `admin*` prefix and are pure reads so that `pnpm vitest run apps/server/src/test/invariants.test.ts` (data-access + admin-method confinement) passes.

## 2. Wire dashboard handlers

- [x] 2.1 In `apps/server/src/dashboard/memories.ts`, compute `total` per branch: FTS-only → `adminCountFts(query)`; needs-review-only → `adminCountNeedsReview({ project, nowMs, ttlByType })`; plain list → `adminCount({ status, type, project })`. Render `{ k: 'TOTAL', v: String(total) }` and keep `{ k: 'SHOWING', v: \`${visible.length} ROWS\` }`.
- [x] 2.2 In `memories.ts`, for the `needs_review` + non-empty `q` combination (the TS-derived path), render `{ k: 'TOTAL', v: \`${visible.length}+\` }` (lower-bound) instead of an exact number.
- [x] 2.3 In `apps/server/src/dashboard/sessions.ts`, set the `TOTAL` meta to `String(deps.repos.agentSessions.adminCount({ deleted: false }))` (replacing `String(visibleRows.length)`).
- [x] 2.4 In `apps/server/src/dashboard/judgments.ts`, add `{ k: 'TOTAL', v: String(deps.repos.relations.adminCountWithFilters(filters)) }` to the `viewHead` meta, keeping the existing `SHOWING N ROWS` readout.
- [x] 2.5 In `apps/server/src/dashboard/consolidation.ts`, set the runs-list meta to `{ k: 'TOTAL', v: String(deps.repos.consolidation.adminCountRuns()) }` (replacing the `RUNS = String(runs.length)` slice value).
- [x] 2.6 Leave `apps/server/src/dashboard/tokens.ts` unchanged (its `TOTAL` already reflects the unpaginated `deps.tokens.list()` length); add no count call there.

## 3. Tests & validation

- [x] 3.1 Add/extend a co-located test (e.g. `apps/server/src/dashboard/*.test.ts` or repository tests) seeding more than `PAGE_SIZE` rows and asserting the rendered `TOTAL` equals the true filtered count (not 10) for: memories plain list, memories status filter, memories FTS search, sessions list, judgments list, consolidation runs — so that `pnpm vitest run apps/server/src/dashboard` passes.
- [x] 3.2 Add a test asserting the memories `needs_review` + `q` combination renders a `+`-suffixed lower-bound total.
- [x] 3.3 Run `pnpm run typecheck` and `pnpm run lint` clean.
- [x] 3.4 Run `pnpm vitest run apps/server/src/test/invariants.test.ts` to confirm the data-access and admin-method confinement invariants still pass with the new methods.
- [ ] 3.5 (Operator-only) Manually verify against `pnpm run dev:docker:up` that a seeded scope with more than 10 memories shows the true `TOTAL` while `SHOWING` stays capped at the page size.
