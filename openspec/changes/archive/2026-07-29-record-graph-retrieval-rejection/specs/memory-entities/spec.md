## RENAMED Requirements

- FROM: `### Requirement: Entity retrieval MUST NOT be added as a fusion stream in this change`
- TO: `### Requirement: Entity retrieval MUST NOT be added as a fusion stream`

## MODIFIED Requirements

### Requirement: Entity retrieval MUST NOT be added as a fusion stream

Entity retrieval SHALL remain a separate exact-address mechanism and SHALL NOT contribute a ranked list to the text-query branch's Reciprocal Rank Fusion. Introducing such a stream SHALL require a measured improvement on the evaluation harness, recorded in a dedicated change.

The title of this requirement previously scoped it to "this change". A published requirement outlives the change that introduced it, so the prohibition is stated unqualified: it holds until a change lifts it on the evidence described below.

**The evidence, external and local.** Graph-augmented retrieval is measured behind plain retrieval on the query class that dominates a coding agent's traffic. GraphRAG-Bench (arXiv 2506.05690) reports plain RAG winning fact retrieval at 60.9% against 36.9–60.14% for graph methods, with graph methods ahead only on complex reasoning and summarisation. Mem0 (arXiv 2504.19413), the closest published analogue by domain — agent memory rather than document QA — reports its graph variant losing on single-hop (65.71 vs 67.13) and multi-hop (47.19 vs 51.15) at roughly twice the search latency and twice the tokens. Locally there is no headroom for a stream to buy: the committed hybrid baseline records `recallAtK` ceilings of 1 at both k=5 and k=8 with the k=8 floor at 0.95, floors being set at measured − 0.05, so measured recall@8 sits at its arithmetic ceiling.

**A figure previously stated here SHALL NOT be restated**: that adding a graph stream to a BM25-plus-vector fusion reduced Recall@5, NDCG@10 and MRR against BM25 alone "in its own author's benchmark". Two separate investigations failed to locate its source. The conclusion stands on the evidence above; the citation did not. A requirement resting on a number no reader can check invites the requirement to be dismissed along with it, which is the opposite of what a published prohibition is for.

**The bar for lifting the prohibition is therefore concrete.** The committed query set contains no global-sensemaking or summarisation query — the only classes the external measurements show a graph winning — so a proposed stream today is not merely unproven but unmeasurable. A change lifting this prohibition SHALL first give the harness a query class the stream could win, and SHALL then present a scorecard showing a gain on it, naming that class. Deterministic entity co-occurrence in particular SHALL NOT be assumed to supply the graph: measured on this codebase the extracted-entity graph is empty or near-empty, because the entity kinds are unambiguous *addresses* rather than concepts, and the judged relations in `memory_relations` are the denser structure by an order of magnitude.

#### Scenario: The text-query branch is unchanged

- **WHEN** `memory.search` is called with a text query and no entity filter
- **THEN** the fused result SHALL be identical to what the same query returns without the entity index present

#### Scenario: The prohibition is lifted only by a measurement on a class the stream could win

- **WHEN** a change proposes contributing entity matches as a ranked stream to the text-query fusion
- **THEN** it SHALL be rejected unless it presents an evaluation-harness scorecard showing an improvement, and names the query class the improvement was measured on
- **AND** a proposal that measures only against the existing query set SHALL be treated as unmeasured, because that set contains no class the external evidence shows a graph winning

#### Scenario: The unverifiable benchmark claim is not restated

- **WHEN** this requirement's evidence is read, cited, or copied into another document
- **THEN** it SHALL carry the named sources and the local ceiling measurement
- **AND** it SHALL NOT assert the previously-stated reduction in Recall@5, NDCG@10 and MRR whose source could not be located
