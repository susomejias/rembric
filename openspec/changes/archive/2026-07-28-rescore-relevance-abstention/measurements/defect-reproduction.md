# Defect reproduction (task 0.3)

Both numbers this change is built on, re-measured on this machine rather than remembered.

## (a) `normalizeLexicalScore` has no usable dynamic range

Synthetic 200-row corpus, one term per band, read through
`MemoryRepository.searchBm25Ids` and passed through the (now deleted)
`1 / (1 + exp(bm25))`:

| Band    | term        | rows hit | raw `bm25()` | normalised       |
| ------- | ----------- | -------- | ------------ | ---------------- |
| 3/200   | `rareterm`  | 3        | -3.813178    | **0.9783990**    |
| 150/200 | `midterm`   | 150      | -9.891508e-7 | **0.5000002473** |
| 200/200 | `everyterm` | 200      | -1.037027e-6 | **0.5000002593** |

Curve shape, confirming the saturation:

| `bm25` | normalised     |
| ------ | -------------- |
| -1e-6  | 0.500000250000 |
| -0.5   | 0.622459331202 |
| -1     | 0.731058578630 |
| -5     | 0.993307149076 |
| -10    | 0.999954602131 |
| -20    | 0.999999997939 |

Matches the proposal (0.980 / 0.5000002 / 0.5000003 — the rare-term figure is
0.978 here, the corpus construction differs slightly). The claim it supports is
unaffected: **the value is always ≥ 0.5 and the whole observable range on a
realistic query is under 1e-5 wide, pinned just above 0.5.** Any floor ≤ 0.5
can never fire; anything above it is an IDF cliff.

Permanently guarded by `hybrid-search.test.ts` → "reaches the same gate decision
after 500 unrelated rows, where the replaced quantity has no range at all",
which recomputes the deleted normalisation and asserts it stays inside
`(0.5, 0.50001)` at both corpus sizes while the coverage level stays exactly 3/7.

## (b) RRF consecutive ratios at `RANK_CONSTANT = 60`

| Pair                                      | ratio                |
| ----------------------------------------- | -------------------- |
| single-branch rank 1 → 2                  | **0.983871**         |
| single-branch rank 200 → 201              | **0.996169**         |
| both-branches → single-branch, same rank  | **0.500000** (exact) |
| both-branches(m=1) → single-branch(m+1)   | 0.491935             |
| both-branches(m=200) → single-branch(m+1) | 0.498084             |

So the class-boundary ratio lives in `[0.4919, 0.5)` and the within-class ratio
in `[0.9839, 1)`. A consecutive-pair threshold therefore has exactly three
regimes and none of them is a statement about match quality:

- `≤ 0.4919` — never fires;
- `(0.5, 0.9839)` — returns only the rows both branches found;
- `≥ 0.9839` — truncates at rank 2.

Permanent unit test: `hybrid-search.test.ts` → describe
"RRF scores cannot carry a relevance threshold" (three cases, one of them
driving the real consecutive rule over a real `fuseRRFWithScores` pool).
