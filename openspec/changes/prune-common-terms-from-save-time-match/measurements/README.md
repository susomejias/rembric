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

## `idf-clamp.txt` — why the ratio is 0.5

**Instrument:** `bm25()` of one row matching one term in a temp FTS5 table, as the term's document share crosses one half.

FTS5 returns exactly `-1e-6` from `n = N/2` upward, and `-ln((N − n + 0.5)/(n + 0.5))` below it. The table shows this for N = 10, 11, 1 000 and 50 000. The ratio is therefore derived, the comparison is inclusive, and the `>=` boundary is pinned by a test (see `mutation.txt`).

## `statement.txt` — the save-time statement, the lookup, and behaviour

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

## `save-latency.txt` — end to end

**Instrument:** paired `saveMemoryWithCandidates` wall clock, embedder not wired.

**Design:** three arms (unpruned (a), pruned, unpruned (b)) save the same probe text in rotating order, in one process against one database. The paired median difference has a bootstrap 95% interval. The identical-arm difference (b − a) is the noise band.

| corpus    | rows   | unpruned p50 | pruned p50 | paired median (pruned − a), 95% | identical arms (b − a), 95% |
| --------- | ------ | ------------ | ---------- | ------------------------------- | --------------------------- |
| generator | 1 000  | 12.856 ms    | 10.028 ms  | −2.885 ms [−3.030, −2.686]      | −0.016 ms [−0.130, 0.120]   |
| generator | 20 000 | 50.996 ms    | 17.991 ms  | −31.445 ms [−32.742, −30.030]   | −0.005 ms [−0.167, 0.106]   |
| generator | 50 000 | 108.429 ms   | 30.022 ms  | −77.536 ms [−79.683, −74.958]   | −0.058 ms [−0.312, 0.274]   |
| realistic | 1 000  | 2.294 ms     | 2.038 ms   | −0.227 ms [−0.280, −0.173]      | 0.004 ms [−0.024, 0.028]    |
| realistic | 20 000 | 18.181 ms    | 12.185 ms  | −5.922 ms [−6.485, −5.338]      | −0.095 ms [−0.269, 0.073]   |
| realistic | 50 000 | 39.340 ms    | 25.334 ms  | −14.157 ms [−15.217, −12.777]   | −0.040 ms [−0.171, 0.139]   |

Every paired interval lies far outside its noise band, at every size including 1 000 rows. Adding the lookup did not cost the small corpus anything measurable; the save got faster there too.

The p90 of the pruned generator arm stays at the unpruned level (125 ms at 50 000 rows). Those are the saves where the fallback fires, which keep today's cost.

The pending-row totals differ a little between arms on the realistic control. They also differ between the two identical arms (1 273 against 1 257 at 1 000 rows): with the arms rotating, each arm's save sees the earlier arms' saves of the same text. They are not a behaviour measurement; `statement.txt` is.

## `sweep.txt` and `sweep.diff` — save-time calibration sweep

**Command:** `pnpm run eval:save-time`.

**Control:** the same command on the base commit's code reproduces `add-save-time-lexical-floor/measurements/sweep.txt` byte for byte (`retrieval-eval.txt`), so every difference is caused by this change.

**Differences (`sweep.diff`):**

- They appear only at grid points 0.00–0.25, in both arms: unrelated saves write 0.2 fewer lexical rows per save, and the queue depth is 2 lower. At every grid point from 0.30 upward, including the shipped 0.60, the output is identical.
- The secondary series differs only at floor 0.00, where the retrieval-corpus ingest writes 275 pending rows instead of 289. At 0.60 it is 54, unchanged.

**Why:** a count at floor `f` counts rows with `similarity >= f`. Identical counts from 0.30 upward, with identical labelled-pair recall at every grid point, mean every row that disappeared had a similarity below 0.30. Those rows sat below the shipped floor anyway. They are rows that shared only common tokens with the save's leading tokens, which is what this change stops ranking.

The admissible plateau (0.55–0.70) and the chosen floor (0.60) are unchanged.

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

On the realistic control the pruned statement still matches 56–59% of rows, because tokens in 5–50% of rows are kept. The document-frequency read is itself linear in the frequencies it counts. Save-time cost is lower, but it still grows with rows in other projects. Making it independent of them needs a project-restricted lexical index or ranking after the project join, which is listed as an open question in the design.
