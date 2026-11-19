## Context

The text-query branch (`packages/core/src/services/hybrid-search.ts`) runs a lexical and a dense retriever, fuses them with RRF, applies a relative relevance filter, multiplies by a recency/confirmation/type boost and truncates. Nothing in that pipeline reads the query against a candidate's text.

The server is a single Node process that already runs one ONNX model in-process (the embedder), on the thread that serves HTTP. The standing constraints are: the server makes no relation or lifecycle decision from a model's output; no external service; and the operator's host budget is 2–3 GB of RAM.

### Evidence

All figures come from scratch scripts run on one developer machine (10 cores, 2 intra-op threads) against a private corpus that is not committed and is not described further here. Relevance was graded 0/1/2 by blind LLM judges over the pooled top 8 of every arm (one judge per query, arm hidden, order shuffled). Pairs a later arm returned that nobody judged count as not relevant, which penalises the cheaper settings. The scripts are not committed; task group 6 reproduces the comparison inside the committed harness.

Quality (nDCG@8 / MRR), instrument: blind-graded pooled relevance.

| Arm                                                   | Current embedder | Replacement embedder |
| ----------------------------------------------------- | ---------------- | -------------------- |
| Fused search, no reranker                             | 0.630 / 0.739    | 0.670 / 0.793        |
| Rerank 20 × 256 tokens, gates off                     | 0.796 / 0.926    | 0.792 / 0.898        |
| Rerank 10 × 192 tokens, gates off                     | 0.783 / 0.913    | 0.803 / 0.908        |
| Rerank 10 × 192 tokens, relative filter applied first | 0.742 / 0.907    | 0.751 / 0.907        |

Paired difference of rerank 20 × 256 against no reranker on the current embedder: +0.166, bootstrap 95% CI [+0.091, +0.241]. Rerank 10 × 192 against 20 × 256 on the replacement embedder: +0.010, CI [−0.031, +0.050].

Rerank-only latency per search (p50 / p95), instrument: wall clock around the model calls, batches of 5.

| Window × tokens | Latency      |
| --------------- | ------------ |
| 20 × 256        | 268 / 283 ms |
| 12 × 192        | 115 / 128 ms |
| 10 × 192        | 97 / 107 ms  |
| 10 × 128        | 64 / 74 ms   |

The fused search without a reranker took 14 ms at the median end to end on the same corpus.

Worker threads, 10 × 192, replacement embedder in its own worker, instrument: process RSS and wall clock of the slowest of N simultaneous searches.

|                                   | 1 rerank worker         | 2 rerank workers        |
| --------------------------------- | ----------------------- | ----------------------- |
| RSS idle → under load             | 1389 → 1744 MB          | 1947 → 2371 MB          |
| N = 1 / 2 / 4 / 8                 | 94 / 185 / 373 / 771 ms | 95 / 150 / 290 / 597 ms |
| Main-thread event-loop delay, max | 5 ms                    | 3 ms                    |

In-process on the serving thread, the event loop was blocked for the full duration of each rerank.

## Goals / Non-Goals

**Goals:**

- Better ordering for deliberate searches (`memory.search`, `memory.context` relevance) with a bounded, measured latency cost.
- No stall of the serving thread, and a hard ceiling on what a burst can cost.
- Stay inside the 2–3 GB host budget with reranking on, and keep a way to run without it.

**Non-Goals:**

- Abstention. The cross-encoder score does not separate answerable from unanswerable queries on that corpus (best score of an answerable query as low as 0.15, of an unanswerable one as high as 0.85). The floor stays as it is.
- Any model-made decision: relations, supersession, lifecycle and save-time bands are untouched.
- Moving the embedder off the serving thread. It is cheaper per call and is its own follow-up.
- Reranking automatic surfaces (per-turn recall, file recall).

## Decisions

### 1. A cross-encoder reorders the fused head; it does not replace fusion

The retrievers still produce the candidates over full text; the model only orders the first rows. Alternatives: (a) replace the hand-made relevance level with the model score everywhere, rejected because the level is also the abstention quantity and the model score fails as one; (b) no reranker, rejected on the measured quality gap.

### 2. Model: `hindsight-ai/hs-rerank-1`, pinned

114M parameters, multilingual, one logit per pair, ships an int8 ONNX export that `@huggingface/transformers` 4.2.0 loads through `AutoModelForSequenceClassification` with no new dependency. Alternatives: base-size multilingual rerankers (roughly 300M–570M parameters), rejected because the cost is one forward pass per candidate and they do not fit the latency or memory budget; English-only MiniLM rerankers, rejected because the corpus and queries mix Spanish and English.

### 3. Window 10, 128 tokens per pair

10 × 192 matched 20 × 256 in quality at about a third of the time on the development machine, but on a 3-vCPU container one full window took 225 ms even with 3 threads (311 ms with 2), close enough to the 300 ms deadline that any second concurrent search fell back. With every pooled pair judged, 10 × 128 scored nDCG@8 0.757 against 0.778 for 10 × 192 (paired difference −0.021, 95% CI [−0.040, −0.004]), still +0.162 above today's search, and took 149 ms on the same container: about 89% of the gain for two thirds of the cost, with room for two concurrent searches inside the deadline. Both are compile-time constants, consistent with how the repository treats retrieval constants; changing either re-runs the evaluation. The worker uses up to 4 intra-op threads. Alternative: operator-configurable values, rejected for the same reason the other retrieval constants are not configurable: the trade is measured, not a preference.

### 4. Keep the boost; drop the relative filter on this path

Ordering by the model score alone lost the most-recent-decision ordering on the synthetic corpus (MRR 0.900 → 0.875), and recovered above baseline (0.925) once multiplied by the existing boost. Applying the relative filter before reranking scored lower than reranking the unfiltered head on both embedders (0.742 vs 0.783, 0.751 vs 0.803): the filter withholds candidates from a better judge. The floor and the empty-pool verdict still run first, so an abstaining query costs no inference.

### 5. Opt-in per surface

`searchWithAbstention` takes a `rerank` option. `memory.search` and `memory.context`'s ranked pass pass it; `/api/<slug>/memory/recall`, file recall and save-time detection do not. Alternative: rerank everything, rejected because the automatic surfaces fire per turn and in bursts, where a 14 ms search becoming ~110 ms is paid many times for hints the agent did not ask for.

### 6. One worker thread, tokenizing inside it

The worker owns the model and its tokenizer; the serving thread posts `{query, documents}` and awaits scores. Alternatives: (a) in-process, rejected because it blocks the event loop for the whole inference; (b) tokenize on the serving thread and transfer tensors, rejected because it saved about 170 MB per extra worker but stalled the serving thread 125–215 ms under a burst of 8; (c) a pool, rejected because a second worker cost about 600 MB for 22% lower latency at 8 concurrent searches and a fourth was no faster than a third.

### 7. Deadline with fallback to the unreranked response

A single worker serialises requests, so latency grows linearly with simultaneous searches. Each call carries `RERANK_DEADLINE_MS`; on expiry, or when the model is not loaded, the call returns exactly what the unreranked path returns. This bounds the worst case and makes every failure mode of the reranker degrade to today's behaviour. The fallback needs the unreranked result, so the service computes the gated, boosted page from the same fused pool it already has; no second retrieval runs.

### 8. No off switch

Reranking is on by default. An earlier draft shipped `REMBRIC_RERANK=off`; the owner removed it because the measured gain is the point of the change, then restored it (2026-11-19) for hosts shared with other workloads, where the operator may prefer to keep the reranker's ~0.45 GB and its CPU for them. The switch is an operator choice, not failure handling. Failure handling does not need it: a model that cannot load, a crashed worker or a CPU too slow for the deadline already degrade each search to the unreranked order. Once the embedding backlog is empty, boot times one full window: a CPU that cannot meet the deadline stands the reranker down (the worker exits and searches stop waiting the 300 ms out) and is timed again every 15 minutes, so a busy moment at boot on a shared host does not switch reranking off until the next restart, and on one that can, a search that could not clear the queue ahead of it in time falls back at once instead of queueing. Picking a smaller window or token cap by hardware was rejected: every rung needs its own quality measurement and baseline, the same query would order differently on different hosts, and at one vCPU even the rung that fit held only for a search running alone. Below the documented minimum the answer is more hardware, not an adaptive reranker. Alternatives: default-off (rejected: the gain is the point) and no switch at all (the earlier choice, reversed for shared hosts).

### 9. The window takes the dense list's first rows directly, not the fused head

Reciprocal Rank Fusion sums reciprocal ranks, so a row only one retriever found sits below every row both found. That buried the case the dense retriever exists for: a query in one language whose answer is stored in another. On a synthetic scope holding English targets and unrelated Spanish memories, the target was the dense retriever's first row for Spanish, French and Japanese queries, while the lexical retriever matched the Spanish memories on function words; the fused order put the target at rank 17 to 20, outside a ten-row window, and the model never read it. When it did read it, it ranked it first in every language.

The first fix interleaved the two lists rank by rank, which gives the dense list about five of the ten rows. On a private production corpus that was not enough: for a query in one language, the embedder ranked several same-language memories on other topics above the cross-language answer, so the answer was often the dense list's sixth to tenth row. The window therefore reserves `RERANK_DENSE_SLOTS` (8) rows for the dense list and gives the lexical list the rest. Measured on that corpus against the interleaved window, with cross-language probes whose answer is known and same-language known-item queries (a work session's title, answered by the memories saved in that session): eight dense rows answered more cross-language probes and raised their mean reciprocal rank, while the same-language queries did not move (paired difference in nDCG@8 within ±0.01, its confidence interval spanning zero). Nine dense rows answered one more probe but started losing same-language answers, and a window of dense rows only lost them clearly, which is why the lexical list keeps two rows. On the committed evaluation the reranked retriever is unchanged (nDCG@8 0.963). Cost is unchanged: still ten pairs.

Alternatives: a larger window, rejected because inference cost is linear in the window and ten pairs already take most of the deadline at the documented minimum; weighting the dense list in the fusion, deferred because it changes the order of every unreranked search and needs its own evaluation. The unreranked path is not changed by this decision and still misses cross-language queries; its committed floors say so.

## Risks / Trade-offs

- [Risk] Latency of deliberate searches rises from ~14 ms to ~110 ms, more on slower CPUs than the measurement machine → Mitigation: the deadline caps it; task 6.4 measures on the published image's target architecture before the constants are frozen.
- [Risk] The reranker demotes related-context memories below ones that match the query literally (the dominant pattern among the queries it lost) → Accepted because it won on far more queries than it lost; a rerank/fusion score blend is an open question, not part of this change.
- [Risk] A memory whose answering text lies beyond 128 tokens can be misordered → Mitigation: it is still retrieved over its full text and stays in the window; the harness gains long-memory fixtures so the cost is observable.
- [Risk] The evidence is a few dozen queries with one LLM judge each → Mitigation: the committed harness arm gates the reranked path against the unreranked one in CI.
- [Trade-off] Resident memory grows by roughly the reranker worker (about 1 GB with its tokenizer) → Accepted because it lands after the embedder swap, which frees about 0.8 GB; measured on the built image, the process stays near 1.3 GB under load.
- [Risk] Next.js standalone output must ship the worker entry file → Mitigation: task 3.5 proves the worker starts from the built standalone bundle, not only under `next dev`.
- [Trade-off] The relevance-level machinery stays; the code does not get shorter → Accepted because the level remains the abstention quantity and the fallback path.

## Migration Plan

No schema change. Deploy is the new image; the model is baked in. Rollback is the previous image.

## Open Questions

- Should the embedder also move to a worker thread? Measured with both in workers, embedding during two concurrent reranks took 32 ms at the median. Deferred to its own change.
- Would blending the rerank score with the fused rank recover the related-context losses? Not measured.
- Should `memory.doctor` report reranker state and the fallback count? The counters exist after this change; exposing them is a contract addition to decide separately.
