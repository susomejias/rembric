## 0. Prerequisites

- [ ] 0.1 Confirm `add-retrieval-eval-harness` has landed; record the current scorecard as the before-picture.
- [ ] 0.2 Confirm `fix-audited-defects` has landed, so decay undo is durable before the sweep starts firing in earnest.
- [ ] 0.3 **Resolve the four open questions in `design.md`** — run `/opsx:explore` on them. Do not start section 2 until the touch policy and the terminal state are decided.

## 1. Fix the touch-set bug (independent of the open questions)

- [ ] 1.1 In `apps/server/src/services/memory.ts`, touch only the ids actually returned, not the ids retrieved before the live-status re-check drops some.
- [ ] 1.2 Test: a row excluded by the re-check has an unchanged access signal.

## 2. Apply the decided touch policy

- [ ] 2.1 Implement the resolution of open question 1 in `MemoryService.search`.
- [ ] 2.2 Keep `memory.get` advancing the access signal — dereferencing is the proxy for use.
- [ ] 2.3 Re-examine `apps/server/src/consolidation/decay.ts` eligibility now that the signal is sparser: the windows were chosen against a signal advanced by every search, and 180/365/730/3650 days may be wrong against a sparser one.
- [ ] 2.4 Re-examine the recency term in `apps/server/src/services/hybrid-search.ts` for the same reason.
- [ ] 2.5 Rework the consolidation tests deliberately — they encode current decay behavior; do not adjust them until green.
- [ ] 2.6 Test: a memory returned in a page but not dereferenced remains decay-eligible.

## 3. Add refutation as an append-only event

- [ ] 3.1 Extend the confirmations channel with a sign or kind (additive column if needed; no table rebuild).
- [ ] 3.2 Record refutations with the agent's reason; assert the access signal is NOT advanced.
- [ ] 3.3 Feed refutation into `deriveReviewState` in `apps/server/src/services/review.ts` so a refuted memory is immediately `needs_review`.
- [ ] 3.4 Implement the verb per open question 3, with a description that steers against bulk cleanup as firmly as `memory.archive`'s does.
- [ ] 3.5 Test: refutation flips derived review state without touching the access signal, `content`, `title` or `status`; a later confirmation advances the affirmation baseline.

## 4. Give the review queue a terminal state

- [ ] 4.1 Implement the resolution of open question 2 in `review.ts`, computed purely at read time.
- [ ] 4.2 Assert no column records the escalation and no sweep is required to produce it.
- [ ] 4.3 Test: a long-unaffirmed, frequently-read memory is distinguishable from one that just entered `needs_review`.

## 5. Surface queue depth

- [ ] 5.1 Add the needs-review total to `memory.context`, reusing the count already computed for the dashboard sidebar.
- [ ] 5.2 Add needs-review and unresolved-pending-judgment counts to `memory.stats` and the doctor report, scoped to the request context.
- [ ] 5.3 Test: totals are scope-isolated and consistent with the returned subset.

## 6. Measure

- [ ] 6.1 Re-run `pnpm run eval`; the touch change alters what the recency boost sees, so recall must be compared against the before-picture, not assumed.
- [ ] 6.2 Record how many memories the sweep now archives on the eval corpus that it previously could not. This is the change's headline number.
- [ ] 6.3 Ratchet the baselines.

## 7. Verify

- [ ] 7.1 `pnpm run typecheck && pnpm run lint && pnpm test`.
- [ ] 7.2 Smoke against `pnpm run dev:docker:up`: refute a memory and confirm it reports `needs_review` without changing status; confirm the queue totals appear.
