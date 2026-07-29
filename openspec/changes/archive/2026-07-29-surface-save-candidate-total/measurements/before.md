# Candidate distribution at the SHIPPED pool size (task 1)

Measured 2026-07-29. Method: a throwaway probe (not a tracked file, deleted after)
ingesting `src/test/retrieval/corpus.ts` through `ingestCorpus` with the **real embedder**
and the real save path, then calling the shipped `findSaveTimeCandidates` once per ingested
row with `perSaveMax: 1000` so nothing is capped, at `poolSize = CANDIDATE_POOL_SIZE`.

**This is a post-hoc steady-state distribution, NOT a save-time measurement.** Every row is
present when every other row is measured, so each save meets a mature corpus — which is the
right model for a populated instance, and is not what row #1 actually faced at its own moment.

## Result — the shipped pool of 20 reproduces the proposal's figures exactly

```
=== poolSize=20 (the shipped CANDIDATE_POOL_SIZE) over 38 corpus rows, cap 5 ===
  total 427   mean 11.2   p50 10   p90 15   max 15
  rows exceeding the cap:            38/38  (100%)
  captured by the top-5:            190/427 (44%)  ->  56% of detected pairs dropped
  rows reaching the pool bound:       0

=== poolSize=50 (what the proposal used) — identical ===
  total 427   mean 11.2   p50 10   p90 15   max 15
  rows exceeding the cap:            38/38  (100%)
  captured by the top-5:            190/427 (44%)  ->  56% dropped
  rows reaching the pool bound:       0
```

Task 1.4 is therefore **not triggered**: the numbers quoted in `proposal.md` were produced at
`poolSize = 50` but hold unchanged at the shipped 20, so no correction is needed.

## The pool bound was never reached (task 1.3)

Max detected is **15**, against a per-channel bound of 20, and **0 of 38** rows reached it.
Stated plainly: **on this corpus the count is EXACT, not a lower bound.** The "lower bound"
wording in the requirement is protection for corpora larger than this one — it is not a
description of the measured data, and this record must not be read as evidence that the count
under-reports here. It does not.

The two pool sizes agreeing is the same fact from the other side: at 20 vs 50 nothing changes
because no channel ever filled its pool, so the merged list is complete either way.
