## 1. Harness skeleton

- [x] 1.1 Create `apps/server/src/test/retrieval/` with a retriever interface: `init(corpus) -> state`, `query(text, state, k) -> RankedMemoryId[]`, `teardown(state)`.
- [x] 1.2 Implement the ingest step: spin a throwaway database file, run migrations, ingest corpus memories through `MemoryService` (so `topic_key`, embedding and candidate detection all run), tear down afterwards.
- [x] 1.3 Implement scoring: Precision@k, Recall@k, MRR, tokens returned, p50/p95 latency — per query and aggregated, with a per-question-type breakdown.
- [x] 1.4 Emit per-query rows plus an aggregate summary to a gitignored report directory.

## 2. Corpus and query set

- [x] 2.1 Author the corpus fixture: hand-written coding-session memories for a fictional project, each with a stable id, spread over a plausible time range, across at least two projects plus global scope.
- [x] 2.2 For every gold memory, author at least one same-project vocabulary-sharing distractor that does not answer its query.
- [x] 2.3 Author the query set with `goldMemoryIds[]` and a `type` per query, covering extraction, `knowledge-update` (a `topic_key` saved twice — gold is the current head), `temporal`, `preference`, `multi-session-causal`, `cross-scope`, and `abstention` (empty gold).
- [x] 2.4 Include a small bilingual subset, since the memory spec already promises cross-lingual retrieval and has a scenario for it.
- [x] 2.5 Compute and record the arithmetic ceiling of each aggregate metric given the gold-set shape.

## 3. Retrievers

- [x] 3.1 `hybrid` — drives the production `memory.search` text-query path.
- [x] 3.2 `grep` — naive lowercase substring/keyword scoring over `title + content`, no index. The honest control.
- [x] 3.3 `memory-md-dump` — returns the N most recent memories up to a token budget, modelling the "put it in CLAUDE.md" alternative.
- [x] 3.4 Verify all three are scored against the identical corpus and query set.

## 4. Baselines and ratchet

- [x] 4.1 Generate and commit a scorecard per retriever under `apps/server/src/test/retrieval/baselines/`, each stating its metric ceilings, the discriminating metric, and the embedding identity.
- [x] 4.2 Implement floor comparison: fail when any metric drops below its committed floor.
- [x] 4.3 Add `pnpm run eval` to `apps/server/package.json`; confirm it is NOT reachable from `pnpm test`.
- [x] 4.4 Add a separate CI job invoking it, reusing the existing model cache key.

## 5. Sanity checks that the harness is worth trusting

- [x] 5.1 Assert `hybrid` beats `grep` on aggregate recall. If it does not, stop and fix the corpus or report the finding — this is the control, not a formality.
- [x] 5.2 Assert the corpus is large enough that the default rank window genuinely binds, so the harness cannot pass vacuously the way the existing 2-row candidate fixtures do.
- [x] 5.3 Assert determinism: two runs on unchanged inputs agree on every metric except latency.
- [x] 5.4 Assert isolation: a run leaves no developer or production data directory modified.

## 6. Verify

- [x] 6.1 `pnpm run typecheck && pnpm run lint && pnpm test` (unchanged runtime, so the unit suite must be unaffected).
- [x] 6.2 `pnpm run eval` green against the committed baselines.
- [x] 6.3 Record the measured `hybrid` numbers in the change so `fix-retrieval-ranking-math` has a before-picture to improve on.
