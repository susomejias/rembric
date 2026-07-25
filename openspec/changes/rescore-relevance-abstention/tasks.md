## 0. Prerequisites and before-picture

- [ ] 0.1 Confirm `reconcile-specs-with-shipped-behaviour` has landed. Its `memory` delta rewrites the two requirements this change modifies, and its open task 8.7 is this change's premise. If it has not landed, stop and rebase rather than writing a delta against text that is about to change.
- [ ] 0.2 Record the before-picture from `pnpm run eval`, all three retrievers, at `k = 5` and `k = 8`: `precisionAtK`, `recallAtK`, `mrr`, `avgTokensReturned`, `abstentionFalsePositiveRate`, p50/p95 latency. Commit it into this change directory as the baseline the measured delta is read against. The expected starting values for `hybrid` are P@8 = 0.156, R@8 = 1.000, MRR@8 = 0.676, tokens@8 = 502, `abstainFP` = 1.00.
- [ ] 0.3 Reproduce the two defect measurements so the change is not built on a remembered number: (a) the lexical score of a term appearing in 3/200, 150/200 and 200/200 rows of a synthetic corpus, expecting ≈0.980, ≈0.5000002, ≈0.5000003; (b) the RRF consecutive ratios at `RANK_CONSTANT = 60`, expecting 0.9839 within a branch-membership class and exactly 0.500 at the both-branches → single-branch boundary. Keep (b) as a permanent unit test — it is pure arithmetic over a shipped constant and it is the evidence that no RRF-space threshold can work.

## 1. One implementation of the relevance level

- [ ] 1.1 Move `tokenSet` and `tokenContainment` from `apps/server/src/services/save-time-candidates.ts` into `apps/server/src/services/hybrid-search.ts`, beside `tokenizeWords`, exported; import them back in `save-time-candidates.ts`. `findSaveTimeCandidates`'s reported `similarity` must be byte-identical afterwards — assert it with its existing tests, unchanged.
- [ ] 1.2 Add `computeRelevanceLevel` in `hybrid-search.ts`: given the query's token set, a row's `title`/`content`, and that row's dense cosine (or `undefined` when the dense branch did not return it), return `max(coverage, cosine)` in `[0,1]`. A row present only in the lexical branch has no cosine and scores on coverage alone; a row present only in the dense branch has coverage computed from its text like any other.
- [ ] 1.3 Unit-test the level directly: a row containing every query token scores exactly 1.0; a row sharing one token of eight scores 0.125; a row with no shared token and no dense cosine scores 0; the value is unchanged when 500 unrelated rows are added to the corpus (the corpus-invariance property the whole change rests on).
- [ ] 1.4 Add the bounded by-ids text read as a scoped repository method in `apps/server/src/db/repositories/memory-repository.ts`, returning `id`, `title`, `content` for a caller-supplied id list. SQL stays in `db/`; the method takes the `Scope` like every other scoped read.

## 2. One gate point in `hybridSearch`

- [ ] 2.1 Add `GATE_WINDOW_MARGIN` and compute the gate window as `min(offset + limit + GATE_WINDOW_MARGIN, rankWindowSize)` over the fused pool.
- [ ] 2.2 Move both gates to run after `fuseRRFWithScores` and before `applyRankingBoost`. Compute levels for the gate window from one by-ids read, take `leaderLevel = max(level)`, abstain when `leaderLevel < ABSTENTION_FLOOR`, then keep rows with `level >= RELATIVE_LEVEL_RATIO * leaderLevel` in fused order.
- [ ] 2.3 Rename `GAP_RATIO_THRESHOLD` to `RELATIVE_LEVEL_RATIO` and replace `applyGapRatioFilter` with the leader-relative filter. Update the `HybridSearchOpts` test override (`gapRatioThreshold` → `relativeLevelRatio`) and every call site.
- [ ] 2.4 Delete `normalizeLexicalScore`. Confirm by grep that nothing else reads it and that no other module normalises `bm25()` for comparison against a threshold.
- [ ] 2.5 Guarantee the disabled path is free: when both constants are `null`, skip the gate block entirely — no by-ids read, no level computation. Test it by counting repository calls on a search with the gates disabled and asserting the count equals the pre-change count, and by asserting the returned id list is identical to the pre-change list for a fixed corpus and query.
- [ ] 2.6 Replace the two existing abstention tests in `apps/server/src/services/hybrid-search.test.ts`. Neither can currently fail: one abstains because the candidate set is empty (`hasCandidates`), the other passes trivially because a floor of exactly 0.5 can never be undercut by a score that is always ≥ 0.5. The replacements must have a non-empty candidate set on both sides of the decision, so the assertion is about the gate.
- [ ] 2.7 Test the leader-relative filter against the case the consecutive form misses: a pool with levels 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3 at ratio 0.5 keeps five rows and drops two; the old consecutive form kept all seven. Assert both numbers so the regression is documented in the test, not only in the design.
- [ ] 2.8 Test that a page shortened by the relative filter reports `abstained: false` and that only the floor sets `abstained: true`.
- [ ] 2.9 Test pagination under an enabled relative filter: filtering happens before the slice, so page 2 may be short or empty while page 1 was full, and an empty page must not be reported as an abstention.
- [ ] 2.10 Update `searchWithAbstention`'s docstring in `apps/server/src/services/memory.ts`, which currently asserts `abstained` is always `false`.

## 3. Make the harness able to decide the value

- [ ] 3.1 Grow the `abstention` query set in `apps/server/src/test/retrieval/queries.ts` from 2 to at least 8, each sharing vocabulary with the scope it is issued against. Assert, as a test, that every `abstention` query returns at least one result with the gates disabled — an abstention query that returns nothing on an empty candidate set scores restraint it did not earn.
- [ ] 3.2 Add `overAbstentionRate` to `AggregateMetrics` in `apps/server/src/test/retrieval/scoring.ts`: the share of gold-bearing queries that returned nothing. Include it in `aggregateByType` and in the printed report line.
- [ ] 3.3 Add a `caps` block to the baseline JSON shape and gate `abstentionFalsePositiveRate` and `overAbstentionRate` in `checkFloors` as caps — a run fails when a measured value rises **above** its cap. Keep them out of the `floors` block so the two can never be compared in the wrong direction. Leave `avgTokensReturned` alone: it belongs to `reconcile-specs-with-shipped-behaviour` task 5.12 / A12.
- [ ] 3.4 Drive `searchWithAbstention` from `apps/server/src/test/retrieval/retrievers/hybrid.ts` and fail the run when the reported `abstained` flag disagrees with the emptiness of the result set.
- [ ] 3.5 Add `pnpm run eval --sweep-abstention`: run the production retriever over a committed grid of `(ABSTENTION_FLOOR, RELATIVE_LEVEL_RATIO)` values and print, per grid point and per `k`, recall, `abstentionFalsePositiveRate`, `overAbstentionRate`, tokens returned, plus the gate window leader's lexical coverage and dense cosine separately. Deterministic on unchanged inputs, like every other harness output.
- [ ] 3.6 Regenerate the three baselines. Diff them: `precisionAtK` / `recallAtK` / `mrr` floors MUST be byte-identical, because empty-gold queries are already excluded from those means; `avgTokensReturned` and the latency percentiles will move. Note that `writeBaseline` sets floors at `measured − 0.05` with no ratchet (`reconcile` task 8.8), so a silent floor drop here would not be caught by CI — the byte-identical diff is the guard. Do not fix the ratchet in this change.

## 4. Calibrate, then decide

- [ ] 4.1 Run the sweep and commit its full output into this change directory. This is the artifact a reviewer reads instead of trusting a number.
- [ ] 4.2 Apply the acceptance bar from `design.md` D8 to the grid: `overAbstentionRate = 0` at `k = 5` and `k = 8`; `abstentionFalsePositiveRate` at or below the cap chosen in 4.3; P/R/MRR at or above their committed floors at both `k`; and the value in the interior of a plateau at least two grid steps wide on every criterion. Record which grid points fail and why.
- [ ] 4.3 Set the `abstentionFalsePositiveRate` cap from the measurement, not from taste. State the number and the reasoning — with 8 abstention queries the metric moves in steps of 0.125, so a cap must be a multiple of that and must leave at least one query's worth of headroom.
- [ ] 4.4 Decide, and record the decision either way: enable both gates at the swept values, or leave them `null`. Leaving them `null` with the committed grid attached is a successful outcome — `improve-recall-relevance` recorded that abstention is unshippable without the harness, and that constraint holds until the harness produces a value clearing 4.2. Do **not** ship a value that fails 4.2 on the grounds that it is better than nothing.
- [ ] 4.5 If the gates are enabled, assert `memory.context`'s relevance channel still behaves sanely under the enabled floor — the channel runs the same scoped search, so an enabled floor can silently empty a channel the agent reads at session start, and the sweep does not cover that path.
- [ ] 4.6 Re-run `pnpm run eval` after 4.4 and record the measured delta against 0.2 in this change directory, token axis alongside recall. Name the `abstentionFalsePositiveRate` and `overAbstentionRate` numbers explicitly — the whole point of the change is that `abstainFP` stops reading 1.00 for a structural reason.

## 5. Measure the enabled path's cost

- [ ] 5.1 `EXPLAIN QUERY PLAN` the new by-ids text read and confirm it resolves by primary key with no scan.
- [ ] 5.2 Wall-clock the enabled search path at 1k / 20k / 50k memory rows against the disabled path, at the default `limit = 8` and at `limit = 200`. Report the absolute added milliseconds per search, not a percentage.
- [ ] 5.3 State a budget and hold to it: if the enabled path's added cost at 50k rows exceeds it, the gates stay `null` on cost grounds and that is recorded in 4.4 as a distinct reason from a failed calibration. Coordinate with `tune-hot-query-paths` if it is still in flight, so two changes do not measure the same path against different fixtures.

## 6. Reconcile the written contract

- [ ] 6.1 Apply the `memory` delta: the abstention requirement's quantity, single evaluation point and leader-relative semantics; the constants requirement's `RELATIVE_LEVEL_RATIO`, `GATE_WINDOW_MARGIN` and calibration bar.
- [ ] 6.2 Apply the `retrieval-evaluation` delta: the two error axes gated as caps, the ≥ 8 abstention queries, the sweep.
- [ ] 6.3 Grep `openspec/specs/` for `gap ratio`, `consecutive`, `normalise`/`normalize`, `bm25` and `abstain` and reconcile every hit. Nothing in any spec may still describe the gap as a consecutive-pair test or the floor as a threshold over a normalised bm25.
- [ ] 6.4 Strike `reconcile-specs-with-shipped-behaviour` task 8.7 as resolved here, citing this change.
- [ ] 6.5 Confirm no `mcp-api` change is needed: `abstained` / `abstainReason` already exist on the `memory.search` response and no tool schema changes, so there is no plugin work across the four clients. Record the confirmation rather than assuming it.

## 7. Verify

- [ ] 7.1 `pnpm run typecheck` · `pnpm run lint` · `pnpm test`, all clean.
- [ ] 7.2 `pnpm run eval` passes its committed floors and the new caps.
- [ ] 7.3 Real Docker smoke against pre-existing seeded data, per `rembric-smoke-tests`: bring up `pnpm run dev:docker:up`, then against the seeded corpus verify (a) a text `memory.search` returns the same top result as before the change when the gates are disabled, (b) `abstained` is reported on the MCP response, (c) `memory.context` returns both channels, and (d) if the gates were enabled in 4.4, a deliberately irrelevant query abstains with a reason and a sharp query returns a short unpadded set. This is a search-path behaviour change on production data — the smoke is not optional.
- [ ] 7.4 Confirm the disabled-path guarantee end to end: with both gates `null`, the seeded-data searches in 7.3 return byte-identical id lists to the pre-change image.

## 8. Deferred and explicitly rejected — recorded so it is not lost

- [ ] 8.1 `DIVERSITY_CAP` re-enablement is **not** in this change. It needs a session-labelled eval fixture; the failure is unrelated (whole-pool capping before the page slice). Leave it `null` and leave its spec clause intact.
- [ ] 8.2 `avgTokensReturned` gating is **not** in this change — `reconcile-specs-with-shipped-behaviour` task 5.12 / A12.
- [ ] 8.3 `writeBaseline`'s missing ratchet is **not** fixed here — `reconcile-specs-with-shipped-behaviour` task 8.8. Task 3.6's byte-identical diff is the local guard.
- [ ] 8.4 Per-branch floors are **rejected for now**, not forgotten: the sweep reports each component of the level (task 3.5), so a follow-up can split them on evidence. If the sweep shows one component dominating the `max()` at every useful grid point, open that change and cite the grid.
- [ ] 8.5 Minimum-should-match on the lexical branch instead of pure OR is **rejected here** as out of scope: it would make the candidate set itself the relevance gate, which is a larger retrieval change and removes recall unmeasured. Recorded because it is the natural next question once the level quantity exists.
- [ ] 8.6 IDF-weighted coverage and a stopword list both stay **unimplemented by default** (`design.md` Open Questions). If task 4.2 fails because plain coverage does not separate abstention queries from gold-bearing ones, record that in 4.4 as the trigger for revisiting them — do not add either speculatively.
