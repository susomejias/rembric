## MODIFIED Requirements

### Requirement: The corpus MUST include in-corpus distractors and abstention queries

A corpus of unrelated memories does not discriminate between retrievers. The committed corpus SHALL include, for each gold memory, at least one same-project near-miss that shares vocabulary with it but does not answer the query. The query set SHALL include `abstention` queries whose answer is deliberately absent from the corpus, scored on whether the retriever returns nothing rather than the least-bad rows.

The query set SHALL contain at least eight `abstention` queries. A threshold cannot be calibrated against a metric with three attainable values: with two such queries the abstention rate can only read 0, 0.5 or 1, so no sweep over it can distinguish a good value from a lucky one, let alone identify a plateau. Each `abstention` query SHALL share vocabulary with the scope it is issued against, so that the lexical branch returns candidates and the query tests the relevance gate rather than an empty candidate set.

Question types SHALL cover at minimum: extraction, `knowledge-update`, `temporal`, `preference`, `multi-session-causal`, `cross-project-isolation`, and `abstention`.

**The `cross-scope` query type is retired with the scope it named.** Its two committed queries each carried one gold memory in the global scope and one in a project, and scored a retriever on returning both — a shape that cannot exist once every scope is closed. They SHALL be **rewritten rather than deleted, and the floor SHALL NOT be lowered to accommodate their loss.** Losing half the gold on two of sixteen gold-bearing queries costs 0.0625 of Recall@8, which puts the measured value 0.0125 below the committed k=8 floor while remaining above the k=5 floor — a CI failure caused by two fixtures describing a world that no longer exists, not by a retrieval regression. Recording it as the new normal via the explicit lowering opt-in is therefore forbidden for this change.

The rewritten queries SHALL keep testing what the originals tested — a convention stated once and instantiated per project — with all gold in one project, and SHALL keep the isolation control the type was named for: a vocabulary-sharing memory in a second project that must not appear. The renamed type states the surviving property, so a reader cannot mistake it for the retired one.

#### Scenario: A distractor is not counted as a hit

- **GIVEN** a query whose gold memory has a vocabulary-sharing near-miss in the same project
- **WHEN** the retriever returns the near-miss and not the gold memory
- **THEN** the query SHALL score zero recall

#### Scenario: An abstention query is scored on restraint

- **GIVEN** a query whose answer is absent from the corpus
- **WHEN** the retriever returns any result
- **THEN** the abstention metric SHALL record a false positive for that query

#### Scenario: An abstention query exercises the gate, not an empty candidate set

- **GIVEN** any committed `abstention` query
- **WHEN** the production hybrid retriever runs it with both gates disabled
- **THEN** it SHALL return at least one result, proving the query's restraint score measures the gate rather than the absence of candidates

#### Scenario: A cross-scope query respects isolation

- **GIVEN** a gold memory in project A and a vocabulary-sharing memory in project B
- **WHEN** a query is run scoped to project A
- **THEN** project B's memory SHALL NOT appear in the results
- **AND** every gold id for that query SHALL live in project A, so the query is satisfiable without any scope being widened

#### Scenario: Retiring the global scope does not lower a committed floor

- **WHEN** the change that retires the global scope runs the harness against the committed baselines
- **THEN** Recall@8 SHALL be at or above the committed floor without the explicit lowering opt-in
- **AND** the retrieval fixtures SHALL be committed, so a run over a dirty working tree cannot be presented as the passing measurement
