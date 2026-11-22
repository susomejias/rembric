## Why

`memory.save` gets slower as the whole server grows, across every project, not just as the saving project grows (issue #465). The cause is the save-time lexical candidate query (`searchBm25Candidates`). It ORs up to 16 tokens of the saved text into one FTS5 `MATCH`. A single token found in most memories, such as "the", pulls every indexed row into the match set. FTS5 then computes bm25 for each of those rows and sorts them before the query's project, status and `LIMIT` filters apply. Measured on the issue's instrument, the save takes 10.9 ms at 1 000 rows, 47.2 ms at 20 000 and 106.5 ms at 50 000. The query alone takes 1.54 ms, 27.95 ms and 71.31 ms on the generator corpus, and every probe matched 100% of rows.

Such a token adds almost nothing to the ranking. When a term appears in at least half of the indexed rows, FTS5 clamps its inverse document frequency to `1e-6` (measured in this change). So the work it causes buys no information.

## What Changes

- Before building the save-time `MATCH`, the lexical pass drops every token whose document frequency is at least `COMMON_TERM_DOCUMENT_RATIO` (`0.5`) of the document total. That ratio is exactly where FTS5's bm25 clamp starts, so it is derived rather than tuned. It is a named compile-time constant, declared once in `save-time-candidates.ts` and never read from the environment.
- **Frequency source:** the existing term statistics, read from the index: `memory_fts_vocab` for per-term counts and every `memory` row as the total. Each token is tokenised by the index's own tokenizer, one token at a time, so the pass knows which tokens are a single term. A token that FTS5 matches as a multi-term phrase is never dropped, because its document frequency is not in the vocabulary.
- **Fallback (owner decision: the lexical channel must never go silently empty):** if no kept token occurs in any row other than the saved one, the pass keeps every token, exactly as the builder produced them. The measurements show why it keeps all of them. Keeping only the rarest 1, 2, 4 or 8 tokens lost near-duplicate targets on the generator corpus at every size that keeping every token still finds. Whatever the number kept, every restored token is in at least half of the index, so no choice of how many makes the fallback cheap.
- **Score only the saving project's matches.** The save-time statement orders by `bm25(memory_fts)` instead of FTS5's `rank` column. FTS5 then stops scoring and sorting every match in every project: the join filters first, and bm25 runs on in-project matches only. Scores and order are bit-identical to today's (360 of 360 probes, `measurements/plans.txt`).
  - Two schema routes were measured and not taken. A project column in the FTS table was not faster and perturbed scores. An FTS table per project is the only near-proportional shape, but it changes scores. That one is left to the owner (design D7).
- **What stays the same:** the reported `similarity`, `LEXICAL_CANDIDATE_FLOOR`, `CANDIDATE_POOL_SIZE` and the vector and entity channels. Only the set of rows the bm25 ranking looks at changes.
- **New read on the save path:** the term-statistics read, bounded by the 16-token cap. It needs one new read-only repository method. That method tokenises a list of tokens through the existing temp-schema tokenising table and reads each token's terms back with their document frequencies, through a new temp-schema `fts5vocab` instance view over that table. Nothing durable changes.
- The interactive `memory.search` lexical branch has the same shape. This change investigates and measures it but does not change it (`measurements/search-path.txt`).

Behaviour change, not marked **BREAKING**: a lexical candidate that shared only common tokens with the saved text, among the text's first 16 tokens, may no longer be surfaced. No field, input, schema or stored row changes.

Invariants touched:

- **Scope at the service layer:** untouched. Term statistics are unscoped aggregates, which is the bounded exception "The relevance level's term statistics MUST come from the search index" already makes. They only remove rows from the match set; they never add one.
- **Append-only memory, `topic_key` convergence, fresh-context judgment:** untouched.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `memory`:
  - Adds "The save-time lexical `MATCH` MUST omit terms present in at least half of the index". It names `COMMON_TERM_DOCUMENT_RATIO` and the fallback.
  - Adds "The save-time lexical query MUST score only the saving project's matches".
  - Modifies "`memory.save` MUST surface candidate conflicts at save-time" so the builder paragraph allows that omission, by frequency and never by script, and still guarantees a non-empty `MATCH` whenever the builder yields a token.

## Impact

- **Code:**
  - `packages/db/src/repositories/memory-repository.ts`: `searchBm25Candidates` orders by `bm25(memory_fts)`.
  - `packages/core/src/services/save-time-candidates.ts`: the constant, the pruning step and a `commonTermRatio` test seam.
  - `packages/core/src/services/hybrid-search.ts`: the builder exposes its capped token list, so both callers share one builder.
  - `packages/db/src/query-tokenizer.ts`: one more temp-schema `fts5vocab` instance view.
  - `packages/db/src/repositories/term-statistics-repository.ts`: `adminTokenTermFrequencies`.
  - The `repos` picks of `runPostSaveSteps` and `memory.save` gain `termStatistics`.
- **Tests:**
  - `packages/core/src/services/save-time-candidates.test.ts`;
  - `packages/db/src/repositories/memory-repository.perf.test.ts`: the plan shape and score fidelity;
  - `packages/db/src/repositories/term-statistics-repository.test.ts`;
  - `packages/db/src/query-tokenizer.test.ts`;
  - the `admin*` allow-list in `apps/web/src/test/invariants.test.ts`, which gains one file entry.
- **Docs:** `docs/embeddings.md`, the detection diagram and the engine-constants table.
- **Specs:** `openspec/specs/memory/spec.md`.
- **Measurements:** under `openspec/changes/prune-common-terms-from-save-time-match/measurements/`.
- **No change to:** the durable schema, migrations, stored data, MCP input schemas, plugins, the installer or dependencies.
