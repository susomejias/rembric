## 0. Prerequisite

- [ ] 0.1 Confirm `add-retrieval-eval-harness` has landed and `pnpm run eval` is green, and record the current `hybrid` scorecard as the before-picture.

## 1. Rebuild the save-time candidate fixtures FIRST

- [ ] 1.1 Replace the 2-row corpora in `apps/server/src/services/save-time-candidates.test.ts` with fixtures of ≥50 heterogeneous rows. The existing fixtures pass because FTS5 clamps negative IDF to ~1e-6 at that size, so the "true match" clears the gate by scoring as noise.
- [ ] 1.2 Add the test that cannot pass today: a byte-identical in-scope duplicate, with no embedding available, surfaces with `source: 'fts'` and `similarity` 1.0.
- [ ] 1.3 Add the corpus-size sweep: the duplicate surfaces at 50, 150 and 300 active rows.
- [ ] 1.4 Add the near-zero-IDF test: a row sharing only a near-universal term is not reported near 1.0 and does not consume the candidate budget.
- [ ] 1.5 Confirm all four tests FAIL against the current implementation before proceeding.

## 2. Fix the lexical candidate measure

- [ ] 2.1 Remove the absolute `FTS_THRESHOLD` gate over raw bm25 from `apps/server/src/services/save-time-candidates.ts` — bm25 is unbounded and corpus-relative, so no absolute floor is stable.
- [ ] 2.2 Admit lexical candidates by rank position within the already-ordered pool.
- [ ] 2.3 Compute the reported `similarity` as bounded token containment over the sanitized token set, so the byte-identical case is 1.0 by construction and the value is truthful against its documented `0..1` range.
- [ ] 2.4 Re-examine the `max(vec, fts)` merge now that both inputs are bounded and comparable.
- [ ] 2.5 Confirm the section-1 tests now pass.

## 3. Floor the rank window

- [ ] 3.1 In `apps/server/src/services/hybrid-search.ts`, floor the window at the crossover implied by the rank constant — preferably derived from `RANK_CONSTANT` rather than a literal, with the crossover documented inline.
- [ ] 3.2 Add the missing invariant test: a rank-1 single-branch row outranks a bottom-of-window both-branches row at the default limit.
- [ ] 3.3 Add the end-to-end identifier test: a rare identifier query returns the memory containing it, with at least eight topically-adjacent rows present in both branches.
- [ ] 3.4 Assert large-limit windows are unchanged by the floor.

## 4. Resolve the boost's self-contradiction

- [ ] 4.1 Correct the docstring that claims the clamp prevents the boost from overriding fusion order — it is applied before truncation and can change page membership, which is its purpose.
- [ ] 4.2 Replace the vacuous guard test: its `strong: 0.1` input is ~3× above the maximum two-branch fused score of `2/61`. Use achievable values and assert the intended ordering guarantee.
- [ ] 4.3 Leave `BOOST_MIN`/`BOOST_MAX` alone and note in the change why: tightening them to the reachable `[0.9, 1.35]` changes no behavior and would misrepresent the defect as addressed.

## 5. Measure and ratchet

- [ ] 5.1 Re-run `pnpm run eval`; compare every metric and every per-type breakdown against the section-0 before-picture.
- [ ] 5.2 If aggregate recall does not improve, STOP and re-analyse rather than shipping on reasoning.
- [ ] 5.3 Commit the ratcheted baselines in this change; record the measured delta in the change directory.

## 6. Verify

- [ ] 6.1 `pnpm run typecheck && pnpm run lint && pnpm test`.
- [ ] 6.2 Smoke against `pnpm run dev:docker:up`: save a duplicate and confirm a candidate is surfaced with a truthful similarity; search a rare identifier and confirm it is on page 1.
