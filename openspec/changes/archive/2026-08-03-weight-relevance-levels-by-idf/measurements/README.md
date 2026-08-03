# Measurements

Artifacts backing this change's numbers. Commands are run from `apps/server` unless
stated otherwise. Every "after" number in this file has its "before" recorded beside
it; a number with no recorded before is not evidence.

| File                     | Produced by                                                                                   | Task    |
| ------------------------ | --------------------------------------------------------------------------------------------- | ------- |
| `sweep-before.txt`       | copied verbatim from `archive/2026-07-28-rescore-relevance-abstention/measurements/sweep.txt` | 0.1     |
| `eval-before.json`       | `npx tsx src/test/retrieval/run-eval.ts` (`.eval-report/summary.json`)                        | 0.2     |
| `ids-before.json`        | `npx tsx src/test/retrieval/dump-ids.ts <out>`                                                | 0.3     |
| `ids-tokenizer.json`     | `npx tsx src/test/retrieval/dump-ids.ts <out>`, tokeniser change only                         | 1.4     |
| `ids-tokenizer-diff.txt` | per-entry diff of the two files above                                                         | 1.4     |
| `cost.md`                | see §5                                                                                        | 5.1–5.3 |
| `sweep-after.txt`        | `npx tsx src/test/retrieval/run-eval.ts --sweep-abstention`                                   | 6.1     |
| `eval-after.json`        | `npx tsx src/test/retrieval/run-eval.ts`                                                      | 7.2     |
| `ids-after.json`         | `npx tsx src/test/retrieval/dump-ids.ts <out>`                                                | 8.3     |
| `ids-after-diff.txt`     | per-entry diff of `ids-before.json` and `ids-after.json`                                      | 8.3     |

`pnpm run eval` is the documented entry point; it is invoked here as
`npx tsx src/test/retrieval/run-eval.ts` from `apps/server`, which is what that
script runs.

## 0. The before, recorded once

### 0.1 `sweep-before.txt`

Copied unmodified. `sha256 = 0092e070f909cf471566dfc57c26946d30216ec86422080af6d3f53cf02a03e8`.

Every later comparison cites this file, not a re-run.

### 0.2 `eval-before.json` — hybrid, on unmodified `main`

Instrument: the evaluation harness's own end-to-end per-query timing
(`RawOutcome.latencyMs`, one `MemoryService.search` call including embedding),
aggregated over the 24 committed queries against the 40-row corpus.

| retriever | k   | P@k     | R@k     | MRR@k   | abstentionFP | overAbstain | avgTokens | p50 ms | p95 ms |
| --------- | --- | ------- | ------- | ------- | ------------ | ----------- | --------- | ------ | ------ |
| hybrid    | 5   | 0.23750 | 0.96875 | 0.78333 | 1.000        | 0.000       | 273.75    | 8.000  | 9.918  |
| hybrid    | 8   | 0.15625 | 1.00000 | 0.78333 | 1.000        | 0.000       | 412.17    | 8.000  | 9.918  |

`p50`/`p95` are reported per retriever, not per `k` — the harness calls the
retriever once at `MAX_K = 8` and scores that one call at both `k`, so the two
rows quote the same measurement.

### 0.3 `ids-before.json`

72 entries (24 queries × limits 5 / 8 / 200), **469 ids total — non-empty**, so a
later digest comparison is not comparing two empty sets.
`sha256 = d0e1921fbcd340fccacc94a012ec4b134ce4941c621dc4f80c88dac3851cff0e`.

Ids are projected to the corpus's stable fixture ids; the DB ids are ULIDs minted
per ingestion and would differ between two runs of the same tree.

### 0.4 Corpus frozen

`git diff --stat main -- apps/server/src/test/retrieval/corpus.ts apps/server/src/test/retrieval/queries.ts`
is empty. Re-confirmed in §7.1.

## 1. Tokenisation: split into two jobs, and only one is index-aligned

`tokenizeWords` was one function serving two callers with different needs. It is split
(`design.md` D3a, decided during apply):

- `tokenizeWords` — whitespace-delimited words, `sanitizeFtsQuery` ONLY. Unchanged from
  `main`, so `"rate-limit"` stays one quoted FTS5 phrase and its adjacency requirement
  survives.
- `indexTerms` — exactly the terms `unicode61` stores.
- `tokenSet` — built on `indexTerms`; the ONE token vocabulary both token-set
  comparisons use (the level's weighted coverage and save-time containment).

### 1.1–1.2 The mismatch, re-measured here

better-sqlite3 12.11.1 / SQLite 3.53.2. Sample
`Migración de cron programada; validación — Atlas's pipeline? v1.2 rate-limit UTF_8 CamelCase`:

- FTS5 `unicode61`: `2 | 8 | atlas | camelcase | cron | de | limit | migracion | pipeline | programada | rate | s | utf | v1 | validacion`
- shipped `tokenizeWords` on `main`: `migración | de | cron | programada; | validación | atlas's | pipeline? | v1.2 | rate-limit | utf_8 | camelcase`
- **3 of 11** shipped tokens are FTS5 terms; the other 8 would resolve to `df = 0`, the maximum weight.

`src/services/tokenizer-agreement.test.ts` asserts set equality for `indexTerms` over
the WHOLE committed corpus (40 memories × title + content + tags) and all 24 query
strings — 104 texts, 707 distinct index terms — in both directions, plus per-text
agreement, plus the same equality for `tokenSet` (which is what the weighting is
actually keyed on).

### 1.3 Mutation check (`node scripts/mutate.mjs`, one condition weakened per run)

Every one of these was run and its real outcome recorded; none is asserted.

| #   | file:function      | mutation                                                                                        | outcome                                                                                                                                    |
| --- | ------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| a   | `indexTerms`       | `raw.replace(/\p{M}/gu, '').toLowerCase()` → `raw.toLowerCase()` (drop diacritic folding)       | CAUGHT by 4                                                                                                                                |
| b   | `indexTerms`       | split `/[^\p{L}\p{N}\p{M}]+/u` → `/\s+/u` (drop punctuation splitting)                          | CAUGHT by 4                                                                                                                                |
| c   | `indexTerms`       | drop the trailing `.toLowerCase()` (drop case folding)                                          | CAUGHT by 4                                                                                                                                |
| d   | `sanitizeFtsQuery` | `tokenizeWords(query)` → `indexTerms(query)` (collapse the split, MATCH side)                   | CAUGHT by `noise-rate.test.ts::the published table matches the measurement`                                                                |
| e   | `sanitizeFtsQuery` | same mutation, run against the unit suite                                                       | CAUGHT by `hybrid-search.test.ts::neutralizes punctuation/accents/operators…`                                                              |
| f   | `tokenSet`         | `indexTerms(text)` → `tokenizeWords(text).map(lowercase)` (collapse the split, comparison side) | **NOT CAUGHT at first** — nothing pinned it; a test was added and it is now CAUGHT by `is the vocabulary tokenSet hands to the weighting…` |

(a)–(c) are caught by `produces the same term set the index stores`,
`is the vocabulary tokenSet hands to the weighting, not merely a function beside it`,
`agrees text by text, not merely in aggregate` and
`does not fabricate a rare term out of punctuation or a diacritic`.

(d)–(f) are what pin the SPLIT itself, in both directions, so the next author cannot
collapse the two functions back together. (f) is recorded as it happened: the first run
found no coverage at all, which is exactly what mutation checking is for.

### 1.4 Result composition, tokenisation change alone

Isolated by running the final tree with the weighting removed (`weightedCoverage`
returning `tokenContainment`), so the only difference from `main` is which vocabulary
`tokenSet` produces. `ids-before.json` → `ids-tokenizer.json`: **24 of 72 entries
moved** (0 reorder-only), 469 → 484 ids total, both non-empty. Per-entry diff in
`ids-tokenizer-diff.txt`.

Why it moves at all with MATCH preserved: the relative filter is live at 0.40 and reads
a coverage computed over a different vocabulary. Folding `migración` to `migracion` and
splitting `rate-limit` into `rate` + `limit` changes which query terms a row counts as
covering, so rows move across `0.40 × leaderLevel`. The fused pool itself is unchanged —
the per-query pool sizes in `sweep-after.txt` are byte-identical to the pre-split run.

### 1.5 Save-time candidate similarity, before and after

`tokenContainment(tokenSet(saved), tokenSet(candidate))` over a fixed ordered pair set
(best match first by construction). Instrument: the pure containment function, not a
DB round trip.

| candidate                                    | similarity before | similarity after |
| -------------------------------------------- | ----------------- | ---------------- |
| identical                                    | 1.0000            | 1.0000           |
| same content, punctuation and accents differ | 0.5556            | 1.0000           |
| half the sentences                           | 0.4444            | 0.4762           |
| one shared term                              | 0.1111            | 0.0952           |
| disjoint                                     | 0.0000            | 0.0000           |

Range stays `[0,1]` on both sides. The sequence is non-increasing down the ordered
list on both sides, so monotonicity in match quality is preserved. The value is a pure
function of the two texts — no corpus, no scope, no term statistic is read — so it is
unchanged by the scope it is computed in; `src/services/relevance-weighting.test.ts`
asserts that at the seam, in two scopes whose other memories differ entirely.

Values **do** move, and the largest move is a correction: a candidate whose text
differs from the save only in punctuation and accents scored 0.5556 and now scores
1.0000, which is what "byte-identical after the index's own folding" should report.

`sanitizeFtsQuery` `maxTerms` accounting is **unchanged**: the cap still counts
whitespace-delimited words, because `sanitizeFtsQuery` still reads `tokenizeWords`.
`Rate-limit the Atlas API: 100 req/min per token` produced 8 capped units on `main` and
produces 8 here. (Under the abandoned option A it produced 10, and
`findSaveTimeCandidates`' `maxTerms: 16` would then have covered fewer _words_ of the
saved text. That regression does not exist on this tree.)

### 1.6 The candidate SET — measured, and it does not move

The proposal's Impact section says the save-time path's "reported `similarity` values
move without changing range or monotonicity". Under option A (one tokenisation for both
jobs) that understated it: the candidate SET moved as well, because `sanitizeFtsQuery`
shared the tokeniser and a hyphenated word stopped being an FTS5 adjacency phrase.

**The split removes that entirely.** `sanitizeFtsQuery` reads `tokenizeWords`, unchanged
from `main`, so every MATCH expression this tree builds is byte-identical to `main`'s.

Which tokenisation `findSaveTimeCandidates`' containment reads was then decided on
measurement, not by inheritance — it is a token-set job and could have gone either way.
Instrument: pending `memory_relations` rows in `src/test/mcp-integration.test.ts`'s
shared server, counted by the same probe at the same line, with only `tokenSet`'s
implementation swapped between runs.

| containment reads                                    | pending `memory_relations` | `mcp-integration` suite |
| ---------------------------------------------------- | -------------------------- | ----------------------- |
| `tokenSet` → `indexTerms` (shipped)                  | **17**                     | 49 passed               |
| `tokenSet` → whitespace words, lowercased            | **17**                     | 49 passed               |
| _(option A, for reference: both jobs index-aligned)_ | _89_                       | _3 failed_              |

**Identical.** So the earlier 17 → 89 blowup was **entirely** the loosened MATCH and
**none of it** containment — the hypothesis was that the MATCH caused it, and the
measurement confirms it. The choice is therefore free, and is made on the contract
instead: memory/spec.md requires ONE tokenisation shared by the search path and the
save-time candidate path, and the search path's token-set job is index-aligned, so
containment reads `tokenSet`.

Corroborating instrument, committed 40-row eval corpus ingested with no embedder
(lexical + entity channels only): `candidatesDetected` 228, surfaced 145, saves with any
37, pending relations 145 — the same figures measured on both option-A arms, so this
corpus is saturated and discriminates nothing here. It is reported so the `mcp-integration`
figure is not mistaken for the only measurement taken.

### 1.7 The three acceptance conditions for the split

1. **`src/test/entity-noise/noise-rate.test.ts` green with `PUBLISHED_NOISE` byte-identical.**
   `git diff main --stat -- apps/server/src/test/entity-noise/` is **empty**; the suite
   reports 4 passed. Since `openspec/specs/memory-entities/spec.md:80` requires that
   measurement to run "the REAL lexical path (`sanitizeFtsQuery` into the production
   BM25 read over a live FTS5 index)", an untouched table passing IS the proof that
   MATCH semantics were preserved.
2. **The 3 order-dependent `mcp-integration.test.ts` assertions green, pendings back at 17.**
   49 passed; pendings measured at **17** (was 89 under option A).
3. **`proposal.md`'s "Checked and deliberately NOT modified: … `memory-entities`" is true again.**
   Verified, not assumed: no file under `openspec/specs/memory-entities/` or
   `apps/server/src/test/entity-noise/` differs from `main`, and the measurement that
   backs the published table reproduces it exactly.

## 6. The sweep, and what it decides

`sweep-after.txt` is `npx tsx src/test/retrieval/run-eval.ts --sweep-abstention` against
the frozen corpus and query set, re-run on the final (split) tree. Two consecutive runs
were **byte-identical** (§4.3).

It was also diffed against the pre-split run rather than carried forward. Result: the
leader table, every per-query `df` row and the whole separability block are
**byte-identical**, and in the 220-row grid every column except the last is
byte-identical too. `avgTokensReturned` moved by 1–2 on 21 rows. That is the split
doing what it should: the fused pool per query is unchanged (same sizes, same leader,
same levels), but reverting the MATCH changes the lexical branch's rank order, so RRF
puts slightly different rows on the page. No calibration-bearing number moved, so every
verdict below is the same on both runs.

### 6.2 Separability — the headline measurement

Compared line-for-line with `sweep-before.txt`:

|                         | before (`sweep-before.txt`)                                                                     | after (`sweep-after.txt`)                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| gold-bearing, ascending | 0.333 0.351 0.381 0.385 0.400 0.429 0.429 0.500 0.556 0.571 0.600 0.667 0.667 0.667 0.750 0.833 | 0.296 0.297 0.312 0.343 0.351 0.379 0.381 0.416 0.464 0.471 0.525 0.618 0.632 0.633 0.636 0.747 |
| abstention, descending  | 0.455 0.375 0.307 0.300 0.300 0.300 0.250 0.200                                                 | 0.307 0.307 0.259 0.248 0.220 0.184 0.159 0.150                                                 |
| lowest gold-bearing     | 0.333                                                                                           | 0.296                                                                                           |
| highest abstention      | **0.455**                                                                                       | **0.307**                                                                                       |
| verdict                 | NOT separable                                                                                   | NOT separable                                                                                   |
| overlap width           | **0.122**                                                                                       | **0.011**                                                                                       |

The highest abstention level fell **0.148** and the overlap narrowed by **91%**
(0.122 → 0.011). The named offender behaved exactly as the proposal predicted:
`q-abstain-global-changelog` — "how does the user want changelog entries written for a
release" — scored 0.455 on function words and now scores **0.307**, and its `df` row in
the sweep shows why (`the=33 a=26 user=12 for=9 does=1 want=1`, against
`changelog=0 how=0 release=0 written=0`).

The classes still overlap, on `[0.296, 0.307]`.

### 6.3 The five criteria, applied to the abstention floor

Criteria from `openspec/specs/memory/spec.md` as modified by this change's delta.
Grid steps unchanged: floor 0.05, ratio 0.1 (§4.2 — not refined).

| floor | overAbstain @5/@8 | abstainFP | P/R/MRR vs committed floors | verdict                     |
| ----- | ----------------- | --------- | --------------------------- | --------------------------- |
| n/a   | 0.000 / 0.000     | 1.000     | pass                        | control, gate off           |
| 0.20  | 0.000 / 0.000     | 0.625     | pass                        | admissible                  |
| 0.25  | 0.000 / 0.000     | 0.375     | pass                        | admissible                  |
| 0.30  | **0.125 / 0.125** | 0.250     | R@5 0.844 < 0.91875 fails   | **rejected — costs recall** |
| 0.35  | 0.250 / 0.250     | 0.000     | fails                       | rejected                    |
| 0.40  | 0.438 / 0.438     | 0.000     | fails                       | rejected                    |
| 0.45  | 0.500 / 0.500     | 0.000     | fails                       | rejected                    |
| 0.50  | 0.625 / 0.625     | 0.000     | fails                       | rejected                    |
| 0.55  | 0.688 / 0.688     | 0.000     | fails                       | rejected                    |
| 0.60  | 0.688 / 0.688     | 0.000     | fails                       | rejected                    |

(P/R/MRR read at ratio 0.40, the shipped ratio; the same verdicts hold at ratio `n/a`.)

Criterion 5 is what fails. The admissible measured points are **0.20 and 0.25 only** —
a measured band 0.05 wide, and 0.25 is adjacent to a failing point. The criterion
requires a plateau at least **0.10 wide in level units** with the chosen value in its
interior, which at a 0.05 step means two admissible measured points either side. 0.25
has none above it; 0.20 has none below it (0.20 is the grid's lowest non-null floor,
and the criterion is not satisfiable by adding one).

The band's true upper edge is the lowest gold-bearing level, **0.296** — 0.046 above
0.25 and 0.096 above 0.20. So even reading the band as `(0, 0.296)` rather than as grid
points, **no value has 0.10 of margin on both sides**.

### 6.4 Decision: `ABSTENTION_FLOOR` stays `null`

No value clears all five criteria, so the gate is not enabled. This is the outcome the
precedent at `hybrid-search.ts` records for `DIVERSITY_CAP`: a gate whose evidence the
corpus cannot supply stays off, and the grid is committed so the next change starts
from a measurement rather than from a guess.

**Is the surviving overlap cosine-driven?** Partly, and the evidence does NOT support
per-branch thresholds. Of the four rows on the boundary, three have `level = cosine`:

| query                             | gold | level | coverage | cosine | driven by |
| --------------------------------- | ---- | ----- | -------- | ------ | --------- |
| `q-atlas-rate-limit-latest`       | yes  | 0.296 | 0.195    | 0.296  | cosine    |
| `q-nimbus-deploy-pipeline-latest` | yes  | 0.297 | 0.060    | 0.297  | cosine    |
| `q-abstain-atlas-invoice-pdf-slo` | no   | 0.307 | 0.205    | 0.307  | cosine    |
| `q-abstain-global-changelog`      | no   | 0.307 | 0.307    | 0.106  | coverage  |

`design.md` D6 predicted the immovable 0.307 from `q-abstain-atlas-invoice-pdf-slo`
exactly. But splitting the level per branch would not separate the classes either, and
this grid is the first measurement that shows it:

- **coverage only**: gold min 0.060 (`q-nimbus-deploy-pipeline-latest`), abstention max
  0.307 (`q-abstain-global-changelog`) → overlap `[0.060, 0.307]`, width 0.247 —
  **wider** than the combined level's 0.011.
- **cosine only**: gold min 0.000 (`q-cross-scope-test-colocation`), abstention max
  0.307 → overlap `[0.000, 0.307]`, width 0.307 — wider still.

So `max(coverage, cosine)` is, on this fixture, the _best_ of the three quantities, and
per-branch thresholds are not the remedy the previous change hoped for. Handed forward
as measured evidence; not implemented here.

### 6.5 `RELATIVE_LEVEL_RATIO` re-derived, and kept at 0.40

Not carried forward: re-derived from the grid above. Committed floors are @5 precision
0.1875 / recall 0.91875 / MRR 0.7333 and @8 precision 0.10625 / recall 0.95 / MRR
0.7333 (`baselines/hybrid.json`), read at floor `n/a`:

| ratio | R@5   | P@5   | MRR@5 | R@8   | P@8   | MRR@8 | verdict                                |
| ----- | ----- | ----- | ----- | ----- | ----- | ----- | -------------------------------------- |
| n/a   | 0.813 | 0.200 | 0.656 | 1.000 | 0.156 | 0.676 | R@5 and MRR below floor                |
| 0.00  | 0.813 | 0.200 | 0.656 | 1.000 | 0.156 | 0.676 | identical to `n/a` (the control holds) |
| 0.10  | 0.813 | 0.200 | 0.656 | 1.000 | 0.156 | 0.676 | below floor                            |
| 0.20  | 0.813 | 0.200 | 0.656 | 1.000 | 0.156 | 0.677 | below floor                            |
| 0.30  | 0.969 | 0.238 | 0.750 | 1.000 | 0.156 | 0.750 | **admissible**                         |
| 0.40  | 0.969 | 0.238 | 0.797 | 1.000 | 0.156 | 0.797 | **admissible**                         |
| 0.50  | 0.938 | 0.225 | 0.875 | 0.969 | 0.148 | 0.875 | **admissible**                         |
| 0.60  | 0.969 | 0.238 | 0.938 | 0.969 | 0.148 | 0.938 | **admissible**                         |
| 0.70  | 0.906 | 0.213 | 0.938 | 0.906 | 0.133 | 0.938 | R@5 0.906 < 0.91875, R@8 0.906 < 0.95  |
| 0.80  | 0.844 | 0.200 | 0.906 | 0.844 | 0.125 | 0.906 | rejected                               |
| 0.90  | 0.750 | 0.175 | 0.844 | 0.750 | 0.109 | 0.844 | rejected                               |

Admissible band **[0.30, 0.60]**, width **0.30 ≥ 0.10** in level units.
`overAbstentionRate` is 0.000 at every point (the ratio never abstains) and
`abstentionFalsePositiveRate` is 1.000 throughout, at its committed cap.

**0.40 is interior**: 0.30 and 0.50 are both admissible measured points, one grid step
(0.10) either side, and 0.60 is admissible two steps above. The value is unchanged, but
it is unchanged _because the new grid supports it_, not because it was inherited.

The `0.00` control agrees with `n/a` on every metric at every floor, which is what it
is there to prove: levelling the whole pool changes nothing by itself.

### 6.6 `memory.context` under the enabled ratio

`memory.context`'s relevance channel calls `MemoryService.search` and inherits the
module constants with no separate wiring, so an enabled gate reaches it. Asserted
against the SHIPPED constants (not overrides) in
`src/mcp/context-relevance-under-gates.test.ts`: the channel still returns the
best-matching row on a matching focus, and returns an empty list — not an error — on a
focus that matches nothing. The ratio can shorten the channel but cannot empty it: a
ratio ≤ 1 always keeps the leader.

## 7. Baselines, with both sides recorded

### 7.1 Corpus re-confirmed frozen

`git diff --stat main -- apps/server/src/test/retrieval/corpus.ts apps/server/src/test/retrieval/queries.ts`
is still empty on the final tree.

### 7.2 `eval-before.json` vs `eval-after.json`, hybrid, per `k`

Instrument: the evaluation harness's own end-to-end per-query timing, one run each.

| metric                      | k   | before  | after       | delta               |
| --------------------------- | --- | ------- | ----------- | ------------------- |
| precisionAtK                | 5   | 0.23750 | 0.23750     | 0                   |
| recallAtK                   | 5   | 0.96875 | 0.96875     | 0                   |
| mrr                         | 5   | 0.78333 | **0.79688** | **+0.01354**        |
| abstentionFalsePositiveRate | 5   | 1.00000 | 1.00000     | 0                   |
| overAbstentionRate          | 5   | 0.00000 | 0.00000     | 0                   |
| avgTokensReturned           | 5   | 273.750 | **248.208** | **−25.54 (−9.3%)**  |
| precisionAtK                | 8   | 0.15625 | 0.15625     | 0                   |
| recallAtK                   | 8   | 1.00000 | 1.00000     | 0                   |
| mrr                         | 8   | 0.78333 | **0.79688** | **+0.01354**        |
| abstentionFalsePositiveRate | 8   | 1.00000 | 1.00000     | 0                   |
| overAbstentionRate          | 8   | 0.00000 | 0.00000     | 0                   |
| avgTokensReturned           | 8   | 412.167 | **317.750** | **−94.42 (−22.9%)** |
| p50LatencyMs                | —   | 8.000   | 8.439       | +0.44               |
| p95LatencyMs                | —   | 9.918   | 10.405      | +0.49               |

The other two retrievers (`grep`, `memory-md-dump`) are byte-identical, as expected:
neither reads the level.

**The latency rows still are not the added cost of the term-statistics read.** This
harness times 24 queries once each, embedding included, so its p50 cannot resolve a
sub-millisecond difference. Measured control on this same harness under option A: with
the two term-statistics reads stubbed out and everything else identical, p50 came out
**HIGHER** than with them (11.604 vs 10.447 ms). What the p50 does track is how much
work the lexical branch does: option A's widened MATCH read 10.4 ms, the split reads
8.4 ms against `main`'s 8.0 ms. The instrument that can resolve the read itself is
`cost.md` §5.2 (400 interleaved samples per size): **0.39–0.65 ms added at 50 000 rows**.

### 7.3 Which metrics could move, and which could not

- **`P@8` is pinned at its ceiling** (`ceilings["8"].precisionAtK = 0.15625`, measured
  0.15625) and **`R@8` at 1.000**. Neither can register an improvement, and neither did.
- **`abstentionFalsePositiveRate` is the only metric with real headroom**, and it can
  only move if a floor is enabled. §6.4 did not enable one, so it reads 1.000 on both
  sides — as `design.md` D8 predicted.
- `MRR` moved +0.0135 and `avgTokensReturned` fell 9–23%. The MRR gain is small and comes
  from the relative filter cutting weakly-covered rows that previously sat above a gold
  row; the token drop is the same mechanism.

**This change is therefore NOT a ranking win and the PR body must not describe it as
one.** What it is: the level function is corrected, and the measurement that shows it is
the separability collapse in §6.2 (overlap 0.122 → 0.011), not the scorecard.

### 7.4 Baselines NOT regenerated — deliberate

`npx tsx src/test/retrieval/run-eval.ts` passes green against the committed floors and
caps, so no regeneration is required. The up-only ratchet would raise the `MRR` floor
from 0.73333 to 0.74688 (measured 0.79688 minus the 0.05 tolerance) and leave the other
five bounds where they are.

It is not run, because it is not this change's to spend. The only metric with a real
gain is MRR (+0.0135), the ratchet is one command (`--write-baselines`), and minting a
tighter bound on a 40-row fixture whose pool-size reservation is explicitly unresolved
(`design.md` D9) buys nothing the eval does not already enforce. Recorded as a decision
rather than an omission.

Committed floors held on this run: `@5` precision 0.1875 / recall 0.91875 / MRR 0.7333;
`@8` precision 0.10625 / recall 0.95 / MRR 0.7333. No measured value fell below one.

### 7.5 The caps are not vacuously green

`ABSTENTION_FLOOR` temporarily set to 0.35, a value §6.3 shows is inadmissible, then
reverted. The harness failed and named both values:

```
rembric retrieval eval FAILED:
  - hybrid recall@8 (0.750) does not beat grep (0.938) — the corpus does not discriminate, or fusion is not earning its complexity
  - hybrid@5 precisionAtK regressed: 0.175 < committed floor 0.188
  - hybrid@5 recallAtK regressed: 0.719 < committed floor 0.919
  - hybrid@5 mrr regressed: 0.578 < committed floor 0.733
  - hybrid@5 overAbstentionRate regressed: 0.250 > committed cap 0.063
  - hybrid@8 recallAtK regressed: 0.750 < committed floor 0.950
  - hybrid@8 mrr regressed: 0.578 < committed floor 0.733
  - hybrid@8 overAbstentionRate regressed: 0.250 > committed cap 0.063
```

`abstentionFalsePositiveRate` is absent from that list, which is the point of §9.8: its
cap of 1.000 cannot bind while no floor is enabled, and it still cannot.

## 8. Final result composition

`ids-before.json` → `ids-after.json`: **58 of 72 entries moved** (0 reorder-only),
**469 → 358 ids total**, both non-empty. Per-entry diff in `ids-after-diff.txt`.
`sha256(ids-after.json) = c67a34db1d2097dd83c80524da20c258e38cde970b37816801aaf6aa572d8aac`.

Result composition IS expected to change: the relative filter is live at 0.40 and reads
a level that now means something different. The id count fell 24% because weakly-covered
rows that used to clear `0.40 × leaderLevel` on function-word coverage no longer do —
the same mechanism behind the `avgTokensReturned` drop in §7.2. The fused pool itself is
unchanged (the per-query pool sizes in `sweep-after.txt` match the pre-split run
byte-for-byte), so this is the gate deciding differently, not the retriever finding
different rows.

## 10. The amendment: the `df` lookup key comes from SQLite

New artifacts, all runnable:

| File                                | Produced by                                                                    | Task          |
| ----------------------------------- | ------------------------------------------------------------------------------ | ------------- |
| `tokenizer-divergence.mjs` / `.txt` | `pnpm --filter @rembric/server exec tsx <abs path>`                            | 10.1.1        |
| `mcp-script-arms.mjs`               | idem — boots an in-process server, drives the real MCP tool over HTTP JSON-RPC | 10.1.2        |
| `mcp-script-arms-before.txt`        | that probe on the pre-amendment tree                                           | 10.1.2        |
| `eval-before-amendment.json`        | `pnpm run eval` on the pre-amendment tree                                      | 10.1.3        |
| `eval-after-amendment.json`         | `pnpm run eval` on the amended tree                                            | 10.6.2        |
| `sweep-after-amendment.txt`         | `pnpm run eval --sweep-abstention` on the amended tree                         | 10.6.3        |
| `ids-after-amendment.json`          | `npx tsx src/test/retrieval/dump-ids.ts <out>`                                 | 10.6.4        |
| `cost-amendment.mjs` / `.txt`       | idem — three instruments, tabulated apart (`cost.md` §5.2b–§5.2d)              | 10.5.1–10.5.3 |
| `row-side-price.mjs` / `.txt`       | idem — the price of an index-authoritative row side (`cost.md` §5.2e)          | 10.5.4        |
| `docker-smoke.md`                   | the real-stack run against pre-existing seeded data                            | 10.7          |
| `scoped-df-price.mjs` / `.txt`      | idem — the price of a scope-filtered `df` (`cost.md` §5.2f)                    | 11.7          |

### 10.1 The before

`tokenizer-divergence.txt`: the three controls (Spanish, German, Cyrillic without
`й`/`ё`) measure **0%** and the divergent arms reproduce `design.md` D3b's table —
Cyrillic-`й`/`ё` 4/4 (100%), Greek 4/5 (80%), Vietnamese 4/8 (50%), Devanagari 5/6
(83%), Arabic 1/6 (17%), Japanese 1/1 (100%), stacked-diacritic Latin 4/4 (100%). This
measures `indexTerms`, which the amendment deliberately does NOT change, so the numbers
are the same on both sides.

`mcp-script-arms-before.txt`, through the real MCP tool, 20 rows per arm and the rare
word in exactly one of them: the three agreeing arms return **1 of 20** and the seven
divergent arms return **20 of 20**, with the app's term for each divergent arm's
commonest word absent from the index and taking w(absent) = 3.7377 where the held term
takes 0.0241. That is the owner's headline, re-taken as a committed runnable artifact
rather than cited as reported.

### 10.4.6 Mutation log — every guard, each condition weakened separately

| #   | guard                             | mutation                                                                                                          | outcome                                                                                                                                                                                                                         |
| --- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1a  | `sqlite_master` derivation        | `['body', "content=''", ...inherited]` → `['body', "content=''"]` (restate the DDL, drop what the index declared) | **CAUGHT by 2** — `carries a tokenizer option the index declares`, `drops the content options and replaces the index columns with one body column`                                                                              |
| 1b  | derivation                        | delete `if (!CARRIED_OPTIONS.includes(name)) throw new UnrecognisedFts5OptionError(name);`                        | **CAUGHT by 2** — `fails naming an option the derivation does not recognise…`, `fails at startup, not on the first query`                                                                                                       |
| 1c  | derivation / durability           | `QUERY_TERMS_SCHEMA = 'temp'` → `'main'`                                                                          | **CAUGHT by 6**, including `is absent from the durable schema, the migration ledger and the drift inventory` and `does not grow the durable database or its WAL across many tokenisations`                                      |
| 2   | explicit absence                  | `LEFT JOIN memory_fts_vocab` → `JOIN memory_fts_vocab`                                                            | **CAUGHT by 3** — `reports a term the index has never seen as absent, distinguishably from a held one`, `reports every term of an empty corpus as absent rather than failing`, `leaks no term between two consecutive queries…` |
| 3   | durability across cleaning cycles | delete the `VALUES('delete-all')` statement                                                                       | **CAUGHT by 1** — `leaks no term between two consecutive queries with disjoint vocabularies`                                                                                                                                    |
| 4a  | asymmetry bound (a)               | `new Set(documentFrequencies.keys())` → `tokenSet(opts.query)` (point the lookup back at `indexTerms`)            | **CAUGHT by 1** — `is what the search path itself weights by, not a function beside it`; it reds by the refusal in `termWeightsFor`, which names the fabricated term                                                            |
| 4b  | asymmetry bound (b)               | `level: Math.max(coverage, cosine)` → `level: coverage`                                                           | **CAUGHT by 1** — `lowers coverage, leaves the level at the cosine, and never takes the absent-term weight`                                                                                                                     |
| 5   | D3a's pin survives the retirement | `tokenSet` → `tokenizeWords(text).map(lowercase)`                                                                 | **CAUGHT by 1** — `is the vocabulary `tokenSet` decides row membership with, not merely a function beside it`                                                                                                                   |

No mutation left the suite green.

### 10.4.5 The retirement, with its replacement named

`tokenizer-agreement.test.ts` is **retired as an agreement guard, not deleted.** Its
query-side assertions are gone — the query side is no longer produced there — and the
`indexTerms`-versus-index assertions stay, retitled to what they measure: the ROW side
agrees on the committed corpus, which is the corpus every retrieval number here is drawn
from. Its restated `CREATE VIRTUAL TABLE t USING fts5(body)` is gone too: the probe's
tokenizer now comes from `inheritedFts5Arguments(<the migrated declaration>)`, so a
`tokenize=` added by a later migration reaches the test instead of bypassing it. The
general property moved to three named guards — `db/query-tokenizer.test.ts` (derivation,
loud failure), `db/repositories/term-statistics-repository.test.ts` (absence reported,
not inferred) and `services/lexical-asymmetry.test.ts` (a row-side disagreement may only
under-count) — each mutation-pinned above.

### 10.6.2 `pnpm run eval`, before and after the amendment

Prediction stated in advance: on an en/es corpus the divergence is 0%, so **every
quality metric must be unmoved, and unmoved is a pass**.

Measured: across all three retrievers and both `k`, `precisionAtK`, `recallAtK`, `mrr`,
`abstentionFalsePositiveRate`, `overAbstentionRate`, `avgTokensReturned`,
`ceilingPrecisionAtK`, `ceilingRecallAtK`, `n` and `nAbstention` are **bit-identical**.
Only latency moved (hybrid p50 10.1485 → 10.0305 ms, p95 13.6160 → 12.4651 ms), which is
run-to-run noise on a 40-row fixture and is not a claim.

`sha256(eval-before-amendment.json) = 73dc83bc926c6fa811893436517d3c3703be7677878746eedc302e9b1e0e0977`
`sha256(eval-after-amendment.json)  = 27a7b417df4ff0a83e0c8e0a172acff59973935bd5a86cefc5bb06756a5fb96c`
(the digests differ only by `generatedAt` and the latency fields).

### 10.6.3 The sweep's conclusions survive

Two consecutive `--sweep-abstention` runs on the amended tree are byte-identical
(`diff` empty, latency included). Against `sweep-after.txt` the only differences are the
df report's own lines: the legend, and an absent term printing `—` instead of `0`. The
levels, the leader table, the grid and the verdicts are byte-identical, so §6 stands:

```
lowest gold-bearing = 0.296, highest abstention = 0.307 -> NOT separable:
the classes overlap on [0.296, 0.307]
```

`ABSTENTION_FLOOR` stays `null`; `RELATIVE_LEVEL_RATIO` stays 0.40 with the same
admissible band. No docstring correction was needed.

### 10.6.4 Result composition is unchanged

`ids-after.json` → `ids-after-amendment.json`: **72 entries, 358 ids on both sides**,
both non-empty, **0 entries moved**, same `sha256 = c67a34db1d2097dd…`. Expected: the
fixture is en/es, where the two tokenisations agree, so the key change cannot move a
single id.

### 10.6.1 Test count

Measured with `pnpm test` (which excludes `install.test.ts` and
`scripts/*.history.test.ts`): **2232 → 2255 total** (2222 → 2245 passed, 10 skipped
either side). The +23 are exactly the new guards: 10 in `db/query-tokenizer.test.ts`,
5 in `db/repositories/term-statistics-repository.test.ts`, 8 in
`services/lexical-asymmetry.test.ts`; `tokenizer-agreement.test.ts` keeps 5.

§8.1's recorded "2270 passed / 10 skipped (2280)" does **not** reproduce under any
invocation on this tree: `pnpm test` gives 2232 pre-amendment and `pnpm vitest run`
(no excludes) 2298. The recorded figure is invocation- or tree-dependent and was not
chased; the before/after above is a single consistent instrument.

## 11. Amendment 2 — the term-statistics reads are `data-access`-compliant

### 11.4 The closed inventory — 13 entries measured, not 7

The seven carried into the session were `memory-repository.ts::{countRowsByStatus,
countPurgeableDisconnectedArchived, findPurgeableDisconnectedArchivedIds, countByProject}`,
`prompts-repository.ts::{countDeleted, findDeletedIds}` and `vectors-repository.ts::count`.
The detector finds six more, each unscoped, un-keyed and unprefixed on a table with a
`(scope, project_id)` content dimension:

| entry                                                 | consumer                                                                    | MCP-reachable |
| ----------------------------------------------------- | --------------------------------------------------------------------------- | ------------- |
| `agent-sessions-repository.ts::list`                  | `services/agent-sessions.ts:517`, whose own `list()` has no non-test caller | no            |
| `agent-sessions-repository.ts::countPurgeableEmpty`   | `dashboard/maintenance.ts:232` + service wrapper                            | no            |
| `agent-sessions-repository.ts::findPurgeableEmptyIds` | `services/agent-sessions.ts:648` (operator purge)                           | no            |
| `entities-repository.ts::findMissingScans`            | `services/entity-backfill-worker.ts:50`                                     | no            |
| `relations-repository.ts::countRowsByStatus`          | `server/bootstrap.ts:592` via `RelationsService.countByStatus`              | no            |
| `vectors-repository.ts::findMissingEmbeddings`        | `services/embedding-worker.ts:94`                                           | no            |

`memory-repository.ts::countByProject` is the only entry that IS MCP-reachable
(`mcp/project-tools.ts:202` → `project.list`'s `memoryCount`), and it is marked in the
inventory as a known pre-existing violation. It is present at `HEAD`.

Two stale claims found while tracing consumers, neither fixed here: the docstring at
`services/relations.ts:511` says `countByStatus` is "used by `memory.stats` and the
dashboard", but `memory.stats` (`mcp/observability-tools.ts:279`) calls the SCOPED
`agentSessions.countByStatus(scope)` and nothing else calls the relations one except
`bootstrap.ts`; and `data-access/spec.md:43` said "two `admin*` call sites" while the
gate carried three file exemptions, `services/agent-sessions.ts` never having been
named in the spec. The delta names all four.

**Detector boundary, so the inventory's meaning is not overstated.** It covers the seven
repositories owning scope-bearing content tables and classifies the other five
(`projects`, `tokens`, `oauth`, `dashboard-sessions`, `consolidation`) as control-plane;
the classification is itself asserted closed, so a new repository file fails until
classified. Nine unscoped un-keyed reads live in the control-plane five
(`projects::{count,listOrdered,listArchived,listAllIds,listActiveSlugs,findBySlug}`,
`tokens::{count,listAll,findByName}`) and are deliberately out of scope: those tables
carry no per-project content to leak across.

### 11.7 Scoped `df` — the price that keeps the read unscoped

Full table at `cost.md` §5.2f; probe `scoped-df-price.mjs`, output `scoped-df-price.txt`.
Isolated statement time, 50 000 rows, six scopes, p50 of 40: **A index-global (shipped)
1.197–3.758 ms**, **B scope-filtered 29.625–115.557 ms** per search. Control: scoped
`df` ≤ global `df` on **228 of 228** `(scope, term)` pairs.

On the OTHER instrument, quoted separately and never in the same table: the whole
search is 15.2–15.9 ms end-to-end at 50 000 rows / limit 8 (§5.2). The figure carried
into the session was 37–121 ms on another machine and had no script in this repo; this
re-take supplies one and reaches the same conclusion.

`memory_fts_vocab` has columns `(term, doc, cnt)` — no scope column — so there is no
filtered vocabulary read to measure instead of B.

### 11.8 Mutation log — both gates, each condition weakened separately

| #   | gate                         | mutation                                                                                | outcome                                                                                                                                                                   |
| --- | ---------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `(file, method)` confinement | delete the whole `'services/hybrid-search.ts'` entry                                    | **CAUGHT by 1** — `every admin* call site is allow-listed by file AND method name`, naming `hybrid-search.ts:177 adminDocumentCount` and `:181 adminQueryTermFrequencies` |
| 2a  | per-method granularity       | `['adminDocumentCount', 'adminQueryTermFrequencies']` → `['adminQueryTermFrequencies']` | **CAUGHT by 1** — same test; a file-level licence would not have caught this                                                                                              |
| 2b  | per-method granularity       | `['adminDocumentCount', 'adminQueryTermFrequencies']` → `['adminDocumentCount']`        | **CAUGHT by 1** — same test                                                                                                                                               |
| 3   | inventory, absence side      | add `countEveryRow(): number` to `memory-repository.ts`                                 | **CAUGHT by 1** — `the unscoped, un-keyed, unprefixed reads are exactly the inventory`                                                                                    |
| 4   | inventory, absence side      | add `countSince(sinceMs: number)` to `prompts-repository.ts` (a non-scope filter param) | **CAUGHT by 1** — same test; the rule is not "zero arguments"                                                                                                             |
| 5   | inventory, presence side     | delete `'vectors-repository.ts::count'` from the inventory                              | **CAUGHT by 1** — same test, failing the other way                                                                                                                        |
| 6   | inventory, presence side     | delete the `countByProject` entry (the known-violation marker)                          | **CAUGHT by 1** — same test                                                                                                                                               |
| 7   | classification closure       | delete `'tokens-repository.ts'` from the control-plane list                             | **CAUGHT by 1** — `every repository file is classified as scoped-content or control-plane`                                                                                |
| 8   | detector: scope recogniser   | `/\b(scope\|projectId\|partitionKey)\b/` → `/\b(scope\|projectId)\b/`                   | **CAUGHT by 1** — the inventory test; `vectors::knnByQueryVector` becomes a false detection                                                                               |
| 9   | detector: modifier filter    | `if (modifier \|\| name === 'constructor')` → `if (name === 'constructor')`             | **CAUGHT by 1** — the inventory test; private helpers become false detections                                                                                             |

No mutation left the suite green.

### 11.9 Verification

| check                                | result                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `pnpm run typecheck`                 | clean                                                                                                              |
| `pnpm run lint`                      | clean                                                                                                              |
| `pnpm vitest run` (in `apps/server`) | 2311 → **2314 passed / 10 skipped (2324)**, +3 = the three new assertions                                          |
| `pnpm run eval`                      | green; reproduces `eval-after-amendment.json` on every non-latency metric                                          |
| `pnpm run check:delta-freshness`     | `ok (1 active change, 4 body differences to review)` — 2 → 4, the two data-access requirements this delta rewrites |
| `pnpm run check:spec-provenance`     | `ok (main...HEAD)`                                                                                                 |
| `openspec validate --all --strict`   | 25 passed, 0 failed                                                                                                |

The rename is observationally inert on the evidence that would show otherwise: hybrid
`P@8` 0.15625, `R@8` 1.000, `MRR@8` 0.796875 and `avgTokensReturned` 317.75 are
bit-identical to the committed artifact, across all three retrievers at both `k`. Only
hybrid `p50LatencyMs` moved, 10.030 → 10.440 ms, which the harness's own determinism
check excludes.

**No Docker smoke was run** (task 11.10): the session was instructed not to bring the
stack up, and the amendment adds no migration, no HTTP surface, no MCP schema change
and no runtime behaviour. §10.7's smoke against pre-existing seeded data still covers
the shipped behaviour.
