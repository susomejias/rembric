## ADDED Requirements

### Requirement: The harness MUST evaluate the reranked path as its own retriever

The evaluation harness SHALL run the reranked search path as a retriever of its own, against the identical ingested corpus and query set as the unreranked hybrid retriever, and SHALL commit a baseline for it with the same floors and caps discipline. Without it the reranker's shipped constants would rest on a measurement nobody can re-run, and a regression in ordering would be invisible to CI.

The query set SHALL include queries written in a different language from the memory that answers them, in a scope that also holds memories in the query's language, because that is the case where only the dense retriever can find the answer and the lexical retriever returns unrelated rows. The reranked retriever SHALL answer them; the unreranked hybrid retriever is scored on them as it is, so its committed floors record what it does today rather than what it should do.

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

## MODIFIED Requirements

### Requirement: The harness MUST be able to FAIL on over-widening, and the proof is a mutation that reddens it

The harness SHALL be able to fail on over-widening, and a committed mutation that reddens it SHALL be the proof.

A green evaluation run has never been evidence of scope isolation, and this was measured rather than suspected: under a mutation dissolving the scope predicate in the memory repository's shared WHERE fragment — total loss of isolation — MRR@8 **rose** and the evaluation stayed green. The rise was 0.828 → 0.859 when first measured, and 0.828 → **0.891** when re-measured on the corpus this change starts from; the direction is the finding and it reproduced on both. A harness whose gated metrics improve when isolation is destroyed cannot be the evidence that a deliberate widening is safe.

The harness SHALL therefore be able to fail on over-widening **before** any widening ships, and the obligation SHALL be discharged by demonstration rather than by construction: a mutation that dissolves scope isolation SHALL make the evaluation **RED**. A change that adds a metric, a query or a fixture without demonstrating that red has not satisfied this requirement.

**The demonstration SHALL also record what the QUALITY metrics did under the same mutation**, because the answer decides what may be relied on afterwards. Where they fail to fall — measured on the shipped retriever, MRR@8 reads 0.9166666666666666 both mutated and unmutated, bit-identical, while Precision@8 and Recall@8 do not move either — the gate works _despite_ them rather than through them, and no floor metric SHALL thereafter be treated as a proxy for the metric that counts foreign rows. The figure this sentence carried before (MRR@8 rising 0.854 → 0.858) was accurate when the fixtures landed and went stale when the retriever changed two commits later: the unmutated arm was re-measured and the mutated one was not. The case for the cap hardened rather than weakened — all three floor metrics are now completely blind where one of them at least moved, wrongly.

Three structural defects SHALL be corrected, each named because each independently defeats detection:

1. **Gold sets smaller than `k`.** With `|gold| ≪ k` the Precision@k denominator is pinned at `k` and Recall@k saturates at 1.0, so once every gold row is returned it does not matter which rows fill the remaining slots — foreign rows displace nothing measurable. The query set SHALL contain at least one query per gated `k` whose gold set is at least as large as that `k`, so that a foreign row occupying a slot **displaces a gold row** and moves Precision@k and Recall@k.
2. **No cross-project distractors.** The corpus SHALL contain, for at least one gold-bearing query, a **strongly**-matching memory in a different project — one that a scope-blind retriever would rank at or above the gold rows, not merely a vocabulary overlap. A distractor that would never be returned anyway proves nothing about isolation.
3. **No metric counting foreign rows.** A new lower-is-better metric SHALL count them directly (see the modified ratchet requirement).

The demonstration SHALL be committed as a reproducible artifact naming the mutation applied, the metric that moved, and the direction — so a future reader can re-run it rather than trust it.

#### Scenario: The over-widening mutation reddens the evaluation

- **GIVEN** the corpus, query set and gated metrics after this change
- **WHEN** the scope predicate is mutated so that reads admit every project
- **THEN** the evaluation job SHALL fail, naming the metric that breached its bound
- **AND** the unmutated run SHALL pass, so the failure is attributable to the mutation rather than to a broken harness

#### Scenario: A foreign row displaces a gold row

- **GIVEN** a query whose gold set is at least as large as the gated `k`, and a strongly-matching memory in another project
- **WHEN** a scope-blind retriever returns that foreign memory inside the top `k`
- **THEN** at least one gold row SHALL fall out of the page and Recall@k SHALL drop below its committed floor

#### Scenario: The isolation queries are not saturated for the control

- **WHEN** the cross-project isolation queries are scored for the `grep` control baseline as well as for hybrid search
- **THEN** at least one of them SHALL discriminate between the two, so the query set does not consist entirely of queries every retriever answers perfectly
