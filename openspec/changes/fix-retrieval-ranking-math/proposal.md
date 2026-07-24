## Why

Two ranking defects were confirmed and reproduced by the audit. Both are arithmetic errors in fusion and scoring, both silently degrade recall, and both were deliberately held out of `fix-audited-defects` because correcting them changes what search returns and there was no way to demonstrate improvement over regression. `add-retrieval-eval-harness` supplies that, so this change lands on measurement.

**The save-time FTS similarity is monotonically inverted.** Candidate detection computes `sim = 1 / (1 + Math.abs(rank))` over FTS5's raw bm25, which is negative and *more* negative for better matches — so the expression decreases as match quality increases, and the `>= 0.4` gate admits exactly the least informative matches. Reproduced end to end against the real service: in a 300-row corpus a byte-identical duplicate sits at pool position 1 with `rank = -13.907 → sim = 0.067`, and **0 of 20** pool rows clear the gate. There is no sign flip anywhere in the chain — the query deliberately avoids the weighted `bm25()` wrapper because the threshold was "calibrated on unweighted BM25".

There are two regimes, and both are wrong. Above ~20 matches the `LIMIT` keeps only the best-ranked rows, all with large `|rank|`, so the lexical detector emits **nothing** — permanently, with no log. At or below 20 matches, near-zero-IDF junk rows survive and *pass* at `sim ≈ 1.0`, which not only wastes the per-save candidate budget but reports `similarity: 1.00` for an unrelated memory through a field documented as "0..1, normalized" — a false value in the MCP response, not merely noise.

**`RANK_CONSTANT = 60` is paired with a 38-row rank window, and the two are mutually inconsistent.** The pathology holds iff the window is below 62: any row appearing anywhere in *both* branches' windows scores at least `2/98 = 0.0204`, which beats a rank-1 match found by only one branch at `1/61 = 0.0164`. Elastic ships the same rank constant with a window of 100, where a rank-1 single-branch hit correctly survives. Here the default path (`limit + offset < 32`) sits below the crossover, so roughly eight overlapping rows push an exact identifier match off page 1 entirely — and the dense branch over-returns by construction, since the kNN applies no distance cutoff and returns a full window for any partition with enough active rows. This is precisely the query class hybrid search exists to protect: an error code, a ULID, a file path, a symbol name.

## What Changes

- **Replace the inverted FTS similarity with a corpus-independent measure.** BM25 is unbounded and corpus-relative, so *no* absolute floor on it is stable — recalibrating the threshold cannot work, which is why the existing "recalibration" comment has never been actionable. The absolute gate is dropped in favour of taking top-K by rank (the query already orders correctly), and the reported `similarity` becomes a genuine bounded lexical measure — token containment over the sanitized token set — so a byte-identical duplicate scores 1.0 *by construction* and the value is comparable enough to cosine for the existing `max(vec, fts)` merge.
- **Floor the rank window above the rank constant's crossover.** The window becomes `min(max(limit + offset + margin, 64), ceiling)`. This keeps `RANK_CONSTANT = 60` consistent with the literature default it cites, costs only a slightly deeper over-fetch on a kNN measured at ~11 ms flat in `k`, and leaves large-`limit` behavior untouched. **Not** lowering the rank constant: that would discard the cited default and re-order every query including the paths that are currently correct.
- **Add the guard tests both defects lack.** A byte-identical in-scope duplicate must surface with `source: 'fts'` when the row has no embedding — a test that cannot pass today. A rank-1 single-branch row must outrank a bottom-of-window both-branches row at the default limit — an invariant with zero current coverage.
- **Retire the vacuous boost guard test and fix its false docstring.** The post-fusion boost's reachable range is `[0.9, 1.35]`, so the declared `[0.7, 1.4]` clamp is dead code, and the guard test asserts on a score gap RRF cannot produce — its `strong: 0.1` input is 3× above the two-branch ceiling of `2/61 = 0.0328`. More importantly the module contradicts itself: one docstring claims the clamp prevents the boost from overriding RRF order while a neighbouring test asserts that it *does* reorder. The intent is decided and written down, the docstring corrected, and the test rewritten with inputs inside the reachable domain. The constants themselves are left alone — tightening them to their reachable bounds would change no behavior.
- **Re-run the harness and ratchet the baselines** in the same change, so the improvement is recorded rather than asserted.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `memory`: the save-time candidate similarity measure and its admission rule; the rank-window floor in the hybrid text-query branch; the post-fusion boost's documented guarantee corrected to match its actual, intended behavior.

## Impact

- `apps/server/src/services/save-time-candidates.ts` — similarity measure, admission rule, threshold constant removal
- `apps/server/src/services/hybrid-search.ts` — rank-window floor, boost docstring
- `apps/server/src/services/hybrid-search.test.ts` — replace the vacuous boost guard; add the single-branch-rank-1 invariant
- `apps/server/src/services/save-time-candidates.test.ts` — **the existing fixtures must be rebuilt at ≥50 rows**; the current 2-row corpus drives FTS5 IDF to ~1e-6 and green-lights the inverted behavior, so a fix validated against it proves nothing
- `apps/server/src/db/repositories/memory-repository.ts` — if the candidate query needs to return rank position alongside rank
- `apps/server/src/test/retrieval/baselines/` — ratcheted scorecards

Depends on: `add-retrieval-eval-harness` (must land first).

Invariants: append-only untouched; scope-at-service-layer untouched. Changing the admission rule will **increase** the number of pending relations minted per save, which is the intended behavior — the lexical detector currently mints none for realistic corpora — and is the reason this is a spec change rather than a constant tweak.
