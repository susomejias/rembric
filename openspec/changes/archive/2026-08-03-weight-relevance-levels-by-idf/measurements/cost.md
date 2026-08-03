# Cost of the term-statistics read

Five instruments across this file — end-to-end p50 (§5.2, §5.2b), in-search read time
(§5.2c), statement-level (§5.2d), row-membership (§5.2e) and scope-filtered `df`
(§5.2f). Each is named on every row and they are never tabulated together.

Method names in §5.1–§5.2e are as they were when each figure was taken. The two reads
now carry the `admin` prefix (`adminDocumentCount`, `adminQueryTermFrequencies`); the
rename is observationally inert and no figure was re-taken for it.

## §5.1 Query plans (`scratch-eqp.ts`, against the real migrated schema)

SQLite 3.53.2 / better-sqlite3 12.11.1, a freshly migrated database (all 30 migrations).

```
-- documentCount()
   SCAN memory USING COVERING INDEX memory_created_at_idx

-- termDocumentFrequencies() — the shipped json_each shape
   SCAN memory_fts_vocab VIRTUAL TABLE INDEX 259:
   LIST SUBQUERY 1
   SCAN json_each VIRTUAL TABLE INDEX 1:

-- term = ?
   SCAN memory_fts_vocab VIRTUAL TABLE INDEX 259:

-- term IN (literal list)
   SCAN memory_fts_vocab VIRTUAL TABLE INDEX 259:
```

`SCAN … VIRTUAL TABLE INDEX 259:` confirms the propose-phase probe against the real
schema: the vtable takes the `term` constraint, so this is a seek per term rather
than a scan per term. `documentCount()` is a covering-index scan of `memory`, which
is what the design costed at 0.018 ms at 50 000 rows.

**Task 10.3.4 — the amendment's read**, `EXPLAIN QUERY PLAN`ed against the real migrated
schema and asserted verbatim in
`db/repositories/term-statistics-repository.test.ts::'takes the term-constrained seek on
both sides of the join'`:

```
-- queryTermFrequencies() — insert + one LEFT JOIN
   SCAN q VIRTUAL TABLE INDEX 1:
   SCAN v VIRTUAL TABLE INDEX 259: LEFT-JOIN
```

Index 259 — the same term-constrained seek the shipped read already got — still appears,
so the join is a seek per query term and not a scan of the vocabulary.

## §5.2 End-to-end wall clock — the budgeted instrument

**Instrument:** one `MemoryService.search` call per sample, `performance.now()`
around it, no embedder wired (the dense branch is skipped identically in both
arms). Corpus built by `pnpm run corpus:build`'s `buildCorpus` (synthetic vectors;
no retrieval-quality claim is drawn from it — only timing).

**Arms, interleaved inside one process against one database** so warm-up, page
cache and machine drift hit both equally:

- **with** — shipped: `TermStatisticsRepository.documentCount()` +
  `termDocumentFrequencies()` both issued.
- **without** — the same tree with those two methods replaced by constants. The
  weighted-coverage arithmetic still runs, so the delta is the added SQL read and
  nothing else.

This is deliberately NOT "the pre-change tree": that tree also has the old
tokeniser, which changes the fused pool size and would confound the read's cost
with a different amount of work.

400 samples per size/limit, 200 per arm, after 40 warm-up calls. Two independent runs,
both on the final (split) tree.

| rows   | limit | run | with p50 (ms) | without p50 (ms) | **added p50 (ms)** |
| ------ | ----- | --- | ------------- | ---------------- | ------------------ |
| 1 000  | 8     | 1   | 3.116         | 2.976            | 0.140              |
| 1 000  | 8     | 2   | 3.107         | 2.960            | 0.147              |
| 1 000  | 200   | 1   | 4.028         | 3.914            | 0.115              |
| 1 000  | 200   | 2   | 5.691         | 5.446            | 0.245              |
| 20 000 | 8     | 1   | 7.557         | 7.486            | 0.070              |
| 20 000 | 8     | 2   | 6.259         | 5.972            | 0.287              |
| 20 000 | 200   | 1   | 16.150        | 15.876           | 0.275              |
| 20 000 | 200   | 2   | 15.342        | 15.056           | 0.286              |
| 50 000 | 8     | 1   | 15.898        | 15.247           | 0.650              |
| 50 000 | 8     | 2   | 15.852        | 15.303           | 0.549              |
| 50 000 | 200   | 1   | 26.598        | 26.206           | 0.392              |
| 50 000 | 200   | 2   | 26.583        | 26.146           | 0.436              |

Every `added p50` is positive and every one is under the budget, across both runs and
all three sizes.

## §5.2b The amendment arm — same instrument, a different machine

Re-taken for task 10.5.2 with the amendment applied. Artifact:
`cost-amendment.mjs`, output `cost-amendment.txt`. Three arms interleaved in one
process against one database per size:

- **none** — the frequencies B would have returned, served from a pre-warmed
  in-process cache. Identical frequencies on purpose: an arm that weights every
  term equally changes the levels, so the relative filter keeps a different number
  of rows and the delta would include that downstream work rather than the read.
- **A** — pre-amendment: JS `indexTerms` + `WHERE term IN (json_each(?))`.
- **B** — the amendment: `delete-all` + insert + one `LEFT JOIN`.

The `added` and `B − A` columns are the **median of paired differences** (same
query, same moment, three arms), not a difference of medians.

**This machine is roughly 2× slower than the one §5.2 above was taken on** (50 000
rows / limit 8: `none` p50 35.8 ms here against §5.2's 15.2–15.9 ms for the same
corpus builder). Absolute values across the two tables are therefore NOT
comparable; only within-run comparisons are.

| rows   | limit | none p50 | A p50  | B p50  | added A | **added B** | **B − A** | added B p90 |
| ------ | ----- | -------- | ------ | ------ | ------- | ----------- | --------- | ----------- |
| 1 000  | 8     | 3.798    | 3.979  | 4.011  | 0.111   | 0.214       | 0.079     | 0.598       |
| 1 000  | 200   | 5.836    | 6.196  | 6.083  | 0.271   | 0.230       | 0.042     | 0.590       |
| 20 000 | 8     | 15.003   | 15.826 | 16.200 | 0.842   | 0.895       | 0.040     | 3.057       |
| 20 000 | 200   | 28.721   | 29.938 | 29.699 | 0.957   | 1.061       | 0.083     | 2.937       |
| 50 000 | 8     | 35.781   | 38.022 | 38.335 | 0.370   | 0.541       | 0.116     | 7.047       |
| 50 000 | 200   | 53.830   | 51.069 | 57.145 | 0.110   | 2.610       | 0.709     | 7.143       |

Read this table with its noise band in view: `added B p90` reaches 7.1 ms at 50 000
rows, so **this instrument cannot resolve a 1.0 ms budget at that size on this
machine**. The 50 000/200 row is internally inconsistent (`added A` 0.110 against
`added B` 2.610, while §5.2c below measures the two reads within 0.05 ms of each
other) and is reported rather than dropped.

## §5.2c In-search read time — a third instrument, named and kept apart

Time spent **inside** `queryTermFrequencies` during a real search, 60 searches per
cell. It answers what the two arms cost each other without a 36–57 ms search in the
way, and it is the instrument the `B − A` conclusion rests on.

| rows   | limit | A (term IN) | B (LEFT JOIN) | B − A  |
| ------ | ----- | ----------- | ------------- | ------ |
| 1 000  | 8     | 0.180       | 0.240         | 0.060  |
| 1 000  | 200   | 0.162       | 0.237         | 0.075  |
| 20 000 | 8     | 0.904       | 0.974         | 0.070  |
| 20 000 | 200   | 0.937       | 1.028         | 0.091  |
| 50 000 | 8     | 2.234       | 2.308         | 0.074  |
| 50 000 | 200   | 2.365       | 2.323         | −0.042 |

The read is called exactly **once per search** in both arms (measured, column
`calls/search` in the artifact).

**A contradiction with §5.2, recorded rather than reconciled.** §5.2 reports the
whole read as adding 0.392–0.650 ms end-to-end at 50 000 rows; measured from
inside, the same read costs 2.2–2.4 ms there. Both were taken on the same corpus
builder, on different machines and with different estimators. The likely mechanism
for the gap is page sharing — the vocabulary read touches `memory_fts` pages the
lexical branch reads immediately afterwards, so skipping it moves cost rather than
removing it — but that is a hypothesis, not a measurement, and it is not what
either number rests on.

## §5.2d Statement-level, 50 000 rows — the marginal the amendment owns

`STATEMENT_ITERATIONS = 400`, one warm process, the read alone, no search around
it. **Never to be tabulated with §5.2 or §5.2b.**

| rows   | vocabulary | A ms/query | B ms/query | marginal | rows returned A | rows returned B | of which absent |
| ------ | ---------- | ---------- | ---------- | -------- | --------------- | --------------- | --------------- |
| 1 000  | 11 990     | 0.1580     | 0.1817     | 0.0237   | 7.9             | 9.0             | 1.1             |
| 20 000 | 136 569    | 1.2395     | 1.2740     | 0.0345   | 7.9             | 9.0             | 1.1             |
| 50 000 | 290 456    | 3.0995     | 3.3643     | 0.2648   | 7.9             | 9.0             | 1.1             |

Repeated runs of the 50 000-row cell gave marginals of −0.0505, −0.0009, −0.6353,
+0.2648 ms: the marginal is **at or below the noise floor of ±0.6 ms**, on a
7-query mixed shape against a 290 456-term vocabulary. The propose-phase figures to
beat were 0.1034 ms (owner, 90 008-term vocabulary) and 0.4917 ms (re-measured,
70 018-term vocabulary); those two disagree ~5× and this third measurement lands
between them without adjudicating either — different corpus shapes, three
instruments' worth of noise, and all three well under 1.0 ms.

**Task 10.5.3, the term count as evidence:** B returns **9.0** rows per query where
A returns **7.9** — the 1.1-term difference is exactly the absent terms, which A
can only omit and B reports as `NULL`. Same direction as the propose-phase pair
(18.8 versus 16.8; owner 19 versus 13), smaller in magnitude because these queries
are drawn from the corpus's own vocabulary.

## §5.2e Task 10.5.4 — the price of an index-authoritative ROW side, re-taken

Artifact `row-side-price.mjs`, output `row-side-price.txt`. Instrument: time to
decide which of a POOL of candidate rows contains each of one query's terms — the
operation `weightedCoverage` performs per search. 50 000-row corpus, 60 queries per
cell, p50.

| row-membership source                        | pool 64 | pool 200 | pool 400  |
| -------------------------------------------- | ------- | -------- | --------- |
| JS `indexTerms` over the pool — today        | 2.251   | 6.660    | 12.980    |
| pool insert + per-term `MATCH`               | 4.771   | 15.405   | 34.347    |
| pool insert + filtered instance read         | 4.878   | 15.624   | 37.371    |
| cached by memory id, warm instance read      | 0.273   | 0.520    | **0.941** |
| per-term `MATCH` against `memory_fts` ∩ pool | 3.723   | 11.530   | 22.942    |

**One variant lands under the 1.0 ms budget, and that is a finding against the
design.** `design.md` D3b priced "same, cached by memory id across queries (warm)"
at 4.771 / 6.102 / 8.521 ms; measured here it is 0.273 / 0.520 / 0.941 ms — under
budget at every pool size and faster than the shipped JS arm. Task 10.5.4 says that
if any variant lands under 1.0 ms the design decision changes and D3b must be
revisited.

What the same probe also measures is **why it does not survive contact with a real
process**, which is the mechanism D3b named ("the instance read then scans a
growing cache"):

| warm cache holds | term instances | pool-400 read p50 |
| ---------------- | -------------- | ----------------- |
| 400 rows         | 85 525         | 0.966             |
| 5 000 rows       | 1 096 239      | 2.395             |
| 39 998 rows      | 8 733 845      | 13.099            |

So the sub-millisecond figure holds only while the cache holds approximately the
pool itself. A process serving many queries accumulates a working set, and by 5 000
cached rows the read is 2.4× the budget; bounding the cache at pool size instead
returns most rows to the cold path, which costs the 34–37 ms of the insert arms.
**Recorded and handed to task 10.8.1 as its brief; the shipped decision is
unchanged, and this session did not re-open it.** The re-take also confirms the
direction for the other three variants: 2.6×–2.9× the JS arm at pool 400.

## §5.3 The budget

**Budget (design.md D5): added end-to-end p50 ≤ 1.0 ms at 50 000 rows.**

Measured at 50 000 rows: **0.650 / 0.549 ms at limit 8** and **0.392 / 0.436 ms at
limit 200**, across two runs. Every measurement is under the budget with margin.

**Decision: the plain read ships. The bounded `term → df` memo (design.md D5) is
NOT implemented**, per the design's own default ("only if the measurement demands
it"). §5.5's staleness window therefore does not arise: there is no memo to go
stale.

A separate figure for context, from a different instrument and not comparable with
the table above: the hybrid eval p50 is 8.000 ms before and 8.439 ms after on the
40-row corpus WITH embedding, against 11.659 ms recorded by the previous change on the
same fixture. The budget is expressed against the 50 000-row synthetic corpus above,
not against that number.

**The amendment against the same budget.** The amendment replaces the read rather
than adding one, so the quantity it owns is `B − A`: **0.116 ms at 50 000 / limit 8
and 0.709 ms at 50 000 / limit 200** end-to-end (§5.2b), and **0.074 / −0.042 ms**
on the in-search instrument (§5.2c) whose noise band is an order of magnitude
tighter. Both are inside the 1.0 ms budget, and the statement-level marginal
(§5.2d) is at the noise floor. The memo stays unimplemented.

What §5.2b cannot support is the stronger claim that the term-statistics read as a
whole adds under 1.0 ms at 50 000 rows: §5.2c measures the read at 2.2–2.4 ms
there, and §5.2b's own p90 noise band is 7 ms. §5.2's figures are left standing as
taken; §5.2c contradicts them and both are on the record.

## §5.2f Scope-filtered `df` — why the read is unscoped, on a fifth instrument

Taken for the `data-access` delta's claim that the scoped alternative to
`adminQueryTermFrequencies` is dead. Artifact: `scoped-df-price.mjs`, output
`scoped-df-price.txt`.

**Instrument:** ISOLATED STATEMENT TIME for the `df` read alone — the terms of one
query resolved to their document frequencies, once per search. p50 of 40 iterations
per (scope, query) cell, one warm process, 50 000-row corpus over six scopes
(`buildCorpus`, `VOLUMETRIC_SHAPE.scopeCount = 6`: global plus five projects).
**Never to be tabulated with §5.2 or §5.2b**, which measure whole searches.

**Arms**, interleaved per cell:

- **A global** — shipped: insert the query text into the temp tokenising table, one
  `LEFT JOIN` against `memory_fts_vocab`.
- **B scoped** — the same tokenisation, then one scope-filtered `count(*)` over
  `memory_fts MATCH <term>` per term. There is no filtered vocabulary read to measure
  instead: `memory_fts_vocab` exposes `(term, doc, cnt)` and has no scope column, so
  `fts5vocab` cannot be scope-filtered at all.

**Control:** scoped `df` ≤ global `df` on **228 of 228** `(scope, term)` pairs. Without
it a cheap B could just be counting the wrong thing.

| query    | scopes | terms | A global p50 (ms) | B scoped p50 (ms) | **marginal (ms)** |
| -------- | ------ | ----- | ----------------- | ----------------- | ----------------- |
| 3 terms  | 6      | 3     | 1.197–1.333       | 29.625–37.183     | 28.4–35.9         |
| 6 terms  | 6      | 6     | 2.271–2.382       | 51.943–63.461     | 49.6–61.1         |
| 10 terms | 6      | 10    | 3.586–3.758       | 90.213–115.557    | 86.6–111.8        |
| 19 terms | 6      | 19    | 2.351–2.388       | 52.529–62.430     | 50.2–60.0         |

Range over all 24 cells: **A 1.197–3.758 ms**, **B 29.625–115.557 ms** per search.

Two readings worth keeping. Cost tracks the length of the posting lists the terms
carry, not the term count — the 19-term query is cheaper than the 10-term one because
its terms are mostly function words with short per-scope survivor sets after the join,
while the 10-term arm is all corpus vocabulary. And the global scope is consistently
the cheapest of the six, which is the `project_id IS NULL` branch of the scope clause.

**The comparison that decides it, on the other instrument and quoted separately:**
the whole search measures an end-to-end p50 of **15.2–15.9 ms** at 50 000 rows / limit
8 (§5.2). A scoped `df` at 29.6–115.6 ms of statement time is therefore between two
and seven times the entire operation a caller waits on. The prior figure carried into
this change's review was 37–121 ms on another machine; this re-take is the one with a
script behind it, and it does not change the conclusion.
