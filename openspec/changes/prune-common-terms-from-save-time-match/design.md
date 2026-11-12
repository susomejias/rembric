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
- Making the save-time cost fully independent of other projects' rows. The residual growth is measured and recorded under Open Questions.

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

On the probes measured, multi-term tokens whose terms were all common were 0 or 1 out of 480 tokens per corpus, so keeping phrases costs nothing measurable (`measurements/README.md`).

Alternatives considered:

- **Call the existing `adminQueryTermFrequencies` once per token.** Rejected. It cannot tell `the-the` from `the`, because its result is keyed by distinct term. It also measured slower: 0.89 ms against 0.46 ms at 1 000 rows, and 8.05 ms against 7.46 ms at 50 000, on the generator corpus.
- **Read the whole text once and map tokens to terms in the application.** Forbidden by the keyed-lookup requirement.

### D3 — Fallback: when no kept token can match another row, keep every token

The pass triggers the fallback when no kept token occurs in any row other than the saved one. For a single-term token, that means its document frequency is at most 1. For a phrase, it means at least one of its terms has a document frequency of at most 1. If no token is kept at all, the condition also holds.

The trigger is term-level, as the owner phrased it ("when every term is common"). It also covers the case where the only tokens left are ones that exist solely in the saved text. Such a token "survives" pruning, but it can match nothing except the excluded saved row. On a small corpus that is the usual case: at 3 rows, every token shared with another row is common.

**How many tokens to keep, by measurement.** The test is the recall of a byte-identical duplicate of an all-common save, on 60 probes per corpus. `measurements/README.md` has the full table.

| corpus    | rows   | unpruned | keep 1 | keep 2 | keep 4 | keep 8 | keep all |
| --------- | ------ | -------- | ------ | ------ | ------ | ------ | -------- |
| generator | 20 000 | 59/60    | 7      | 10     | 38     | 54     | 59       |
| realistic | 20 000 | 32/56    | 10     | 25     | 31     | 32     | 32       |

Every restored token is common, so it is in at least `N/2` rows, and the fallback query is linear in `N` whatever the count. A smaller count only buys a constant factor: 5.0 ms for keep 1 against 39.7 ms for keep all, generator at 20 000 rows. In exchange it loses identical duplicates. The fallback therefore keeps every token, and for these saves the expression is exactly today's.

On the realistic control the fallback fired for 0 of 120 natural probes. It fires only for saves whose terms are all ubiquitous, and on the generator corpus for long memories whose first 16 tokens are all drawn from its 150-word vocabulary.

Alternatives considered:

- **Keep the rarest K < 16 tokens.** Rejected by the table above.
- **A result-based trigger: run the pruned query, and rerun unpruned when it returns no row.** It is exact about "empty" but costs a second query. On the generator it fired more often than the term-level trigger (112 against 98 of 180 probes at 20 000 rows) with no recall gain. Rejected.

### D4 — Where the specification text goes

Change `add-save-time-lexical-floor` is active and MODIFIES "Save-time lexical candidate scoring MUST increase with match quality" and "Retrieval and lifecycle constants MUST be named and bounded in one place". `openspec archive` replaces a MODIFIED requirement wholesale, so a second change modifying either one would revert the first change's text, depending on archive order.

This change therefore:

- **ADDS** "The save-time lexical `MATCH` MUST omit terms present in at least half of the index". The requirement names its own constant and restates the constants rule for it: declared once, not configurable, not per request.
- **MODIFIES** "`memory.save` MUST surface candidate conflicts at save-time". No other active change modifies it, and it must change: its builder paragraph says the lexical pass "SHALL NOT … drop tokens that are entirely non-ASCII", and frequency pruning drops any common token, whatever its script. The modified paragraph allows omission by frequency only, never by script, and keeps the non-empty guarantee.
- **Leaves to a follow-up** folding `COMMON_TERM_DOCUMENT_RATIO` into the constants list. That should happen after both changes archive, so it has no archive-order dependency.

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
  - The realistic control lost none of them (0 across 120 natural probes at 1 000 and 20 000 rows).
  - The generator corpus loses many. Its 150-word vocabulary puts almost every pair above the floor, so nearly every row is a "candidate" of every other. The probe's own source memory, which is the near-duplicate, was still found at the unpruned rate.
  - The sweep fixture and the retrieval evaluation are the gates.
- **[Risk] A kept phrase whose terms each occur elsewhere, but never adjacently, blocks the fallback, and the pass finds nothing.** The pass has no cheap way to know a phrase's own document frequency. This risk is accepted and recorded.
- **[Trade-off] The document-frequency read is linear in the frequencies it counts.** `fts5vocab` counts a term's documents by walking its postings: 7.5 ms for 16 mostly-common tokens at 50 000 generator rows. It is still well below the query it replaces. Under Open Questions.
- **[Trade-off] A token in 5–50% of rows is kept and still widens the match set.** On the realistic control the pruned statement still matched about 58% of rows, so the gain there is about 2×, not the generator's 20–30×. Under Open Questions.

## Migration Plan

- No durable schema change and no migration. The added view is temp-schema, created at connection open beside the existing tokenising table.
- Deploy is a normal server release.
- To roll back, revert the commit. Setting `commonTermRatio: null` in code reproduces the old statement exactly.

## Open Questions

- **Should save-time cost be made independent of other projects' rows?** That is the issue's stated expectation. Pruning removes the always-whole-index tokens, but two linear costs remain: the document-frequency read, and the match sets of tokens kept below `N/2`. Removing them needs a change of a different kind, such as a project-restricted lexical index or ranking after the project join. Each of those touches the schema or the query plan, and is for the owner to decide.
- **The same question for interactive `memory.search`.** See `measurements/search-path.txt`.
