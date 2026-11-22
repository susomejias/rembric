## Context

The save-time lexical channel (`findSaveTimeCandidates`, `packages/core/src/services/save-time-candidates.ts`) builds its query in three steps:

1. It builds `sanitizeFtsQuery(saved.content, { maxTerms: 16 })`: the first 16 whitespace tokens, each quoted as an FTS5 string and joined with `OR`.
2. It runs `searchBm25Candidates` with that expression (`packages/db/src/repositories/memory-repository.ts`):

   ```sql
   SELECT … FROM memory_fts JOIN memory m ON m.rowid = memory_fts.rowid
   WHERE memory_fts MATCH ? AND m.id != ? AND <project scope> AND m.status = 'active' AND m.id NOT IN (…)
   ORDER BY rank LIMIT 20
   ```

   The plan is `SCAN memory_fts VIRTUAL TABLE INDEX 32:M3`, which means FTS5 consumes `ORDER BY rank` itself. It computes bm25 for every row in the match set and sorts them. Only after that does the join apply the project, status and exclusion filters.

3. It keeps a pool row only when its unweighted token containment reaches `LEXICAL_CANDIDATE_FLOOR`. That rule comes from change `add-save-time-lexical-floor`.

The match set is the union of every token's document set, taken across all projects. A token present in most memories makes it the whole index. Issue #465 measured the consequences:

- `memory.save` p50 grows from 10.9 ms at 1 000 rows to 106.5 ms at 50 000.
- The statement alone grows from 1.54 ms to 71.31 ms, with 100% of rows matched.

FTS5's bm25 uses `idf = ln((N − n + 0.5) / (n + 0.5))` and replaces any `idf <= 0` with `1e-6`. `idf <= 0` holds exactly when `n >= N/2`. `measurements/idf-clamp.txt` executes this. A row matching only such a term scores `-1e-6` times its term-frequency factor, while the same row scores `-0.3677` when the term is in 4 of 10 rows instead of 5 of 10.

## Goals / Non-Goals

**Goals:**

- The save-time statement no longer ranks every row of every project because of one common token.
- The `MATCH` is never empty when the builder yields a token, and the lexical channel never goes silent for a save whose only shared tokens are common. This is the owner's fallback decision.
- The save-time calibration sweep (`pnpm run eval:save-time`) stays byte-identical, and the retrieval evaluation (`pnpm eval`) is unchanged.
- The cost is measured with named instruments: statement level, the document-frequency lookup itself, and end to end.

**Non-Goals:**

- Interactive `memory.search` keeps its lexical branch unchanged. It is investigated in `measurements/search-path.txt`, and a change there would move every retrieval baseline, so it is a separate change.
- The reported `similarity`, the floor and the pool size are not touched.
- Making the save-time cost fully independent of other projects' rows. D7 measures what that takes: an index restricted to one project, which changes scores. The owner decides on it separately (Open Questions).

## Decisions

### D1 — Drop a token when its document frequency is at least half the document total

`COMMON_TERM_DOCUMENT_RATIO = 0.5`, compared with `>=`. The value is not calibrated. It is the point where FTS5 itself stops weighting the term (Context), so a dropped token is one that already contributes a constant `1e-6` per row. Its only effect was to enlarge the match set.

**The quantities match FTS5's own:**

- **Document total:** `adminDocumentCount()`, which counts every `memory` row in every scope and status. That is the population `memory_fts` indexes and the `N` bm25 uses.
- **Per-term counts:** read from `memory_fts_vocab`, the same counts bm25's `n` is drawn from.
- **The saved row:** it is already indexed when detection runs, so both the total and the counts include it, as they do for FTS5.

Alternatives considered:

- **A curated stop-word list.** Rejected. It needs per-language lists, and memories here are routinely English and Spanish. It also drifts from what the index actually holds. The archived relevance-weighting design already recorded the preference for a mechanism "that needs no curated list".
- **A lower ratio (for example 0.2), to also drop mid-frequency tokens.** Rejected for this change. Below `N/2` FTS5 gives a token a positive weight, so dropping it changes the bm25 ordering for real, and that would have to be calibrated. The ratio would stop being derived and become a tuned constant.
- **Prune at the index-term level, splitting a multi-term token into its terms.** Rejected. It violates the builder requirement ("SHALL NOT split a token"). It also changes what matches: a path or `a-b` phrase becomes a bag of its rarest parts.

### D2 — Tokenise each token through the index's tokenizer, and never drop a phrase

The published requirement "Term-statistics lookups MUST be keyed on the index's own terms" forbids reproducing the tokenizer in the application. A builder token such as `apps/core/src/x-12.ts`, `two-space` or `v1.1` is matched by FTS5 as a phrase of several terms. bm25 weights a phrase by the phrase's own document count, and the vocabulary does not hold that count. It holds only each term's count, which is an upper bound for the phrase.

So the pass needs to know which tokens are a single term. The new read `adminTokenTermFrequencies(tokens)` inserts each token as its own row of the temp-schema tokenising table. It then reads a new temp-schema `fts5vocab(…, 'instance')` view over that table, LEFT JOINed to `memory_fts_vocab`. The result lists every token's terms in order, each with its document frequency or `null` when the index does not hold it. It costs one round of three statements.

- A token with exactly one term instance is dropped when that term is common.
- A token with several instances, such as `the-the` or `1.1`, is never dropped.
- The read is bounded by the 16-token cap, not by the saved body's length. That answers the cost objection `add-save-time-lexical-floor` design D1 raised against a save-time term-statistics read.

On the probes measured, multi-term tokens whose terms were all common numbered 1 of 1 440 tokens on the generator at 1 000 rows and 0 everywhere else (`measurements/statement.txt`). Keeping phrases therefore costs nothing measurable.

Alternatives considered:

- **Call the existing `adminQueryTermFrequencies` once per token.** Rejected. It cannot tell `the-the` from `the`, because its result is keyed by distinct term. It also costs 16 statement rounds instead of one.
- **Read the whole text once and map tokens to terms in the application.** Forbidden by the keyed-lookup requirement.

### D3 — Fallback: when no kept token can match another row, keep every token

The pass triggers the fallback when no kept token occurs in any row other than the saved one. For a single-term token, that means its document frequency is at most 1. For a phrase, it means at least one of its terms has a document frequency of at most 1. If no token is kept at all, the condition also holds.

The trigger is term-level, as the owner phrased it ("when every term is common"). It also covers the case where the only tokens left are ones that exist solely in the saved text. Such a token "survives" pruning, but it can match nothing except the excluded saved row. On a small corpus that is the usual case: at 3 rows, every token shared with another row is common.

**How many tokens to keep, by measurement.** The test is whether the probe's target survives the floor when the fallback fires. For the commonOnly probes the target is a byte-identical duplicate; for the natural probes it is the source memory. `measurements/statement.txt` has every size.

| corpus    | rows   | fallback probes | keep 1 | keep 2 | keep 4 | keep 8 | keep all |
| --------- | ------ | --------------- | ------ | ------ | ------ | ------ | -------- |
| generator | 1 000  | 44              | 11     | 25     | 39     | 40     | 40       |
| generator | 20 000 | 48              | 5      | 8      | 24     | 36     | 41       |
| generator | 50 000 | 47              | 6      | 4      | 12     | 28     | 38       |
| realistic | 1 000  | 29              | 16     | 21     | 23     | 23     | 23       |
| realistic | 20 000 | 28              | 6      | 13     | 19     | 19     | 19       |
| realistic | 50 000 | 29              | 13     | 21     | 26     | 26     | 26       |

"Keep all" is today's expression, so its column is also the unpruned recall.

Every restored token is common, so it is in at least `N/2` rows, and the fallback query is linear in `N` whatever the count. A smaller count only buys a constant factor: 11.8 ms for keep 1 against 92.6 ms for keep all on the generator at 50 000 rows, and 25.2 ms for keep 4 against 30.2 ms on the realistic control. In exchange, every count below 16 lost targets on the generator at every size, including keep 8. The fallback therefore keeps every token, and for these saves the expression is exactly today's.

**Owner decision (2026-11-12):** keep every token in the fallback. The owner confirmed this after reviewing the table above.

On the realistic control the fallback fired for 0 of 60 natural probes at every size. On the generator it fired for 14 to 18 of 60. Those are long memories whose first 16 tokens are all drawn from its 150-word vocabulary, which sits in nearly every row. Every synthetic all-common probe fires it, by construction.

Alternatives considered:

- **Keep the rarest K < 16 tokens.** Rejected by the table above.
- **A result-based trigger: run the pruned query, and rerun unpruned when it returns no row.** It is exact about "empty", but it costs a second query, and it fires for every save whose rarer tokens match nothing in scope. That is the common case for a genuinely new memory. Rejected.

### D7 — Score only the saving project's matches: order by `bm25(memory_fts)`, not by `rank`

The owner asked for a further reduction: save-time cost should stop growing with rows in other projects. The preferred route was a query-plan change, with schema changes considered only if that fell short.

Today's statement orders by FTS5's `rank` column. FTS5 consumes that order (plan `INDEX 32:M3`), so it computes bm25 for every match in every project and sorts them before the join's project filter runs. Ordering by the function `bm25(memory_fts)` instead leaves the order to SQLite (plan `INDEX 0:M3 … USE TEMP B-TREE FOR ORDER BY`). The join then filters first, and bm25 runs only on in-project matches.

bm25's statistics still cover the whole index, so the scores are bit-identical. `measurements/plans.txt` checks the `(id, score)` top-20 against today's for every probe, in all 36 cells: 2 corpora × 3 sizes × 3 project shares × 2 expressions. It was identical in 360 of 360 probes. The save-time sweep is byte-identical to the pruning-only run.

**Shapes measured** (`measurements/plans.txt`; statement p50 at 50 000 rows, saving project at 2% of rows, unpruned → pruned expression):

| shape | what it is                                                          | generator      | realistic      | fidelity to today         |
| ----- | ------------------------------------------------------------------- | -------------- | -------------- | ------------------------- |
| A     | today, `ORDER BY rank`                                              | 88.0 → 4.84 ms | 53.8 → 20.3 ms | —                         |
| **B** | `ORDER BY bm25(memory_fts)` (**shipped**)                           | 35.6 → 2.48 ms | 15.4 → 7.29 ms | identical ids and scores  |
| B2    | B plus `+rowid IN (project rowids)`                                 | 17.4 → 2.66 ms | 10.5 → 3.79 ms | identical                 |
| E1    | a project column in the FTS table, AND-ed into the `MATCH` (schema) | 29.3 → 8.32 ms | 15.0 → 5.40 ms | scores differ; ids differ |
| E2    | an FTS table holding only the project's rows (schema)               | 1.95 → 0.26 ms | 1.23 → 0.54 ms | scores differ; ids differ |
| floor | FTS5 iterating the match set alone                                  | 10.0 → 2.49 ms | 4.67 → 1.76 ms | —                         |

**Why B:**

- It is exact. It is cheaper than A in every cell, about 2× for the shipped pruned expression and 2.5–3.5× for the unpruned one that the fallback uses.
- **B2** helps only when the project is small or the expression is unpruned. It costs more than B when the project is large, because materialising 30 000 rowids is not free (pruned at 60%: 5.85 against 2.93 ms on the generator).
- **E1** is rejected. It is never cheaper than B for pruned expressions on the generator. Every score moves, because the project token adds one token to each row's length, which shifts bm25's length normalisation. On the generator the order changed too: for unpruned expressions at 20 000 and 50 000 rows, only 0 to 5 of 10 probes kept today's ids. On the realistic control the order held and only the scores moved. Its inverse document frequencies are still counted over every project.
- **A memory-driven join** (`memory CROSS JOIN memory_fts … rowid = m.rowid`) is rejected (`measurements/driven-and-rebuild.txt`). FTS5 re-parses the `MATCH` for every outer row and recomputes bm25's idf per row, so the cost multiplies by the project's row count.

**What B does not reach.** With the saving project at 2% of rows, the shipped statement still grows with the index:

- generator: 0.20, 0.91 and 2.48 ms at 1 000, 20 000 and 50 000 rows;
- realistic: 0.68, 3.74 and 7.29 ms.

The causes are the kept tokens' postings, which are walked in every project, and the per-match row lookup. Only E2 is flat: 0.07, 0.09 and 0.26 ms, and 0.18, 0.36 and 0.54 ms. But E2 computes inverse document frequencies over the project, so scores and order change. That would need the save-time sweep and an owner decision on a per-project derived index. This change stops there (Open Questions).

### D4 — Where the specification text goes

Change `add-save-time-lexical-floor` is active and MODIFIES "Save-time lexical candidate scoring MUST increase with match quality" and "Retrieval and lifecycle constants MUST be named and bounded in one place". `openspec archive` replaces a MODIFIED requirement wholesale, so a second change modifying either one would revert the first change's text, depending on archive order.

This change therefore:

- **ADDS** "The save-time lexical `MATCH` MUST omit terms present in at least half of the index". The requirement names its own constant and restates the constants rule for it: declared once, not configurable, not per request.
- **ADDS** "The save-time lexical query MUST score only the saving project's matches" (D7). It requires bit-identical scores and states the costs that stay corpus-wide.
- **MODIFIES** "`memory.save` MUST surface candidate conflicts at save-time". No other active change modifies it, and it must change: its builder paragraph says the lexical pass "SHALL NOT … drop tokens that are entirely non-ASCII", and frequency pruning drops any common token, whatever its script. The modified paragraph allows omission by frequency only, never by script, and keeps the non-empty guarantee.
- **Leaves to a follow-up** folding `COMMON_TERM_DOCUMENT_RATIO` into the constants list. That should happen after both changes archive, so it has no archive-order dependency.

The modified requirement is copied whole from the published spec. It carries one pre-existing citation, "Embeddings MUST be computed in-process by a model loaded at boot". Active change `lazy-embedding-load-identity-check` renames that requirement, and `check-spec-crossrefs` already flags the same citation in the published spec without this change. Whichever change archives last should update the citation.

### D5 — A test seam, not configuration

`CandidateOptions.commonTermRatio?: number | null` sits beside `poolSize` and `lexicalFloor`. It is never read from the environment. `null` turns pruning off together with its reads, which reproduces today's statement exactly. That is the "before" arm of the paired latency measurement and the control in tests.

### D6 — Instruments

Each instrument is named in its output file and never tabulated with another:

1. **Statement:** `searchBm25Candidates` wall clock, unpruned against pruned, on the same probes, at 1 000, 20 000 and 50 000 rows, on two corpora:
   - the `corpus:build` generator;
   - a realistic-vocabulary control: the 73-item retrieval corpus, replicated with a per-copy suffix on every term found in fewer than 4 base items.
2. **Lookup:** the document-frequency read itself (`adminDocumentCount` plus `adminTokenTermFrequencies`), on the same probes.
3. **End to end:** paired `saveMemoryWithCandidates` wall clock, with the design of `add-save-time-lexical-floor` `save-latency.mts`. It uses three arms (off, on, off) and reports the median paired difference with a bootstrap interval.
4. **Behaviour:**
   - the sweep output, diffed against `add-save-time-lexical-floor/measurements/sweep.txt`;
   - `pnpm eval`, with result ids dumped before and after;
   - post-floor lexical candidates, unpruned against pruned, per probe;
   - the fallback firing rate.

## Risks / Trade-offs

- **[Risk] A candidate that shared only common tokens with the save's first 16 tokens is no longer found.**
  - It can clear the floor only when most of the save's distinct tokens are common, or it shares rarer tokens beyond the first 16.
  - The realistic control lost none of them: 0 lost and 0 gained across all 266 probes at 1 000, 20 000 and 50 000 rows.
  - The generator corpus loses many: 711, 746 and 784 of 1 587, 1 733 and 1 755. Its 150-word vocabulary puts almost every pair above the floor. Unpruned, 90 probes surfaced 1 755 lexical candidates from a 20-row pool, so almost every pooled row is a "candidate" of every other. The probe's own target, the near-duplicate, was still found at exactly the unpruned rate in every class and at every size.
  - The sweep fixture and the retrieval evaluation are the gates. At the shipped floor the sweep is unchanged, and the retrieval ids are identical (`measurements/README.md`).
- **[Risk] A kept phrase whose terms each occur elsewhere, but never adjacently, blocks the fallback, and the pass finds nothing.** The pass has no cheap way to know a phrase's own document frequency. This risk is accepted and recorded.
- **[Trade-off] The document-frequency read is linear in the frequencies it counts.** `fts5vocab` counts a term's documents by walking its postings. The lookup p50 is 5.1 ms at 50 000 generator rows and 1.6 ms on the realistic control, still well below the query it replaces. Under Open Questions.
- **[Trade-off] A token in 5–50% of rows is kept and still widens the match set.** On the realistic control, natural probes still matched 56–59% of rows after pruning. The statement gain there is about 2× (30.2 ms to 14.9 ms at 50 000 rows), not the generator's 46× (91.5 ms to 2.0 ms) for probes that keep a rarer token. Under Open Questions.

## Migration Plan

- No durable schema change and no migration. The added view is temp-schema, created at connection open beside the existing tokenising table.
- Deploy is a normal server release.
- To roll back, revert the commit. Setting `commonTermRatio: null` in code reproduces the old statement exactly.

## Open Questions

- **Should the save-time lexical index become per-project (E2 in D7)?** It is the only shape measured whose cost is close to proportional to the saving project. It is a derived-index change, and its scores and order differ from today's because inverse document frequencies would be computed per project. Adopting it needs a migration, an upgrade test on a populated database, a rebuild-time measurement and a fresh save-time sweep. `measurements/driven-and-rebuild.txt` records the rebuild time of today's `memory_fts` at 50 000 rows for scale. Not started; awaiting the owner.
- **The same question for interactive `memory.search`.** See `measurements/search-path.txt`.
