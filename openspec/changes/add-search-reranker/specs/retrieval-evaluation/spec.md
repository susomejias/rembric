## ADDED Requirements

### Requirement: The harness MUST evaluate the reranked path as its own retriever

The evaluation harness SHALL run the reranked search path as a retriever of its own, against the identical ingested corpus and query set as the unreranked hybrid retriever, and SHALL commit a baseline for it with the same floors and caps discipline. Without it the reranker's shipped constants would rest on a measurement nobody can re-run, and a regression in ordering would be invisible to CI.

The reranked retriever SHALL use the real cross-encoder, not a stand-in, and SHALL be scored with a rank-sensitive metric in addition to the existing ones, because the reranker reorders a pool it does not widen: recall at `k` alone cannot see its effect. Its committed floors SHALL be at or above the unreranked hybrid retriever's on every gated metric at every committed `k`, so a change that makes reranking worse than not reranking fails the gate.

The corpus SHALL contain memories longer than `RERANK_MAX_TOKENS` whose answering text lies beyond that length, so the cost of truncation is observable rather than assumed.

The harness SHALL also report, as a series of its own and never merged with a quality metric, the reranked path's end-to-end latency per query, naming what it timed.

#### Scenario: The reranked retriever is gated against the unreranked one

- **WHEN** the evaluation runs
- **THEN** it SHALL score the reranked retriever and SHALL fail when any of its gated metrics falls below the unreranked hybrid retriever's at the same `k`

#### Scenario: A change to a rerank constant re-runs the evaluation

- **WHEN** a change alters `RERANK_WINDOW` or `RERANK_MAX_TOKENS`
- **THEN** the committed reranked baseline SHALL be regenerated in the same change

#### Scenario: Truncation is exercised by the corpus

- **WHEN** the corpus is inspected
- **THEN** it SHALL contain at least one gold memory whose answering text begins beyond `RERANK_MAX_TOKENS`
