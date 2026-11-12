# Measurements

Each file names its instrument, and rows from different instruments are never tabulated together. Each script takes a corpus cache directory as its only argument and prints the file beside it:

```sh
pnpm -r --filter "./packages/*" build
pnpm --filter @rembric/core exec tsx ../../openspec/changes/prune-common-terms-from-save-time-match/measurements/<script>.mts <cache-dir> > <script>.txt
```

## Corpora (`corpora.mts`)

- **Generator:** `buildCorpus` from `apps/web/src/scripts/seed-volumetric.ts` (`pnpm run corpus:build`), with default arguments and seed 1. Its prose draws on 150 words, so nearly every prose word is in more than half of the rows.
- **Realistic-vocabulary control:** the 73-item retrieval corpus, replicated across the generator's six-project round robin.
  - Copy 0 is verbatim.
  - In every other copy, each word made of terms found in fewer than 4 base items gets a per-copy suffix, so copies share only the words found in at least 4 base items.
  - Every shared word is therefore in at least about 5% of rows. That is harsher than a natural Zipf tail, and it is the reason pruning gains less here.

Both are built once per size (1 000, 20 000 and 50 000 rows) and copied before any script writes to them.

The `-skew` variants of both corpora use the generator's skewed project assignment. One project holds 2% of the rows, one 20% and one 60% (`SHARE_SLOTS`). `plans.txt`, `save-latency.txt` and `driven-and-rebuild.txt` use them.

## `idf-clamp.txt` — why the ratio is 0.5

**Instrument:** `bm25()` of one row matching one term in a temp FTS5 table, as the term's document share crosses one half.

FTS5 returns exactly `-1e-6` from `n = N/2` upward, and `-ln((N − n + 0.5)/(n + 0.5))` below it. The table shows this for N = 10, 11, 1 000 and 50 000. The ratio is therefore derived, the comparison is inclusive, and the `>=` boundary is pinned by a test (see `mutation.txt`).

## `statement.txt` — the save-time statement, the lookup, and behaviour

`statement.txt` isolates pruning. It was measured with the statement still ordered by `rank` (shape A); `plans.txt` measures both shapes.

**Probes:** 30 memories of the largest project, saved as three classes:

- `prefix80`, the first 80% of the memory's words;
- `reversed`, its words reversed;
- `commonOnly`, only its words that are in at least half the index, saved twice.

Each probe row is indexed first, as on the save path.

**Statement p50, natural probes that keep a rarer token:**

| corpus    | rows   | unpruned  | pruned    | rows matched  |
| --------- | ------ | --------- | --------- | ------------- |
| generator | 1 000  | 2.800 ms  | 0.413 ms  | 100.0% → 0.2% |
| generator | 20 000 | 37.875 ms | 1.805 ms  | 99.9% → 0.0%  |
| generator | 50 000 | 91.461 ms | 1.979 ms  | 99.9% → 0.0%  |
| realistic | 1 000  | 0.909 ms  | 0.572 ms  | 93.1% → 55.8% |
| realistic | 20 000 | 11.228 ms | 5.824 ms  | 92.8% → 58.5% |
| realistic | 50 000 | 30.164 ms | 14.943 ms | 94.3% → 58.6% |

Probes where the fallback fires keep today's expression and today's cost, within noise.

**Lookup p50** (`adminDocumentCount` plus `adminTokenTermFrequencies`, a separate instrument):

- generator: 0.297 ms, 2.539 ms and 5.117 ms;
- realistic: 0.153 ms, 0.660 ms and 1.607 ms.

The lookup is paid on every save, including saves where the fallback fires.

**How often the fallback fires, natural probes:**

- realistic: 0/60 at every size;
- generator: 14/60, 18/60 and 17/60.

The generator's long memories have 16 leading tokens all drawn from its 150-word vocabulary. Every `commonOnly` probe fires it, by construction.

**Behaviour** (post-floor lexical candidates, `commonTermRatio: null` against the shipped setting):

- **Realistic:** 0 lost and 0 gained at every size.
- **Generator:** 711, 746 and 784 lost, 0 gained.
  - Unpruned, the generator's 90 probes surface 1 587–1 755 candidates out of a 20-row pool each. Nearly every pooled row clears the floor, because every generator memory shares most of the same 150 words.
  - Nothing was gained anywhere. A lost row either shared only omitted common tokens with the save's leading 16 tokens, or was reordered out of the 20-row pool once those tokens stopped contributing their `1e-6` weights.
  - The probe's own target (its source memory, or its byte-identical twin) surfaced at exactly the unpruned rate in every class and at every size.

**Fallback size.** On fallback probes, keeping only the rarest 1, 2, 4 or 8 tokens lost targets on the generator at every size; for example 28/47 for keep 8 against 38/47 for keep all, at 50 000 rows. On the realistic control, keep 4 matched keep all but saved only 5 ms of 30 ms at 50 000 rows. Every restored token is in at least half the rows, so no count makes the fallback sublinear. Hence keep all, which is design D3.

**Phrases:** multi-term tokens whose terms are all common were 1 of 1 440 tokens (generator at 1 000 rows) and 0 everywhere else.

## `plans.txt` — statement shapes, by project share (query plan vs schema)

**Instrument:** statement wall clock, p50 of 3 per probe, then p50 over 10 probes. Fidelity compares each shape's top-20 `(id, score)` list with today's (shape A).

**Corpora:** the skewed generator and the skewed realistic control, with the saving project holding 2%, 20% or 60% of the rows, at 1 000, 20 000 and 50 000 rows.

**Shapes:** A (today, `ORDER BY rank`), B (shipped, `ORDER BY bm25(memory_fts)`), B2, E1, E2 and the floor; see the file header and design D7.

**Fidelity:** B matched A's ids and scores exactly in 360 of 360 probes. E1 and E2 never reproduced the scores.

**Shipped cost (B + pruning), saving project at 2%:**

- generator: 0.20, 0.91 and 2.48 ms;
- realistic: 0.68, 3.74 and 7.29 ms.

Today's (A, unpruned) at the same points:

- generator: 2.54, 42.46 and 88.04 ms;
- realistic: 2.14, 18.62 and 53.75 ms.

It still grows with the rows in other projects. Only E2 (an FTS table per project, which changes scores) stays nearly flat: 0.07, 0.09 and 0.26 ms, and 0.18, 0.36 and 0.54 ms.

## `driven-and-rebuild.txt` — the rejected memory-driven join, idf cost, rebuild time

**Instruments:** single-run wall clock for the joins and builds; p50 of 5 for idf.

- **Memory-driven join** (`memory CROSS JOIN memory_fts`), project at 2% of 50 000 generator rows: 5 195 ms unpruned and 711 ms pruned, against 41.2 ms and 2.45 ms for the shipped statement. FTS5 re-filters per outer row.
- **idf cost:** bm25 on a single row of a term present in all 50 000 rows costs 0.716 ms, against 0.010 ms without bm25. FTS5 counts the term's documents on every scoring cursor.
- **Rebuild:** `memory_fts` rebuild takes 1 146 ms (generator) and 277 ms (realistic) at 50 000 rows. Filling a temp FTS table with a project column took 934 ms and 243 ms. That is scale for the derived-index option, not a migration measurement.

## `save-latency.txt` — end to end, the base commit against this change

**Instrument:** paired `saveMemoryWithCandidates` wall clock, embedder not wired, 200 rounds.

**Design:** four arms save the same text in rotating order:

- **before:** the base commit's statement, replayed verbatim, with pruning off;
- **after:** as shipped;
- **pruning only:** pruning with the base statement;
- **before (b):** a second copy of before, as the noise band.

**p50, saving project at 2%** (before → after):

| corpus    | 1 000         | 20 000        | 50 000         |
| --------- | ------------- | ------------- | -------------- |
| generator | 13.59 → 11.53 | 49.50 → 14.33 | 109.28 → 22.03 |
| realistic | 3.19 → 2.47   | 20.42 → 6.40  | 34.49 → 8.98   |

**At 50 000 rows, 20% and 60% shares** (before → after):

- generator: 127.20 → 44.68 and 154.68 → 61.33;
- realistic: 34.10 → 10.15 and 44.14 → 20.13.

**Significance:** every after − before paired interval lies outside the b − a noise band; every b − a interval lies within [−0.50, 0.60] ms. The query-plan change contributes beyond pruning: on realistic at 50 000 rows and 2%, pruning only gives 21.04 ms against 8.98 ms for both. The generator's p90 stays higher, because saves where the fallback fires keep the full match set.

## `sweep.txt` and `sweep.diff` — save-time calibration sweep

**Command:** `pnpm run eval:save-time`.

**Control:** the same command on the base commit's code reproduces `add-save-time-lexical-floor/measurements/sweep.txt` byte for byte (`retrieval-eval.txt`), so every difference is caused by this change.

**Differences (`sweep.diff`):**

- They appear only at grid points 0.00–0.25, in both arms: unrelated saves write 0.2 fewer lexical rows per save, and the queue depth is 2 lower. At every grid point from 0.30 upward, including the shipped 0.60, the output is identical.
- The secondary series differs only at floor 0.00, where the retrieval-corpus ingest writes 275 pending rows instead of 289. At 0.60 it is 54, unchanged.

**Why:** a count at floor `f` counts rows with `similarity >= f`. Identical counts from 0.30 upward, with identical labelled-pair recall at every grid point, mean every row that disappeared had a similarity below 0.30. Those rows sat below the shipped floor anyway. They are rows that shared only common tokens with the save's leading tokens, which is what this change stops ranking.

The admissible plateau (0.55–0.70) and the chosen floor (0.60) are unchanged. After the query-plan change (design D7), the sweep was rerun and is byte-identical to this `sweep.txt` (`retrieval-eval.txt`).

## `retrieval-eval.txt` — retrieval evaluation

`dump-ids.ts` output is byte-identical before and after (sha256 `670ec7c1…`, 84 entries, 449 ids), and `pnpm eval` passes with identical metrics. This change does not touch the search path; the ingest's pending rows do not feed ranking.

## `mutation.txt` — the guards are covered

`scripts/mutate.mjs` caught 7 of 7 mutations:

- the pruning condition removed;
- `>=` weakened to `>`;
- the fallback removed;
- phrases pruned like single terms;
- saved-row-only tokens counted as kept;
- the constant moved;
- the seam default lost.

Removing the fallback also breaks four tests that predate this change: the non-ASCII lexical pass, two `not_conflict` suppression tests, and the at-floor admission test. On small corpora every shared token is common, so without the fallback the pass would find nothing.

The file also holds the RED run of the new tests on the code before the implementation. Separately, the four new `adminTokenTermFrequencies` repository tests failed with `adminTokenTermFrequencies is not a function` before the method existed.

## `search-path.txt` — interactive `memory.search` (investigation only, unchanged)

**Instruments** (separate):

- `searchBm25Ids` wall clock, unpruned against a pruned prototype;
- the term-statistics read the relevance gate already issues;
- `MemoryService.search` end to end, no embedder.

**Findings:**

- **Same growth.** The plan is `SCAN memory_fts VIRTUAL TABLE INDEX 0:M3 | SEARCH m USING INTEGER PRIMARY KEY (rowid=?) | USE TEMP B-TREE FOR ORDER BY`. The weighted `bm25(...)` order is not consumed by FTS5, so it is sorted in a temp B-tree after the join. But FTS5 still walks every matched row, and the join probes `memory` once per row before the project filter applies. Queries matched 97% (generator) and 90% (realistic) of all rows. The statement grows from 0.567 ms to 26.246 ms (generator) and from 0.344 ms to 7.778 ms (realistic) between 1 000 and 50 000 rows. End-to-end search grows from 3.657 ms to 32.399 ms and from 1.111 ms to 9.421 ms.
- **Pruning would help the search less, and would change results.**
  - On the realistic queries the prototype cut matched rows from 90% to 51% and the statement from 7.778 ms to 4.958 ms at 50 000 rows.
  - The top-8 lexical ids changed for 1 of 28 queries, which would move the retrieval baselines.
  - On the generator queries (6 common words) the fallback kept every token, so nothing changed.
- **The search path already pays for a frequency read.** The enabled relevance gate (`RELATIVE_LEVEL_RATIO`) reads `adminDocumentCount` and `adminQueryTermFrequencies` for every non-empty search (0.123–1.733 ms here). That read happens after the lexical branch, and is keyed by distinct term rather than per token.
- A search-path change would need its own OpenSpec change. It would also need a retrieval-eval sweep, because the ids move.

## What this change does not fix

The shipped statement no longer scores or sorts other projects' matches, but two costs still grow with the rows in other projects:

- FTS5 walks the kept tokens' postings in every project, and the join looks up each matching row before the project filter rejects it;
- bm25 counts each phrase's documents over every project, and so does the pruning lookup.

The saving project's share barely matters at the statement level. What grows is the index. Only a per-project index (E2) is near-flat, and it changes scores. Design D7 and its Open Questions leave that to the owner.
