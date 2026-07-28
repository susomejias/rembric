## 0. Before-picture, measured

- [ ] 0.1 Reproduce the blind spot against a real instance, not a fixture: record `memory.doctor`'s `review.pendingJudgments`, then `memory.context`'s `pendingJudgments.length`, then judge every surfaced pair and re-read both. The observation this change exists for is that the second number reaches 0 while the first is still large. Record all four numbers.
- [ ] 0.2 Confirm `countPendingInScope` returns the same number `memory.doctor` reports, for the same scope. If it does not, the discrepancy is the real defect and this change is premature.
- [ ] 0.3 Record the exact line numbers of the asymmetry so review can see it in one look: where `pendingJudgments` is declared and computed, and where `needsReviewTotal` is declared and computed.

## 1. The total

- [ ] 1.1 Add `pendingJudgmentsTotal` to `memory.context`'s output schema and return `countPendingInScope(scope)`. Do NOT derive it from the returned array's length — that is the misleading number this change corrects.
- [ ] 1.2 Test that the total is the FULL scoped count while the list is a page: seed more pending pairs than the page size and assert `pendingJudgments.length < pendingJudgmentsTotal`. **Mutate it** — return `pendingJudgments.length` as the total and confirm the test fails, because a test that only checks the field exists would pass against exactly the bug being fixed.
- [ ] 1.3 Assert the total is SCOPED: a pending pair in another project must not raise it. Cross-scope leakage in a count is the failure mode this repo's scope invariant exists for.

## 2. The size, and the age filter

- [ ] 2.1 Add `judgments` to the input schema, clamped like its siblings. Choose the clamp against the sibling maxima (100 / 50 / 25) and record WHY the chosen value, not just the value — Open Question 1.
- [ ] 2.2 Parameterise `listPendingOlderThanInScope` so the cutoff can be skipped, rather than adding a sibling method. One predicate, two modes; the `sessionHasContent` precedent.
- [ ] 2.3 Wire it: no `judgments` → current behaviour byte-for-byte, including the age filter and the current page size. With `judgments: N` → up to N pairs, age filter lifted.
- [ ] 2.4 Test the default is UNCHANGED. Seed a pair younger than the cutoff and assert a default call does not return it — otherwise this change silently makes the session-start channel noisier, which is the thing D2 rejects.
- [ ] 2.5 Test that `judgments: N` DOES return the young pair. **Mutate** the cutoff-skip and confirm this fails; without it the parameter would look implemented while changing nothing observable.
- [ ] 2.6 Test the clamp holds, and that asking for more than exists returns what exists rather than erroring.
- [ ] 2.7 Confirm the returned pairs still carry both endpoints' content and both titles, so a caller can actually JUDGE from the response without a second read. A list of ids would be a worse surface than the aged channel it extends.

## 3. Description

- [ ] 3.1 Document the parameter AND the total in `memory.context`'s description. State that a size lifts the age filter — a caller cannot guess that.
- [ ] 3.2 Measure the description's length against `DESCRIPTION_MAX_LENGTH` and record it with the remaining headroom. If it does not fit, cut prose from that description; do NOT raise the constant.
- [ ] 3.3 Do NOT touch `instructions.ts`. It already says `resolve candidates[] with memory.judge`, and it sits at 965/1000 — spending its headroom on a lever this change does not measure is out of scope (proposal, Not in scope).

## 4. Specs

- [ ] 4.1 Apply the `mcp-api` delta. Verify the scenario count against the published requirement BEFORE archiving; the last two changes each had the archiver catch dropped scenarios.
- [ ] 4.2 Grep `openspec/specs/` for `pendingJudgments` and reconcile every hit — `consolidation` and `sessions` both mention it, and either may describe the channel in terms this change makes false.

## 5. Verify

- [ ] 5.1 `pnpm run typecheck`, `pnpm run lint`, full suite.
- [ ] 5.2 Drive it against a real instance and finish the job the before-picture could not: read the total, ask for that many, judge them, and confirm both the list and the total reach 0. That is the acceptance test for this change, and it is the thing that was impossible on 2026-07-28.
- [ ] 5.3 Confirm no client changed: `git diff --stat apps/plugin/` empty.

## 6. Deferred, recorded

- [ ] 6.1 The accumulation RATE is not addressed: up to five candidates per `memory.save`, closed five at a time. Drainability without a rate change means the backlog returns. The two levers are a lower fan-out or a harder save-time instruction; both change model behaviour and need their own before/after evidence.
- [ ] 6.2 Whether the default page size should change now that a total is visible — Open Question 2.
