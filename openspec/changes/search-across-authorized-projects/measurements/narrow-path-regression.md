# Measurement — does the ordinary, non-widened `memory.search` get slower?

**This is the phase-0 baseline.** The feature accepts that a _widened_ search is heavier; that is what
the argument buys. What it does not accept is that the **ordinary single-project search — every call
that exists today — gets slower on the way there.** Phase 1 rewrites `scopeWhere` / `scopeCondition`
and every repository option bag, which the lexical branch and every scoped read go through; phase 4
rewrites the dense branch's predicate. Task 1.9 pins retrieval _quality_ across the collapse and task
2.2 measures narrow against widened _after_ it — neither compares narrow-before with narrow-after.
This document is what makes "we did not slow the normal search down" falsifiable instead of asserted.

Status: the **before** column is measured. The two **after** columns are placeholders, to be filled by
re-running the identical harness against the identical corpus directories.

---

## 0. What was measured, on which tree, and why that tree is `main`'s

Task 0.1 requires the baseline to be taken on `main` "before 1.1 lands", because the tree it measures
stops existing once the collapse starts. It was taken on branch `search-across-authorized-projects` at
`8617f40`, and the equivalence was **verified rather than assumed**:

```
$ git rev-parse main                        # 17c9706
$ git rev-parse HEAD                        # 8617f40
$ git diff --stat main HEAD -- apps/ scripts/ | wc -l
0
```

All three commits between `main` and `HEAD` touch `openspec/` only (`git diff --name-only main HEAD`
lists nothing outside `openspec/changes/search-across-authorized-projects/`), so the source tree the
baseline ran against is byte-identical to `main`'s. No checkout dance was performed and none was needed.

Conditions: 8 vCPU, 15 GB RAM, Node 22.23.1, `better-sqlite3@12.11.1`, SQLite 3.53.2, `sqlite-vec@0.1.9`,
corpora on real disk (not the tmpfs `/tmp`), no dev stack running.

## 1. The instrument, named once

**I2 END-TO-END** — one `await MemoryService.searchWithAbstention({ query }, projectScope(id))` call,
timed with `process.hrtime.bigint()`. It pays everything a user waits on: the query embedding, the
FTS/BM25 branch, the sqlite-vec kNN branch, RRF fusion, the term-statistics lookup, the relevance gate,
the ranking boost, the diversity cap and the row hydration.

It is **not** `knnByQueryVector`, and no figure in this document may be quoted beside one from
`vec-partition-capability.md`, whose every number is instrument **I1 ISOLATED STATEMENT**
(`CLAUDE.md`, "One instrument per series, named"). This is the same instrument task 2.2 is required to
use, so the two are comparable to each other and to nothing else.

Per process run: 5 warm-up queries discarded, then **40 timed queries**, reported as p50/p90. Six
independent process runs per magnitude — repeats are reported individually and never averaged, because
averaging is exactly what hid the bimodal cell corrected in `vec-partition-capability.md` §4.

The corpus is opened **read-only**. Consequences, stated rather than hidden: `createDb` skips
`migrate()` and its boot-time `ANALYZE` on a read-only handle, so every repeat plans against the same
`sqlite_stat1` the build left behind and the corpus file is provably untouched between repeats. The
read-path tuning pragmas (`cache_size = -65536`, `mmap_size = 268435456`, `temp_store = MEMORY`) are
applied on both paths, so the query path itself is the production one.

Reproduce:

```sh
sh openspec/changes/search-across-authorized-projects/measurements/narrow-path-run.sh \
   /root/corpora <resultsDir> before-phase-1 6
node openspec/changes/search-across-authorized-projects/measurements/narrow-path-summarize.mjs <resultsDir>
```

## 2. The corpus, and one property of it that constrains the whole comparison

Built by the shipped `apps/server/src/scripts/seed-volumetric.ts` at the three magnitudes task 2.1
names, seed `20260805`, sessions at one per fifty memories:

```
--db <root>/narrow-1000  --memories 1000  --sessions 20   --seed 20260805
--db <root>/narrow-20000 --memories 20000 --sessions 400  --seed 20260805
--db <root>/narrow-50000 --memories 50000 --sessions 1000 --seed 20260805
```

The measured scope is project **`vol-0`**, which is `VOLUMETRIC_SHAPE` **scope slot 1**. That choice is
load-bearing: `buildCorpus` assigns `scopeSlot = i % 6` with slot 0 global and slots 1–5 the five
projects, and `generateMemory(seed, i, scopeSlot)` is a pure function of those, so **slot 1's rows are
the same rows before and after the `Scope` collapse** — task 1.6 moves slot 0 off the global scope and
touches nothing else. Measuring the global slot would have measured a fixture change.

**A corpus cannot be rebuilt for the after-runs; the same directory must be reused.** `seed-volumetric`
reproduces a corpus's _content_ from its seed but not its _ids_: `memory.id` is `ulid(ts.getTime())`, and
the `ulid` package draws the random half from `Math.random()`. Verified by building the 1 000-memory
corpus twice at seed `20260805` and comparing: row count identical (1000/1000), the
`created_at`-ordered title list **identical**, the id list **different**
(`01JGFJJZ00NB100H1Q3R86VK9B` against `01JGFJJZ00N4SZ6416CM7YBDPT`). Ids reach ranking through RRF
tie-breaking and `ORDER BY id`, so a rebuilt corpus is a different corpus for this purpose. The
reproduction driver therefore skips any magnitude whose `data.db` already exists, and the harness's
query set is drawn from the corpus's own titles in `id` order so it is fixed per corpus.

Inherited caveat, restated because it bounds what these numbers support: the corpus vectors are
deterministic pseudo-random unit vectors, **not embeddings**, and the harness's query embedder is of
the same family. **No retrieval-quality, ranking, fusion or abstention claim may be drawn from any run
of this harness.** The claims here are wall-clock and row counts, neither of which depends on vector
semantics.

## 3. Non-vacuity — asserted at every magnitude, by the harness itself

A latency comparison over two empty result sets proves nothing, which is the trap
`before-after-digest-proofs` records and `retire-the-global-scope/measurements/scale.md` §0 opens with.
The harness therefore **exits non-zero** if any timed query returned zero rows, or if any returned row
carried a foreign `project_id`.

| magnitude | rows in `vol-0` | vectors in its partition | rows returned over 40 queries | min rows on any query | queries returning zero | foreign-project rows |
| --------: | --------------: | -----------------------: | ----------------------------: | --------------------: | ---------------------: | -------------------: |
|     1 000 |             167 |                      167 |                           320 |                     8 |                      0 |                    0 |
|    20 000 |           3 334 |                    3 334 |                           320 |                     8 |                      0 |                    0 |
|    50 000 |           8 334 |                    8 334 |                           320 |                     8 |                      0 |                    0 |

Every query returns a full page (`DEFAULT_SEARCH_LIMIT = 8`), at every magnitude, in all six repeats.
The foreign-row count is the same quantity phase 3 will gate as `foreignScopeRate`; it reads 0 here, as
it must on a non-widened query.

## 4. Baseline — narrow `memory.search`, before phase 1

Instrument **I2 END-TO-END**. Six independent process runs per magnitude, each the p50/p90 of 40 timed
queries. Raw JSON for every run is committed under `narrow-path-results/`.

| magnitude | p50 per repeat (ms)                               | p90 per repeat (ms)                           | median of the six p50s |
| --------: | ------------------------------------------------- | --------------------------------------------- | ---------------------: |
|     1 000 | 8.28 / 8.42 / 8.47 / **5.34** / 8.45 / 8.21       | 8.84 / 9.05 / 9.22 / 5.86 / 9.04 / 8.83       |                8.35 ms |
|    20 000 | **24.30** / 17.25 / 17.83 / 17.29 / 17.52 / 17.02 | 24.89 / 17.93 / 22.59 / 18.17 / 18.77 / 17.60 |               17.41 ms |
|    50 000 | 41.18 / 41.37 / 41.23 / 41.46 / 42.13 / 41.26     | 52.75 / 54.53 / 54.88 / 42.63 / 56.48 / 43.92 |               41.32 ms |

**Read the bolded cells before reading anything else.** Repetition did here what it did to the
predicate-free arm in `vec-partition-capability.md` §4: it found that a single run would have been
misleading. One process out of six drifted at 1 000 (**32% low**) and one out of six drifted at 20 000
(**40% high**), in **opposite directions**. Discarding those two cells, the residual spread across
repeats is 3.2% at 1 000, 4.8% at 20 000 and 2.3% at 50 000 — i.e. the instrument is tight per process
and occasionally shifts wholesale between processes. **No cause was established for either outlier and
none is claimed**; they are reported rather than smoothed, and they are the reason the statistic below
is a median of six rather than a mean or a single run.

The end-to-end curve is roughly linear in the project's own row count (167 → 3 334 → 8 334 rows against
8.35 → 17.41 → 41.32 ms), with a fixed floor of a few milliseconds that the 1 000-row magnitude is
dominated by.

## 5. The accepted tolerance — stated BEFORE any after-number was read

Written in the same commit as the baseline, so the threshold cannot be fitted to the result.

**The statistic** is the **median of the six per-process p50s**, per magnitude, plus the same median
over p90. A median of six absorbs exactly one drifted process, which §4 shows is this instrument's
observed failure mode.

**The tolerance is +15% on that median, at every magnitude, for both p50 and p90.** Derivation: the
worst residual repeat-to-repeat spread once the single outlier process is set aside is **4.8%** (20 000,
p50), so 15% is roughly three times the instrument's own reproducible noise. A rise above it at any
magnitude is a **regression to be explained and fixed, not a threshold to be raised.**

**What this tolerance explicitly cannot do**, stated so nobody reads a pass as more than it is: it
cannot detect a regression below about 5%, because that is inside the instrument's noise. If the
collapse costs 2% per call, this document will report "no regression" and be wrong in the third
significant figure. It is sized to catch the failure that actually threatens here — a rewritten
`scopeWhere` emitting a different plan, or a predicate that stops using an index — which is a
step change, not a 2% one.

**A pass is not sufficient on its own.** The collapse is supposed to be behaviour-preserving at the SQL
level: `scopeWhere('project', id)` must emit the same text against the same columns before and after.
That is a separate, stronger check than a timing comparison, and it is task 1.9's job.

## 6. After phase 1 / after phase 4

_Not yet measured. Same harness, same six repeats, same corpus directories — rebuilt corpora are
inadmissible for the reason in §2._

| magnitude | before (median p50) | after phase 1 | after phase 4 | tolerance (+15%) |
| --------: | ------------------: | ------------: | ------------: | ---------------: |
|     1 000 |             8.35 ms |             — |             — |          9.60 ms |
|    20 000 |            17.41 ms |             — |             — |         20.02 ms |
|    50 000 |            41.32 ms |             — |             — |         47.52 ms |

## 7. What this does NOT establish

1. **It is not a quality measurement.** Synthetic vectors; see the caveat in §2. `pnpm run eval` is the
   instrument for retrieval quality, and task 1.9 is where the collapse answers to it.
2. **It measures one project's narrow search, not the widened one.** Widening is task 2.2's subject,
   with the same instrument so the two tables can be read together.
3. **It measures the ranked branch only.** The entity branch (`memory.search({ entity })`) takes a
   different path through `searchWithAbstention` and is not timed here; phase 4 widens it too (D12).
4. **One machine, one day, one corpus shape.** `seed-volumetric` splits memories evenly across six
   scope slots; task 2.1 replaces that with a realistic skew, and a skewed corpus will move these
   absolute numbers. It does not invalidate the before/after comparison, which is run against the
   **same** corpus on both sides — but it does mean these millisecond figures are not a production
   forecast.
5. **It says nothing about concurrency.** One search at a time, one connection, no writer.
