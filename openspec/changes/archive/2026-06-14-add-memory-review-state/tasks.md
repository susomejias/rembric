## 1. Derivation core (single source of truth)

- [x] 1.1 Create `apps/server/src/services/review.ts` exporting `REVIEW_TTL_MS: Partial<Record<MemoryType, number>>` with the D3 defaults (`project` 3mo, `feedback` 6mo, `user` 12mo; `reference` deliberately omitted = no TTL), each expressed via a readable `months(n)` helper (months as fixed 30-day spans — documented as approximate).
- [x] 1.2 Export `ReviewState = 'fresh' | 'needs_review'` and a pure `deriveReviewState(input: { type: MemoryType; createdAt: Date; status: MemoryStatus; lastConfirmedAt: Date | null }, now: Date): { reviewState: ReviewState | null; reviewAfter: Date | null }`. Returns `{ reviewState: null, reviewAfter: null }` for non-`active` status and for types with no TTL entry (state `'fresh'`, `reviewAfter` null in the latter case).
- [x] 1.3 Implement: `baseline = max(createdAt, lastConfirmedAt ?? createdAt)`; `reviewAfter = ttl ? baseline + ttl : null`; `reviewState = reviewAfter && reviewAfter <= now ? 'needs_review' : 'fresh'`.

## 2. Repository reads (all SQL stays in db/)

- [x] 2.1 In `apps/server/src/db/repositories/memory-repository.ts`, add `latestConfirmationTsByIds(ids: readonly string[]): Map<string, Date>` — a single grouped `SELECT memory_id, MAX(event_ts) FROM confirmations WHERE memory_id IN (...) GROUP BY memory_id`. Returns empty map for empty input.
- [x] 2.2 Add `findNeedsReview(scope, projectId, now, limit): Memory[]` mirroring `findDecayCandidateIds`'s scoping but returning full rows (like `recentForContext`): `status = 'active'`, scope filter identical, predicate `MAX(created_at_ms, COALESCE((SELECT MAX(event_ts) FROM confirmations WHERE memory_id = m.id), created_at_ms)) + ttlForType(type) <= now`. Build the per-type TTL `CASE WHEN type = ? THEN ?` ladder by iterating `REVIEW_TTL_MS` so the constant is never duplicated in SQL; rows whose `type` is absent from the ladder are excluded (no TTL → never needs review). Order by computed baseline ASC, `LIMIT ?`.
- [x] 2.3 Confirm both methods are read-only and require no transaction; verify the data-access confinement invariant (`apps/server/src/test/invariants.test.ts`) still passes (SQL only in `db/`).

## 3. Service wiring (scope resolved here)

- [x] 3.1 In `apps/server/src/services/memory.ts`, define a small projection type (schema-derived, e.g. `Memory & { reviewState: ReviewState | null; reviewAfter: Date | null }`) — do NOT hand-write a row shape.
- [x] 3.2 `get`: after computing `confirmationCount`, fetch `latestConfirmationTsByIds([head.id])`, call `deriveReviewState`, and include `reviewState` / `reviewAfter` in the returned `MemoryWithHistory` (only for `active`).
- [x] 3.3 `search`: after hydrating `ordered`, batch-fetch `latestConfirmationTsByIds(ids)` and attach derived review metadata to each row.
- [x] 3.4 Add `needsReviewForContext(scope, limit)`: takes the resolved `Scope` → `findNeedsReview` (scoped repo read returning full rows) → batch latest-confirmation → map to `{ id, type, snippet, reviewAfter, ageMs }` (`ageMs = now - reviewBaseline`). `Memory` has no `title` column — reuse the existing `snippet` helper and `CONTEXT_SNIPPET_CHARS` exactly as `recentMemories` does.

## 4. MCP surface

- [x] 4.1 In `apps/server/src/mcp/sessions-tools.ts`, add a `needsReview` block to `memory.context` assembly mirroring the `pendingJudgments` block: call the service, cap at 5, oldest baseline first, shape `{ id, type, title, snippet, reviewAfter, ageMs }`. Add `needsReview` to the returned envelope.
- [x] 4.2 In `apps/server/src/mcp/tools.ts` (search/get handlers), surface `reviewState` and `reviewAfter` on response rows for `active` memories; omit for non-active.
- [x] 4.3 In `apps/server/src/mcp/server.ts`, extend the `memory.search`, `memory.get`, and `memory.context` tool descriptions to teach: "`reviewState='needs_review'` means re-verify — confirm if still true (`memory.confirm`), supersede if changed (`memory.save` + `topic_key`), or judge if it contradicts another memory." Keep within any description length ceilings (verify `instructions.test.ts` / description tests stay green).

## 5. Tests

- [x] 5.1 `apps/server/src/services/review.test.ts` — unit-test `deriveReviewState` across: fresh-created, past-shelf-life, confirmed-clears, non-active → null, no-TTL type → fresh/null, exactly-at-boundary.
- [x] 5.2 Repository tests — `latestConfirmationTsByIds` (grouping, empty input) and `findNeedsReviewIds` (scope isolation, status filter, per-type TTL boundary, limit/order, type-without-TTL excluded).
- [x] 5.3 Service tests — `get` / `search` carry review metadata for active rows and omit for non-active; `needsReviewForContext` scope isolation + ordering + cap.
- [x] 5.4 MCP tests — `memory.context` returns `needsReview` (unary, disjoint from `pendingJudgments`, scope-respecting, excludes non-active/within-shelf-life); `memory.search` / `memory.get` expose `reviewState`.
- [x] 5.5 Invariant test stays green: no new persisted column, no `memory` write introduced by the review path (grep/assert the review service performs no INSERT/UPDATE/DELETE on `memory`).

## 6. Documentation & architecture polish

- [x] 6.1 Update `CLAUDE.md` "Load-bearing invariants" / architecture notes to mention the review axis as a read-time derivation distinct from decay (one or two precise lines — no banners).
- [x] 6.2 Audit and tighten the tool catalogue docs so every MCP tool's purpose is unambiguous (see change scope note): ensure `docs/` (and any tool-reference doc) lists `memory.context`'s `needsReview`, the `reviewState` metadata on `search`/`get`, and the confirm/save/judge resolution flow. Keep wording consistent with existing tool descriptions.
- [x] 6.3 MCP `initialize.instructions` left unchanged by decision: the BASE block + scope note already sits at the 800-char ceiling (no safe headroom). Re-verification guidance is taught via the `memory.search` / `memory.get` / `memory.context` tool descriptions instead, which every client receives.

## 7. Validation

- [x] 7.1 `openspec validate add-memory-review-state --strict` passes.
- [x] 7.2 `pnpm run typecheck` and `pnpm run lint` pass.
- [x] 7.3 `pnpm test` passes (server workspace at minimum).
