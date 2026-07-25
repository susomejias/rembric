## Context

Two fusion/scoring arithmetic errors, both reproduced. They were held out of `fix-audited-defects` because fixing them changes what search returns, and until `add-retrieval-eval-harness` lands there is no way to tell an improvement from a regression — and the existing tests in this area are worse than absent, because they pass for the wrong reasons.

## Goals

- Make the lexical half of save-time candidate detection actually work on real corpora.
- Stop an exact identifier match from being pushed off page 1 by rows whose only merit is appearing in both branches' windows.
- Leave behind tests that would catch either defect returning.

## Non-Goals

- Adding a third retrieval stream. The audit found published evidence that a graph stream _reduced_ Recall@5 versus BM25 alone in its own author's benchmark; any new stream must earn its place through the harness first.
- Changing decay, review TTLs, or what `last_seen_at` means — that is `separate-access-from-usefulness`.
- Adding recall abstention. It belongs after this, once the ranking underneath it is correct and measurable.

## Decisions

**Decision 1 — Abandon absolute thresholding on bm25, don't recalibrate it.**
The tempting minimal fix is to invert the expression, e.g. `1 - 1/(1 + |rank|)`. That is wrong: it maps `|rank| > 0.667` to `≥ 0.4`, so essentially every marginal match passes, and it remains corpus-size dependent because bm25 magnitudes scale with IDF and corpus size. There is no stable absolute floor to threshold on — which is exactly why the "recalibration" promised in the existing comment was never actionable. Admission moves to rank position within the pool, which the query already orders correctly.

**Decision 2 — Report a real bounded lexical similarity.**
The `similarity` field is documented as "0..1, normalized" and is currently a lie in the small-corpus regime, where unrelated near-zero-IDF rows are reported at 1.00. Token containment over the sanitized token set is corpus-independent, bounded by construction, makes the byte-identical case exactly 1.0, and is comparable enough to cosine that the existing `max(vec, fts)` merge stops being arbitrary. Fixing the _reported value_ matters independently of fixing admission, because the agent makes judgment decisions from that number.

**Decision 3 — Widen the window; do not lower the rank constant.**
Both are arithmetically sufficient. Lowering `k` to ~10 removes the pathology but discards the cited literature default and re-orders every query, including the large-limit paths that are presently correct. Flooring the window at 64 is one expression, keeps `k = 60` coherent with its source, and is nearly free: the dense kNN was measured at ~11 ms and flat in `k` (11.3 ms at k=38 versus 11.6 ms at k=400), and both branches already over-fetch by design.

**Decision 4 — Rebuild the save-time candidate fixtures before touching the code.**
This is the load-bearing sequencing decision. The existing fixture uses a 2-row corpus, where FTS5 clamps negative IDF to ~1e-6, so the "true match" clears the 0.4 gate _by scoring as noise_. Sweeping filler rows against that same pair shows it passing at corpus 2 and 3, and rejected from corpus 5 onward. Any fix validated against those fixtures is unvalidated. The fixtures are rebuilt at ≥50 rows **first**, so the new tests fail against the current implementation before they pass against the new one.

**Decision 5 — Resolve the boost's self-contradiction by deciding intent, not by tweaking constants.**
The module claims the clamp prevents the boost from overriding fusion order and separately tests that it reorders. Both cannot hold. Reordering near-ties is clearly the intent — a fresh, confirmed memory should beat a stale one at comparable fusion score — so the docstring is wrong, not the behavior. Tightening the declared clamp from `[0.7, 1.4]` to the reachable `[0.9, 1.35]` is explicitly _not_ done: it changes no behavior and would create the impression the defect was addressed. The deliverable is a corrected guarantee plus a test with inputs inside the reachable domain.

**Decision 6 — Land with ratcheted baselines in the same change.**
The point of sequencing behind the harness is to record the delta. If the numbers do not improve, that is the finding and the change stops for re-analysis rather than shipping on reasoning alone.

## Risks

- **Judgment load rises.** The lexical detector currently mints roughly no pending relations on realistic corpora; a working one mints real ones. That is the intended behavior and the reason this is a spec change, but it interacts with a known protocol weakness — a pending that goes unjudged in-session hides for 24 hours and then re-surfaces without its original context. Worth watching; not a reason to leave detection broken. The per-save candidate cap bounds the blast radius.
- **The window floor deepens over-fetch on every default query.** Measured as negligible on the dense side. The lexical side is a bounded FTS5 scan; the harness will show it.
- **Token containment is not BM25.** It ignores IDF, so a match on common words scores higher than a relevance ranker would like. Acceptable: it is used for the _reported_ similarity and for ordering inside an already-relevance-ordered pool, not as the retriever.
- **Baseline churn.** These changes legitimately move the numbers, so the committed floors move with them in the same commit.

## Migration

None. No schema change, no data migration. Existing `memory_relations` rows are unaffected; only future detections differ. `retro-scan`-style backfill over memories saved while the lexical detector was inert is deliberately a separate change.

## Open Questions

- The rank-position admission rule: top-K of the pool for a fixed K, or a gap-ratio cut relative to the best-ranked row? The gap-ratio shape adapts result-set size to the score distribution and is the same mechanism a future abstention feature would use, so there is an argument for adopting it once here. **Resolved: top-K of the pool** — the SQL `ORDER BY rank LIMIT poolSize` already computes exactly this; no separate cut is applied. The gap-ratio option is left for whichever future change adds an abstention floor, where the mechanism naturally belongs.
- Whether the window floor should be a derived constant (`RANK_CONSTANT + 4`) rather than a literal 64, so the two can never drift apart again. **Resolved: derived** — `RANK_WINDOW_FLOOR = RANK_CONSTANT + 4`, with the `k + 2` crossover documented inline in `hybrid-search.ts`.

## Measured delta (task 5)

`pnpm run eval` numbers are **unchanged** from the `add-retrieval-eval-harness` baseline (hybrid P@8=0.156, R@8=1.000, MRR@8=0.676). This is not a failure to improve — the harness's 40-memory corpus (~15-20 rows per project scope) is well below the ~64-row crossover the rank-window fix targets, and the FTS-similarity fix lives in `findSaveTimeCandidates` (save-time candidate detection), a code path `memory.search` — the only thing the harness scores — never calls. Neither fixed defect is on the harness's measured path at its current corpus scale, so no visible movement is the _expected_ outcome, not evidence the fixes are inert.

Both fixes are instead proven directly, with explicit before/after test runs (stash the fix, confirm the new test fails against the prior code; restore, confirm it passes):

- **FTS-threshold inversion** (`save-time-candidates.test.ts`): a byte-identical duplicate now surfaces with `source:'fts'`, `similarity:1.0` at corpus sizes 50/150/300 (all 5 new/rebuilt assertions fail against the pre-fix code with a 2-row-equivalent construction, confirming the >=50-row rebuild in Decision 4 was load-bearing).
- **Rank-window crossover** (`hybrid-search.test.ts`): a mocked-repo `hybridSearch` call reproduces "8 bottom-of-window both-branches rows vs. a rank-1 single-branch identifier match" exactly per the audit's own reproduction shape; the identifier lands at rank 10 (page 2) under the old window (38) and rank <=8 under the new floor (64) — verified by hand-computing both window sizes against the identical `fuseRRFWithScores` construction.

No baseline files changed; the committed floors already hold (nothing regressed) and there is nothing to ratchet upward on this corpus. A future harness corpus sized specifically to exceed ~64 rows in a single scope partition would be needed to make this fix visible in `pnpm run eval` itself — not done here, to avoid corpus-gaming a specific number (the harness's own Decision 3 risk).
