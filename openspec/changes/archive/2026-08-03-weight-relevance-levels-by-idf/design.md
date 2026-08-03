## Context

`rescore-relevance-abstention` fixed the scoring _space_ — the old quantity had a total dynamic range under `1e-5` — and left the scoring _function_ alone. Its committed grid then showed the function is the remaining defect. From `archive/2026-07-28-rescore-relevance-abstention/measurements/sweep.txt`:

```
gold-bearing, ascending : 0.333 0.351 0.381 0.385 0.400 0.429 0.429 0.500 0.556 0.571 0.600 0.667 0.667 0.667 0.750 0.833
abstention,  descending : 0.455 0.375 0.307 0.300 0.300 0.300 0.250 0.200
lowest gold-bearing = 0.333, highest abstention = 0.455 -> NOT separable
```

Its task 8.7 (`tasks.md:102`) states the brief for this change: "the follow-up is **a better level function, not a better threshold**, and IDF weighting is the specific candidate (a stopword list is the cruder alternative; prefer the one that needs no curated list). Re-run `--sweep-abstention` against the same 24 queries and 40-row corpus and cite the grid in `measurements/sweep.txt` here as the before."

Three constraints bound this design that did not bind that one.

1. **The gate path is no longer free.** `RELATIVE_LEVEL_RATIO` was enabled at 0.40 by operator decision (`tasks.md:103`), so `hybrid-search.ts:132` evaluates `gatesEnabled` true on every production search: the pool text read and the level computation are unconditionally hot. The archived change could hide all of its cost behind two `null`s; this one cannot.
2. **That enablement also invalidates the ratio's calibration.** 0.40 was chosen plateau-interior over unweighted levels. Change the quantity and the grid that justified the constant no longer describes the constant.
3. **`ABSTENTION_FLOOR` stays exactly where the sweep puts it.** `hybrid-search.ts:39-56` records the current state: enabling it "requires a committed `pnpm run eval --sweep-abstention` grid meeting the bar in memory/spec.md", and its "two level distributions overlap and no value separates them". Whether that is still true after this change is an outcome, not a premise.

## Goals / Non-Goals

**Goals:**

- Make the lexical component measure the share of the query's _information_ a row carries, so a question-shaped query with no answer in the corpus cannot score 0.455 on function words.
- Source the term statistics from one place with defined behaviour on a cold index, a five-memory instance, and a fifty-thousand-memory one.
- Keep exactly one definition of "what a token is", and make it the index's definition.
- Produce a grid directly comparable with the committed one: same 40 rows, same 24 queries, same harness, same `k` values.
- Leave the shipped configuration decided by that grid — including the outcome where nothing changes but the level function.

**Non-Goals:**

- Changing `test/retrieval/{corpus,queries}.ts`. See D9.
- `all_projects`, scope widening, or making `global` a project.
- Re-enabling `DIVERSITY_CAP` (`hybrid-search.ts:59-67`; needs a session-labelled fixture).
- Per-branch floors — still deferred, still on evidence (`archive/2026-07-28-rescore-relevance-abstention/tasks.md:99`), though D6 records new evidence bearing on them.
- Minimum-should-match on the lexical branch (`tasks.md:100`).
- Any MCP schema, tool description, or plugin change.

## Decisions

**D1 — The lexical component becomes IDF-weighted coverage, using the BM25 non-negative smoothed form.**

`weightedCoverage = Σ w(t) over query terms present in the row / Σ w(t) over all distinct query terms`, with `w(t) = ln(1 + (N − df(t) + 0.5) / (df(t) + 0.5))`.

Bounded `[0,1]` by construction (it is a weighted fraction of a positive-weight set), and it degenerates to today's plain coverage exactly when every query term has the same `df` — so the tiny-index and empty-index cases fall back to the shipped behaviour rather than off a cliff.

Alternatives considered:

- _Classic `ln(N/df)`_ — rejected: it is zero at `df = N`, so a query composed only of ubiquitous terms has a zero denominator and no defined coverage. The smoothed form's weight at `df = N` is `ln(1 + 0.5/(N+0.5))`, which is `0.087` at `N = 5` and `1.0e-5` at `N = 50 000`: never zero, and correctly negligible exactly where the corpus says the term is worthless.
- _Probabilistic IDF `ln((N − df + 0.5)/(df + 0.5))`_ — rejected: it goes negative above `df > N/2`, and a weighted fraction with negative weights can leave `[0,1]`. `openspec/specs/memory/spec.md:354` requires the level be in `[0,1]`; a formula that can violate it under a common condition is not a candidate.
- _A curated stopword list_ — rejected, for the reason already recorded at `archive/2026-07-28-rescore-relevance-abstention/design.md:115`: the corpus is deliberately bilingual, so the list is per-language and becomes a second invisible retrieval knob. IDF derives the same effect from the corpus and needs no list. It also handles the case a list cannot: a term that is a stopword _in this corpus_ (`memory`, `project`, `rembric`) without being one in the language.
- _Raising the floor to out-run the function words_ — rejected by the brief this change implements; the overlap is in the quantity, not in the threshold.

Note on prior art: the archived design **named** IDF and stopwords at `design.md:114-115` and defaulted against both, but it costed neither — there is no grid, no cost measurement and no separability estimate for either in that change. This design is the first to price them.

**D2 — Document frequency is index-global, read from `fts5vocab('memory_fts', 'row')`. `N` is `count(*)` over `memory`.**

Measured, not assumed (better-sqlite3 12.11.1 / SQLite 3.53.2): `CREATE VIRTUAL TABLE … USING fts5vocab('memory_fts','row')` succeeds against this repo's external-content FTS5 schema and returns `(term, doc, cnt)` where `doc` is the document frequency. `N` must be the same population the index counts — every row in `memory`, all scopes and all statuses — and `SELECT count(*) FROM memory` measured 0.018 ms at 50 000 rows.

Alternatives considered:

- _Pool-local document frequency_ (count `df` inside the fused pool's text, which `poolLevels` already reads, so it costs nothing) — **rejected, and it is the obvious first suggestion, so the reason matters.** The pool is not a sample of the corpus; it is the set of rows the lexical branch matched plus the dense branch's nearest neighbours. A rare, discriminative term is present in a large fraction of the pool _because it drove the match_, so its pool `df` is high and its pool IDF weight is low — the estimate is anti-correlated with the quantity it is meant to measure, precisely for the terms the change exists to up-weight. Structurally it is also the family of error `openspec/specs/memory/spec.md:358` already forbids: deriving the gate's input from the gate's own window can express shape, never level.
- _A maintained `term_df` table_ — rejected: new derived data, a backfill on populated installations, and an invalidation obligation, all to duplicate statistics FTS5 already maintains for free.
- _Per-term `SELECT count(*) … WHERE memory_fts MATCH ?` probes_ — rejected on the same grounds `archive/2026-07-28-rescore-relevance-abstention/design.md:65` rejected them: one FTS scan per term against a posting list is strictly worse than reading the term index directly.
- _Scope-filtered `df`_ — rejected on two counts. There is no scoped read of an FTS term index (it would degrade to the probes above), and a three-memory project has no usable statistics. The accepted consequence is stated as a trade-off below and pinned by a spec clause: term statistics are aggregates, they carry no id and no content, and they SHALL NOT become a channel that returns an out-of-scope row.

Behaviour at the edges, all derived from the formula in D1:

| Instance                     | Effect                                                                                                                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Empty index (`N = 0`)        | Every term has `df = 0` and weight `ln 2`; all weights equal, so weighted coverage **is** plain coverage. The fused pool is empty anyway.                                                                |
| 5 memories                   | Weight spread is `2.398` (`df = 0`) down to `0.087` (`df = 5`), a 27× range — still discriminating, no clamping regime and no minimum-`N` fallback.                                                      |
| 50 000 memories              | Spread `11.5` down to `1.0e-5`. A term in every document contributes essentially nothing to numerator or denominator, which is the intended behaviour.                                                   |
| A term absent from the index | `df = 0` gives it the maximum weight, so failing to match the query's rarest term is the strongest possible evidence of irrelevance. This is the mechanism that separates the classes, if anything does. |

**D3 — One tokenisation, and it is the index's.**

Measured on SQLite 3.53.2 for `Migración de cron programada; validación — Atlas's pipeline? v1.2 rate-limit UTF_8 CamelCase`:

- FTS5 (`unicode61`, default diacritic folding): `2 | 8 | atlas | camelcase | cron | de | limit | migracion | pipeline | programada | rate | s | utf | v1 | validacion`
- shipped `tokenizeWords` (`hybrid-search.ts:534`, whitespace split): `migración | de | cron | programada; | validación | atlas's | pipeline? | v1.2 | rate-limit | utf_8 | camelcase`

3 of 11 shipped tokens are FTS5 terms. Looking up `df` for the other 8 returns 0 — the maximum weight — so the level function would treat `pipeline?` as the rarest term in the corpus while `pipeline` is common. That failure is silent: no error, no empty result, just a wrong number.

So `tokenizeWords` is re-implemented to agree with `unicode61`: split on anything that is not a Unicode letter or digit, fold diacritics, lowercase.

Alternatives considered:

- _Normalise only at lookup time, leaving `tokenizeWords` alone_ — rejected because the mapping does not exist. `rate-limit` is one shipped token and two FTS5 terms; `v1.2` is one and two. There is no per-token weight to look up, so the "patch" would have to invent a combination rule, i.e. a third tokenisation.
- _Ask SQLite to tokenise_ — rejected: FTS5's tokeniser has no SQL surface. `fts5vocab` exposes only terms already indexed, so it cannot normalise a query token that no document contains — exactly the `df = 0` case that carries the most weight.
- _Restrict the weighting to tokens that happen to be FTS5 terms_ — rejected: it silently drops the discriminative ones and would make the level a function of which tokens survived an undocumented filter.

The agreement is not asserted. A test runs the **entire** committed corpus text and all 24 query strings through both the JS tokeniser and a real `fts5vocab` read of the same text, and asserts set equality — the corpus's own vocabulary, not a hand-picked sample. Diacritic folding beyond `unicode61`'s table is the known residual and is what that test exists to catch.

**D3a — `tokenizeWords` was one function doing two jobs. It is split, and only the token-set job is index-aligned. (Decided during apply, on measurement.)**

D3 as written above says "`tokenizeWords` is re-implemented", which is what apply did first — and it broke two things D3 did not anticipate, because that one function had two callers doing two different jobs:

1. **Sanitising an FTS5 MATCH expression** (`sanitizeFtsQuery`). Quoting one whole whitespace-delimited word makes FTS5 parse its parts as a PHRASE: `"rate-limit"` is `rate` ADJACENT to `limit`. Splitting the word first turns that into `"rate" OR "limit"`, which is a different query.
2. **Comparing token sets** (`relevanceComponents`' coverage, `findSaveTimeCandidates`' containment, and now the `df` lookup). This job needs the index's vocabulary, and it is what D3's argument is actually about.

Measured consequences of aligning job 1 as well:

- `openspec/specs/memory-entities/spec.md:84-92` publishes a per-kind lexical-noise table whose measurement runs "the REAL lexical path (`sanitizeFtsQuery` into the production BM25 read over a live FTS5 index)" (`:80`). **7 of 13 published figures moved** (`cve_id` 0→50, `ip_address` 50→67, `mac_address` 0→50, `systemd_unit` 50→67, `ticket` 50→67, `url` 0→50, `uuid` 0→50, `error_code (GRPC_STATUS_NAMES)` 50→75).
- Save-time candidate surfacing widened on identifier-dense content: pending `memory_relations` in the `mcp-integration` shared server went **17 → 89**.

So the split ships: `tokenizeWords` keeps the whitespace rule and serves `sanitizeFtsQuery` only; a new `indexTerms` implements the `unicode61` rule; `tokenSet` — the ONE token vocabulary both token-set comparisons use — is built on `indexTerms`. D3's argument is unchanged and fully satisfied: the terms the weighting looks up are exactly the terms the index stores. What changes is that a query-sanitising helper is no longer conscripted into being a tokenisation of text for comparison.

This is the structural fix rather than a patch: two jobs, two functions, each with the tokenisation its job requires. The alternative — keeping one function and accepting the fallout — was priced and rejected:

- _Option A: align both jobs, absorb the consequences_ — would need a `memory-entities` delta re-justifying all seven moved figures, and would raise the agent-facing judgment load by whatever the 17 → 89 fixture ratio implies in production (unmeasurable here: the repo has no production-shaped corpus committed, and the 40-row eval corpus showed no change at all — 228 detected / 145 surfaced on both sides). Paying an unbounded judgment-load cost and a published-contract rewrite, to get a MATCH widening this change never wanted, is the wrong trade.

Which tokenisation `findSaveTimeCandidates`' containment uses was decided on measurement rather than by inheritance, because it is a token-set job and could legitimately go either way:

| containment reads            | pending `memory_relations`, `mcp-integration` shared server | `mcp-integration` suite |
| ---------------------------- | ----------------------------------------------------------- | ----------------------- |
| `tokenSet` (index-aligned)   | **17**                                                      | 49 passed               |
| whitespace words, lowercased | **17**                                                      | 49 passed               |

Identical, so the choice is free and is made on the contract instead: memory/spec.md requires ONE tokenisation shared by the search path and the save-time candidate path, and the search path's token-set job is index-aligned. Containment therefore reads `tokenSet`. The measurement also settles the attribution: the 17 → 89 blowup was **entirely** the loosened MATCH, and none of it containment.

Both directions of the split are pinned by mutation, so the next author cannot collapse them back: pointing `sanitizeFtsQuery` at `indexTerms` reds the noise-rate measurement, and pointing `tokenSet` at `tokenizeWords` reds the index-agreement test.

**D3b — D3's central requirement was false as implemented. The lookup key comes from SQLite instead, and the requirement is rewritten asymmetrically. (Amended after apply, on measurement.)**

The delta published this, in the ADDED requirement "Query tokenisation MUST agree with the index's tokenizer":

> The application's tokenisation SHALL therefore produce exactly the terms the full-text index stores for the same text: the same splitting rule, the same case folding and the same diacritic folding.

`indexTerms` does not do that, and `tokenizer-agreement.test.ts` is green only because its universe is `CORPUS` + `QUERIES`, which are en/es. Re-measured here against a real FTS5 index (`unicode61`, SQLite 3.53.2), one document per sample, `fts5vocab(…,'instance')` for the index's terms:

| sample                                                         | app terms | absent from index | examples the index does not hold              |
| -------------------------------------------------------------- | --------- | ----------------- | --------------------------------------------- |
| Spanish (`Migración de cron programada; validación ejecución`) | 6         | **0 (0%)**        | — the control                                 |
| German (`Grüße Straße Bäckerei Fuß`)                           | 4         | **0 (0%)**        | —                                             |
| Cyrillic without `й`/`ё`                                       | 3         | **0 (0%)**        | —                                             |
| Cyrillic with `й`/`ё` (`Майский район войти ёлка`)             | 4         | **4 (100%)**      | `маискии` `раион` `воити` `елка`              |
| Greek (`Η αναζήτηση ολοκληρώθηκε επιτυχώς ΤΕΛΟΣ τέλος`)        | 5         | **4 (80%)**       | `αναζητηση` `ολοκληρωθηκε` `επιτυχως` `τελος` |
| Vietnamese (`Kiểm tra bộ nhớ đệm đã hoàn thành`)               | 8         | **4 (50%)**       | `kiem` `bo` `nho` `đem`                       |
| Devanagari (`डेटाबेस कैश की जाँच पूरी हुई`)                    | 6         | **5 (83%)**       | `डटबस` `कश` `जच` `पर`                         |
| Arabic (`تم التحقق من ذاكرة التخزين المؤقت`)                   | 6         | **1 (17%)**       | `الموقت`                                      |
| Japanese (`バンド設定のデバッグを完了しました`)                | 1         | **1 (100%)**      | the whole string, dakuten-stripped            |
| stacked-diacritic Latin (`Ǻrsrapport Ẫnh nguyễn phở`)          | 4         | **4 (100%)**      | `arsrapport` `anh` `nguyen` `pho`             |

Every one of those is a term that gets `?? 0` — the **maximum** weight — so it dominates both numerator and denominator of a coverage whose real content is elsewhere. The corpus's commonest word scores as its rarest. Spanish at 0% is why the committed eval never saw it, and why the change's own agreement test is green.

_Why aligning the JS rule is not the fix._ There are at least three independent disagreements, and a fourth that rules out treating this as a folding-option problem:

1. The app puts `\p{M}` in the word-character class; `unicode61` treats a combining mark as a separator.
2. The app NFD-decomposes and strips marks; the index keeps precomposed characters and folds them through its own table — which does not cover the katakana dakuten (`バンド` → app `ハント`) or the Cyrillic breve (`й` stays `й`).
3. JS `toLowerCase()` is context-sensitive; `unicode61` folds per codepoint (`ΤΕΛΟΣ` → `τελοσ`, `τέλος` → `τέλοσ`).
4. Measured here: at the shipped `remove_diacritics=1`, `unicode61` does **not** fold Greek accents (`στάσις` → `στάσισ`) while it does lowercase and map final sigma. The folding table is neither "everything" nor "nothing", so no folding option on either side recovers agreement — reproducing it means embedding the C table, the duplication `CLAUDE.md` forbids.

Rejected, each on measurement rather than argument:

- _`remove_diacritics=2` on the index_ — fixes Vietnamese and stacked-diacritic Latin only; Devanagari, Japanese and Greek still diverge under both `rd1` and `rd2`.
- _Aligning the JS rule_ — over 12 scripts the shipped rule agrees on 6 and a candidate treating combining marks as separators also agrees on 6, trading Spanish and German for Devanagari. Spanish and German are the committed corpus, which D9 freezes; trading away the language the evidence is measured in, for a language it contains none of, is a worse position, not a different one.
- _Weighting an absent term the MINIMUM (`?? documentCount`)_ — implemented and wrong. It turns "the corpus does not hold what you asked" into "what you asked does not matter", which disarms abstention — the one thing abstention exists for. `hybrid-search.test.ts::'reaches the same abstention verdict at every offset'` caught it. From the `df` map alone the two causes of absence are indistinguishable, so no weight value is correct while the key can be fabricated; the fix has to be to the key, not to the value.

**The decision: ask SQLite for the query's terms.** Insert the query text into an FTS5 table declared with `memory_fts`'s tokenizer, then read the query's terms **and** their document frequencies in ONE statement, `LEFT JOIN`ing the tokenising table's `fts5vocab` against `memory_fts_vocab`. This **replaces** the existing `term IN (…)` read; it does not add one.

Cost, statement-level, one warm process, 50 000 rows, 400 iterations. **This is a statement-level instrument and is never to be tabulated with the end-to-end p50 in `measurements/cost.md` §5.2.** Two independent measurements on differently-shaped synthetic corpora:

|                                          | A) today: JS tokenisation + `term IN (…)` | B) insert + one `LEFT JOIN` | marginal      | budget |
| ---------------------------------------- | ----------------------------------------- | --------------------------- | ------------- | ------ |
| owner, 90 008-term vocabulary            | 3.3926 ms/query                           | 3.4961 ms/query             | **0.1034 ms** | 1.0 ms |
| re-measured here, 70 018-term vocabulary | 5.5194 ms/query                           | 6.0111 ms/query             | **0.4917 ms** | 1.0 ms |

The two marginals differ by ~5× — different query shapes and vocabularies — and both clear the budget with margin, which is the only thing the decision rests on. `EXPLAIN QUERY PLAN` for B: `SCAN q VIRTUAL TABLE INDEX 1:` then `SCAN v VIRTUAL TABLE INDEX 259: LEFT-JOIN` — index 259 is the same term-constrained seek the shipped read already gets, so the join is a seek per query term.

**A second benefit, and the reason this fixes the requirement rather than weakening it.** B returned 18.8 terms per query where A returned 16.8 (owner: 19 versus 13). With `LEFT JOIN` every query term comes back and the ones the index lacks come back `NULL`. "The index does not hold this term" stops being an inference from a missing map key and becomes explicit data. And because the key is now the index's own term, an absent term genuinely means the corpus lacks it — so `?? 0`, the maximum weight, is **correct again**, and abstention is preserved rather than disarmed. That is what the rejected minimum-weight patch could not achieve.

**What this does NOT fix, and why the requirement is rewritten asymmetrically rather than repaired.** `weightedCoverage` compares the query's terms against `tokenSet(row.title + row.content)` — the row side is still `indexTerms`. Fixing only the query side moves the disagreement rather than removing it. Measured directly: of four query terms taken from a Cyrillic/Greek row, **three were found in the row when the row was tokenised by SQLite and NOT found when it was tokenised by `indexTerms`**.

So the row side was priced. Pool sizes are the shipped 64–400; budget 1.0 ms marginal:

| row-membership source                                    | pool 64      | pool 200     | pool 400     |
| -------------------------------------------------------- | ------------ | ------------ | ------------ |
| insert pool into the temp index + per-term `MATCH` on it | 7.807 ms     | 18.359 ms    | 26.890 ms    |
| insert pool into the temp index + filtered instance read | 7.968 ms     | 19.835 ms    | 28.949 ms    |
| same, cached by memory id across queries (warm)          | 4.771 ms     | 6.102 ms     | 8.521 ms     |
| one `MATCH` per term against `memory_fts` ∩ pool rowids  | 6.587 ms     | 20.703 ms    | 42.696 ms    |
| **JS `indexTerms` over the pool — today**                | **0.865 ms** | **2.362 ms** | **4.802 ms** |

All four options above fall in one of two families — tokenising the pool at query time (the three insert arms) and reading the index's term-major structures (the `MATCH`-against-`memory_fts` arm and the instance reads) — and within those two families the cost is 8× to 29× the budget and irreducible: tokenising through SQLite means inserting the pool's text into an FTS5 index, and the pool is 64–400 documents of ~900 characters. Caching by memory id (legal — `content` is immutable under the append-only invariant) does not rescue it. The cached-by-id row's own figures did **not** reproduce on the real schema — `measurements/cost.md` §5.2e re-took them at 0.273 / 0.520 / 0.941 ms, under budget — and are left standing as taken; what survives the re-take is the mechanism, and it is sharper than the price. `fts5vocab` is term-major, so the term constraint is pushed down and `doc` membership is filtered afterwards, which makes the read's cost proportional to the corpus rather than to the pool by construction: at a corpus-sized cache a pool of 64 costs 12.707 ms, 46× its 0.276 ms at a pool-sized cache.

**What is NOT 8–29×, measured: a doc-major structure.** A `(doc, term) PRIMARY KEY WITHOUT ROWID` table, populated in one statement from `fts5vocab('memory_fts','instance')` — so the terms are the index's own and nothing is re-tokenised in JS — measures **0.161 / 0.483 / 0.951 ms** at pool 64 / 200 / 400, under the 1.0 ms budget. Its corpus-independence was measured rather than argued: the same pool-400 read costs 0.836 ms against a table holding only the 400 pool docs and 0.931 ms against all 39 998 — flat. Correctness control: 0 of 21 200 (row, term) decisions differed from `indexTerms` on the committed en/es corpus. So "through the index" is not what costs 8–29×; query-time pool tokenisation and term-major reads are, and all four options priced above are in those two families. This does not re-open the shipped decision — it is task 10.8.1's brief — but the 8–29× figure is no longer to be stated of index-authoritative row membership in general.

The row side therefore stays `indexTerms`, and the requirement states the asymmetry instead of claiming agreement. The asymmetry is not symmetric in consequence, which is what makes it acceptable:

- A query-side fabrication assigned the **maximum** weight to an arbitrary term, raising it above every real term in the query. That is unbounded and it is the defect.
- A row-side disagreement can only cause a term the row does contain to be counted as **not covered**. It lowers that row's lexical component, never raises it, never touches a weight, and never touches the cosine — so `level = max(coverage, cosine)` leaves the row reachable on its dense score. The lexical arm goes quiet on a script it cannot tokenise, rather than going loud and wrong.

That difference is why the amendment is a correction and not a retreat: today a divergent query gets uniform maximum weights, which collapses weighted coverage back to the plain unweighted coverage this whole change exists to replace — measured end-to-end through the MCP boundary as the Latin arm returning 1 of 20 rows while the Cyrillic, Greek, Vietnamese and Arabic arms return 20 of 20 — the owner's measurement, cited as reported and re-taken as a committed runnable artifact at task 10.1.2 rather than repeated on trust. After the fix those arms fall through to the dense branch instead of being carried by function words.

**D3c — The tokenising table's declaration is derived from the shipped one, so drift is unrepresentable.**

Hand-writing the temp table's DDL would create two declarations that can be separately edited into disagreement — the same class of defect D3b is fixing. A reviewer already flagged the related weakness in the test: `tokenizer-agreement.test.ts:29` builds its probe from a restated `CREATE VIRTUAL TABLE t USING fts5(body)`, so a `tokenize=` added to `memory_fts` by a later migration would not fail it. One mechanism addresses both.

Measured (SQLite 3.53.2): `sqlite_master.sql` preserves the declaration verbatim, including `tokenize="unicode61 remove_diacritics 2"`, and splitting its argument list on unquoted commas, dropping `content=` / `content_rowid=` and carrying the rest into `CREATE VIRTUAL TABLE temp.… USING fts5(body, <carried>)` propagates the tokenizer — verified by `phở` → `pho` under the carried `rd2` where the default gives `phở`. An argument the derivation does not recognise **fails startup naming it**; that is what makes the mechanism a guarantee rather than a parse-and-hope, because the failure mode being designed out is a tokenizer option silently not carried over.

The five questions this mechanism has to answer, each measured:

| question                                            | answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | evidence |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `temp.` or a real table?                            | `temp.`, and this is not a preference. Writes to it do not touch the durable database: the main `-wal` was **0 bytes** larger after 2 000 further tokenise cycles. A real table would put per-query writes into the WAL of an append-only store, and would need a migration, a shrinkage-guard exemption and a rollback story. Single-process single-connection means `temp.` is exactly process-scoped.                                                                                                       | probe    |
| the first query after boot?                         | Nothing to warm. Creating both virtual tables costs **0.137 ms**, once per process, at startup — not on the first query. It must run **after** migrations, since the declaration is derived from what the migrations left behind.                                                                                                                                                                                                                                                                              | probe    |
| cleaning between queries?                           | Required, and free. `content=''` makes the table contentless — the `…_content` shadow table does not exist, so no query text is stored at all — and `INSERT INTO t(t) VALUES('delete-all')` purges it. After 5 040 cycles the vocabulary held exactly the last query's 18 terms and per-query latency had not degraded (6.19 ms → 5.13 ms, within noise). No `VACUUM`, no rebuild. `contentless_delete=1` additionally permits a targeted `DELETE WHERE rowid=0` if a future variant needs to keep other rows. | probe    |
| a later migration drops and recreates `memory_fts`? | Nothing to do. The tokenising table is independent of `memory_fts` and the derivation re-runs on the next boot, so a migration that changes the tokenizer is picked up automatically. Only the `memory_fts_vocab` side is exposed to the drop window, which is already measured and pinned (see Risks).                                                                                                                                                                                                        | probe    |
| empty corpus?                                       | Every query term comes back marked absent, no error and no division by zero — all weights equal, so weighted coverage is plain coverage, exactly as D1 requires.                                                                                                                                                                                                                                                                                                                                               | probe    |

**D3d — `tokenizer-agreement.test.ts` stops being the guard, and what replaces it.**

Its first two assertions become **partly tautological and partly misnamed**, and the amendment says so plainly rather than leaving a green test standing for a property it no longer measures:

- Tautological for the query side: the terms are now SQLite's, so "the terms we look up are terms the index has" holds by construction. It does not need a test; it needs the derivation guard below.
- Misnamed for the row side: `indexTerms` is still asserted to equal the index's term list, and that assertion is **false in general** and green only because `CORPUS` + `QUERIES` are en/es. A test whose pass depends on the fixture's languages, asserting a universal, is the shape of defect that produced this amendment. D9 freezes the corpus, so the test cannot be strengthened by widening its universe within this change.

Replacements, all of which are checkable and none of which restate a tautology:

1. **The derivation guard.** Assert the tokenising table's declaration was derived from `sqlite_master`'s `memory_fts` row, and that an unrecognised argument fails startup. Mutation-pinned: restating the DDL as a literal, or dropping the unrecognised-argument check, must red it. This is the guard that would have caught the flagged `fts5(body)` restatement.
2. **The absence guard.** Assert the read reports an absent term explicitly rather than by omission, so `?? 0` is applied on reported evidence. Mutation-pinned: turning the `LEFT JOIN` into an inner join must red it.
3. **The asymmetry guard.** Over Cyrillic, Greek, Vietnamese and Japanese text, assert (a) every query term resolves to the document frequency the index records — the property that was false — and (b) a row-side disagreement lowers coverage and nothing else: no maximum weight, no raised level, cosine untouched. This is the requirement's actual content, stated so it can fail.
4. **The residual, kept and re-aimed.** `indexTerms` versus the index over the committed corpus stays, retitled to what it measures — that the row side agrees on the corpus the eval's evidence is drawn from — so a regression on Spanish or German still reds it. It is no longer offered as evidence of agreement in general.

**D4 — Save-time candidate similarity stays unweighted, deliberately.**

`openspec/specs/memory/spec.md:1135`: "the reported `similarity` SHALL be computed as a corpus-independent lexical overlap measure between the saved text and the candidate." IDF is corpus-dependent by construction, so weighting `findSaveTimeCandidates` would contradict a published requirement and change a number the MCP contract documents as `0..1, max(vec, fts) normalized` (`openspec/specs/mcp-api/spec.md:160`).

`tokenContainment` therefore stays as it is and stays shared; the weighted function is new and lives beside it. What the two paths share is the tokeniser — so they cannot drift on what a token is, which was the point of `archive/2026-07-28-rescore-relevance-abstention/design.md:39`. Save-time similarity values _do_ move, because the tokeniser moved; that is measured (tasks §6), and range, monotonicity and corpus-independence are all preserved.

**D5 — Cost is a stated budget on a named end-to-end instrument, and the fallback is written down before the measurement.**

Two instruments, kept apart:

- _Statement timing_, synthetic index of 50 000 documents / 50 022 distinct terms, one warm process: `WHERE term = ?` averaged 0.097 ms for a repeated term and 0.27 ms across 19 mixed terms (5.2 ms for a 19-token query); `WHERE term IN (19 values)` 4.8 ms; a full vocab scan 8.8 ms; `count(*)` 0.018 ms. **The `IN` figure is not trustworthy and must be re-taken before it is cited.** It cannot coexist with this same change's end-to-end addition of 0.39–0.65 ms p50 measured over the same read, and an independent re-measurement of the same statement shape at the same corpus size returned 0.096 ms — roughly 50× lower, consistent with a cold-cache first execution having been recorded as the average. The decision it fed (no memo) is unaffected, and is better supported by the lower figure. `EXPLAIN QUERY PLAN` reports `SCAN memory_fts_vocab VIRTUAL TABLE INDEX 259:` for both shapes — the vtable takes the term constraint, so this is a seek per term rather than a scan per term, but it is not free.
- _End-to-end_: the committed hybrid eval run measures p50 11.659 ms and p95 16.569 ms per query (`archive/2026-07-28-rescore-relevance-abstention/measurements/eval-after.json`, 40-row corpus, embedding included).

These are different series and are never to be tabulated together. The budget is on the second: **added end-to-end p50 ≤ 1.0 ms at 50 000 rows**, measured at 1k/20k/50k, the same shape `archive/2026-07-28-rescore-relevance-abstention/measurements/cost.md` used.

The statement probe says a naive per-term read will miss that budget on long queries, so the design pre-authorises one mitigation rather than leaving the implementer to improvise: a bounded in-process memo of `term → df`, invalidated wholesale whenever the document count changes. The count check costs 0.018 ms, content is immutable, and there is no tolerance parameter — a tolerance would be a second uncalibrated knob. Known staleness window: a tag edit changes a tag term's `df` without changing the document count, so that term's weight can lag until the next insert; the effect is one term's weight in one search and it is recorded, not defended.

If neither the plain read nor the memo clears the budget, **the level function ships unweighted and cost is recorded as the reason** — distinct from a failed calibration, following the precedent at `archive/2026-07-28-rescore-relevance-abstention/tasks.md:54`.

**D6 — What the sweep can and cannot achieve, stated before it is run.**

The level is `max(coverage, cosine)` and this change moves only `coverage`. From the committed leader table, the abstention queries' leaders carry cosines up to **0.307** (`q-abstain-atlas-invoice-pdf-slo`, whose level 0.307 _is_ its cosine), while the lowest gold-bearing leader is **0.333** with a cosine of 0.199 (`q-nimbus-deploy-pipeline-latest`). So even a perfect lexical component that scored every abstention query 0 leaves an immovable abstention level of 0.307, and separability requires the deploy-pipeline query's weighted coverage to clear it with margin.

Two consequences. First, this change may find no admissible floor, and that is a legitimate outcome — `hybrid-search.ts:59-67` is the standing precedent for a gate whose evidence the corpus cannot supply. Second, if the sweep shows the surviving overlap is cosine-driven, that is new, measured evidence for per-branch thresholds (`archive/2026-07-28-rescore-relevance-abstention/tasks.md:99` asked for exactly this) — recorded as the next change's brief, not implemented here.

**D7 — The ratio is re-swept, and its committed floors are the ratchet.**

`RELATIVE_LEVEL_RATIO = 0.4` is re-derived from the new grid under the same five criteria. It may keep its value; it may not. Either way the run must hold the ratcheted floors in `test/retrieval/baselines/hybrid.json` — `@5` precision 0.1875, recall 0.91875, mrr 0.7333; `@8` precision 0.10625, recall 0.95, mrr 0.7333 — and the ratchet is up-only, so a value that lowers them fails CI rather than rewriting them.

**D8 — Which metric is expected to move: honestly, at most one.**

`ceilings["8"].precisionAtK` is 0.15625 and the measured `P@8` is 0.15625 — **precision at 8 is pinned at its ceiling and cannot improve**. `recallAtK` at `k = 8` is 1.000, also its ceiling. `MRR@8` reads 0.783 against a floor of 0.7333, so it has headroom but is not the target. The one metric with real headroom is **`abstentionFalsePositiveRate`, currently 1.000**, and it can only move if a floor becomes enablable (D6). At `k = 5` precision (0.200 against a ceiling of 0.25) and recall (0.969 against 1.000) have headroom and may move either way.

So the claim this change is allowed to make is: _the level function is corrected, and the abstention false-positive rate is the only metric that can register the correction._ A ranking win is not promised, and a run that returns byte-identical P/R/MRR with a corrected level function and an unchanged floor is a pass, not a disappointment. Anything else stated in the PR body would be a claim the harness cannot support.

**D9 — Ordering constraint: the corpus is frozen for the duration of this change.**

`test/retrieval/{corpus,queries}.ts` stay byte-identical, because the entire evidentiary value here is a before/after against `archive/2026-07-28-rescore-relevance-abstention/measurements/sweep.txt` on the same 40 rows and 24 queries — which is what task 8.7 asked for. The reservation recorded at `archive/2026-07-28-rescore-relevance-abstention/tasks.md:104` still stands and is still unaddressed: "the fixture's pools are 10–26 rows against a production scope's much larger ones, so the filter's behaviour at scale is extrapolated rather than measured." Growing the corpus toward production-sized pools (and adding cross-project fixtures) is a separate, later change. It must land _after_ this one, or the comparison it depends on stops being a comparison.

**D10 — Three published claims that the code already contradicts are corrected here.**

`openspec/specs/memory/spec.md:1249` — "Three gates ship disabled (`null`): the abstention floor and `RELATIVE_LEVEL_RATIO` … and the per-session `DIVERSITY_CAP`" — and `:369` — "Both gates SHALL be disabled by default. While both are disabled the branch SHALL perform no gate-related work at all" — are both false against `hybrid-search.ts:57` (`RELATIVE_LEVEL_RATIO: number | null = 0.4`). The scenario at `:407-410` requires the disabled path to "issue no additional database read on their behalf", which no production caller can now observe. These live inside the two requirements this change already modifies, and leaving a published contract asserting a gate is off while it is on is the exact failure mode `reconcile-specs-with-shipped-behaviour` existed to clear. They are corrected in the delta rather than deferred; the guarantee is re-expressed as conditional on the gate's own state, so it does not need editing the next time a constant moves.

## Risks / Trade-offs

- [Risk] The `fts5vocab` read is on the unconditional hot path, unlike every gate cost the archived change measured behind two `null`s → Mitigation: D5's stated budget on a named end-to-end instrument, measured at 1k/20k/50k, with a pre-authorised memo and a written fallback that abandons the weighting on cost grounds rather than shipping an unmeasured hot-path read.
- [Risk] ~~The JS tokeniser and `unicode61` disagree on some script the sample did not cover, and the disagreement is silent (a `df = 0` maximum weight) → Mitigation: D3's equality test over the whole committed corpus and query set, not a sample.~~ **This risk MATERIALISED and the mitigation did not hold** — the corpus is en/es, so the equality test is green while the disagreement runs from 17% of terms (Arabic) to 100% (Japanese, Cyrillic with `й`/`ё`). Superseded by D3b: the lookup key comes from SQLite, so the fabrication is removed by construction rather than watched for by a test whose universe cannot contain the failure.
- [Risk] The row-membership half of the lexical component still disagrees with the index, and D9 freezes the corpus so no committed fixture can see it → Mitigation: bounded rather than removed, and the bound is contracted (D3b): the disagreement can only under-count a row's coverage, never fabricate a weight or raise a level, and `level = max(coverage, cosine)` leaves the row reachable on its dense score. Priced at 8–29× the cost budget in the two families D3b tabulated — query-time pool tokenisation and term-major reads — with one doc-major structure measured under the budget (D3b), so removing it is a later change with its own budget, not a silent omission here. The asymmetry guard (D3d) fails if the bound is ever exceeded.
- [Risk] Changing the level changes what the live 0.40 filter returns on every production search → Mitigation: this is the change's point, so it is measured rather than avoided — before/after id digests over pre-existing seeded Docker data, the committed floors held by the up-only ratchet, and D7's re-sweep. The digest comparison asserts a non-empty result count on both sides; two empty sets hash identically and prove nothing.
- [Trade-off] Term statistics are index-global, so a term's weight in project A depends on project B's vocabulary → Accepted because the alternative is unusable (D2) and the exposure is an aggregate count, not a row: no id and no content crosses a scope, and a spec clause forbids the statistic from becoming a row-returning channel. Recorded rather than buried, because "scope enforced at the service layer" is a load-bearing invariant and this is the first read in the search path that is deliberately not scoped.
- [Trade-off] The level stops being independent of corpus size — `openspec/specs/memory/spec.md:354` currently says it is "independent of corpus size by construction" → Accepted, and it is the whole point: `archive/2026-07-28-rescore-relevance-abstention/design.md:114` predicted this cost ("IDF re-introduces corpus dependence and is a step backwards unless the data demands it") and the committed grid is the demand. The delta rewrites that clause rather than letting code and spec disagree, and the stability that actually matters — a floor meaning the same thing at 40 rows and 50 000 — is restated as what it now is: stable in the _ranking_ the weights induce, not in the absolute value of a term's weight.
- [Risk] A floor calibrated on a 40-row corpus overfits → Mitigation: the plateau-width criterion (D-open-question below), the hard `overAbstentionRate = 0` bar at both `k`, and D9's explicit statement that the pool-size reservation is _not_ resolved by this change.
- [Risk] `checkAbstentionFlags` asserts `abstained ⇔ empty` while the spec allows a ratio-emptied page to report `abstained: false` (`archive/2026-07-28-rescore-relevance-abstention/tasks.md:117`) → Mitigation: still sound here, because the harness runs `offset = 0` only and a `ratio ≤ 1` always keeps the leader. Unchanged by this change and re-recorded so it is not lost; it becomes live when the harness gains an `offset > 0` query, which belongs to the corpus change in D9.
- [Risk] A future migration that drops and recreates `memory_fts` leaves the vocab table pointing at a table that does not exist → Mitigation: measured — `DROP TABLE memory_fts` with the vocab table present succeeds, a query against the vocab table between the drop and the recreate fails with `no such fts5 table: main.memory_fts`, and after the recreate it works again with no DDL touch. Migrations run before the server serves, so the window is not reachable by a search; pinned by a spec scenario and a migration test rather than left to be rediscovered.

## Migration Plan

One migration, DDL only: `CREATE VIRTUAL TABLE memory_fts_vocab USING fts5vocab('memory_fts','row')`. No table rebuild, so none of the FK dance in `CLAUDE.md` applies; `PRAGMA foreign_key_check` returns no rows against a virtual table (measured), so the runner's pre-commit gate is unaffected.

**D3b's tokenising table adds no migration and no durable schema object.** It lives in the connection's temporary schema, is created at startup _after_ the migrations have applied (its declaration is derived from what they left behind — D3c), and is contentless, so it writes no text anywhere and does not grow the durable database or its WAL (measured: 0 bytes over 2 000 tokenise cycles). It is therefore absent from the migration ledger, the schema-drift inventory and the shrinkage guard's table counts, and no upgrade, downgrade or rollback has to account for it: a process that does not create it simply does not have it.

On a populated installation: the vocab table is a read-only view over the existing `memory_fts` index and is fully populated the instant it is created — measured, including after `INSERT INTO memory_fts(memory_fts) VALUES('rebuild')`. There is no backfill, no first-boot work, and no derived-data invalidation: `memory_fts`, `memory_vec` and the three entity tables are untouched, and the vocab table stores nothing of its own, so it needs no recipe version marker (`openspec/specs/persistence/spec.md:963` — "Where the recipe is SQL triggers on the source table, no marker is required"; the same reasoning applies a fortiori to a table with no contents).

First search after upgrade: results change, because the level function changed and the 0.40 filter reads it. That is a behaviour change with no data component.

Rollback: downgrade the image. The vocab table is inert to older code (nothing reads it) and can be left in place or dropped; either way no `memory` row is affected and no derived index needs rebuilding. The only committed artifacts that move are the eval baselines and the new `measurements/` grid.

## Open Questions

- **Should the plateau width be expressed in level units instead of grid steps?** Default: **yes, level units, and the grid step stays 0.05.** `openspec/specs/memory/spec.md:1257` requires "the chosen value in the interior of a plateau at least two grid steps wide", and "grid step" is a free parameter: refining `SWEEP_FLOORS` (`test/retrieval/run-eval.ts:321`) from 0.05 to 0.005 manufactures a compliant plateau without changing anything real, which the archived change already saw coming — `tasks.md:44` calls a 0.01 refinement of the same window "measurement theatre, not calibration". Expressing the requirement as an absolute width in level units (≥ 0.10, i.e. twice the committed step) makes it refinement-proof. This is surfaced rather than taken silently because it edits a criterion no evidence in this change bears on; the delta encodes the default, and if a reviewer prefers the existing wording, that one clause drops out and the rest of the delta is unaffected.
- **If the surviving overlap is cosine-driven, does per-branch thresholding become this change's business?** Default: **no.** D6 says why the evidence may appear here; splitting `max(coverage, cosine)` into two interacting thresholds is a two-dimensional sweep over interacting axes, which `archive/2026-07-28-rescore-relevance-abstention/design.md:35` rejected as uncalibratable in one change. Record the evidence, open the change.
- **Should the memo in D5 ship unconditionally, or only if the measurement demands it?** Default: **only if the measurement demands it.** State in memory that is not needed is state that can go stale; the 1k/20k/50k measurement decides, and whichever way it goes the decision is recorded with its number. **Settled by `measurements/cost.md` §5.3: the plain read cleared the budget, so no memo ships.** Whether the amendment's `LEFT JOIN` read changes that is re-measured at task 10.5.2 under the same budget.
- **Is a permanently asymmetric lexical component acceptable, or does the row side have to be made index-authoritative eventually?** This is a genuine judgement call and it is left open rather than defaulted, because it is the one question the measurements here cannot answer. What they establish is that the asymmetry is _bounded_ (D3b: under-count only, no fabricated weight, cosine untouched) and that removing it through query-time pool tokenisation or a term-major read costs 8–29× the budget, while a doc-major `(doc, term)` table measures under it (D3b), and that is enough to ship. What they cannot establish is whether the residual matters in production, because D9 freezes the corpus at en/es where the divergence measures **0%** — so no committed fixture can see it, and the only evidence available would come from an installation with non-Latin content. Two positions are defensible: treat the asymmetry as permanent and say so in the spec, or open a change to land the doc-major read D3b already prices at 0.951 ms at pool 400. Task 10.8.1 carries the brief either way, and task 10.8.5 carries the precondition any floor calibrated on the en/es corpus has to clear before it is enabled. Deciding it here without non-Latin evidence would be exactly the overclaim this amendment exists to correct.
- **Should the eval corpus gain a non-Latin arm as part of this amendment?** Default: **no**, and this one is defaulted rather than left open because D9 already answers it. The whole evidentiary value of §6's grid is a before/after on 40 unchanged rows and 24 unchanged queries; adding a script arm now destroys the comparison the amendment is being judged against. It belongs to §9.1's corpus change, which must land after this one. The cost of the default is stated rather than hidden: until then the row-side residual has no harness coverage, and the asymmetry guard (task 10.4.3) — which asserts the bound directly on synthetic non-Latin text — is what stands in for it.
