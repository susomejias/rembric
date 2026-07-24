## ADDED Requirements

### Requirement: The harness MUST score retrieval deterministically against a committed labelled corpus

The system SHALL provide an offline evaluation harness that ingests a committed corpus through the production write path, runs a committed query set against a retriever, and reports Precision@k, Recall@k, MRR, tokens returned, and p50/p95 latency. Scoring SHALL be fully deterministic: no language model participates in ingestion, retrieval, or grading. Gold units SHALL be memory ids, because the memory row is the retrieval unit.

Each run SHALL emit per-query rows and an aggregate summary, and the aggregate SHALL include a breakdown per question type, so a regression can be localised rather than merely detected.

#### Scenario: A run produces per-query and aggregate results

- **WHEN** the harness is run against the committed corpus and query set
- **THEN** it SHALL emit one scored row per query and an aggregate summary containing Precision@k, Recall@k, MRR, tokens returned, and p50/p95 latency
- **AND** the aggregate SHALL include the same metrics broken down by question type

#### Scenario: Two runs on unchanged inputs agree

- **WHEN** the harness is run twice against identical corpus, query set, and retriever
- **THEN** every reported metric SHALL be identical apart from latency

### Requirement: Ingestion MUST go through the production write path

The harness SHALL ingest corpus memories via `MemoryService` into a throwaway database file, not by direct SQL insertion. This ensures the evaluated corpus has been subject to `topic_key` supersession, inline embedding, and save-time candidate detection exactly as production memories are, so the harness measures the system that actually ships.

#### Scenario: A knowledge-update pair converges during ingestion

- **GIVEN** two corpus memories sharing a `topic_key`, the second superseding the first
- **WHEN** the corpus is ingested
- **THEN** only the later memory SHALL be `active`, and a `knowledge-update` query SHALL be scored against the current answer

#### Scenario: Ingestion leaves no shared state

- **WHEN** the harness completes
- **THEN** it SHALL have written only to a throwaway database file and SHALL NOT have modified any developer or production data directory

### Requirement: The corpus MUST include in-corpus distractors and abstention queries

A corpus of unrelated memories does not discriminate between retrievers. The committed corpus SHALL include, for each gold memory, at least one same-project near-miss that shares vocabulary with it but does not answer the query. The query set SHALL include `abstention` queries whose answer is deliberately absent from the corpus, scored on whether the retriever returns nothing rather than the least-bad rows.

Question types SHALL cover at minimum: extraction, `knowledge-update`, `temporal`, `preference`, `multi-session-causal`, `cross-scope`, and `abstention`.

#### Scenario: A distractor is not counted as a hit

- **GIVEN** a query whose gold memory has a vocabulary-sharing near-miss in the same project
- **WHEN** the retriever returns the near-miss and not the gold memory
- **THEN** the query SHALL score zero recall

#### Scenario: An abstention query is scored on restraint

- **GIVEN** a query whose answer is absent from the corpus
- **WHEN** the retriever returns any result
- **THEN** the abstention metric SHALL record a false positive for that query

#### Scenario: A cross-scope query respects isolation

- **GIVEN** a gold memory in project A and a vocabulary-sharing memory in project B
- **WHEN** a query is run scoped to project A
- **THEN** project B's memory SHALL NOT appear in the results

### Requirement: The harness MUST ship a naive baseline and a context-dump baseline

The harness SHALL provide at least three retrievers behind one interface: the production hybrid search, a naive substring/keyword `grep` baseline, and a context-dump baseline that returns the N most recent memories up to a token budget.

The `grep` baseline is the honest control — if hybrid search does not beat it on this corpus, either the corpus fails to discriminate or the retriever is not earning its complexity. The context-dump baseline is the measurable form of the product claim, because it is the alternative operators actually compare against, and the comparison is about tokens as much as recall.

#### Scenario: Baselines are scored on the same corpus and queries

- **WHEN** the harness is run with each retriever
- **THEN** all retrievers SHALL be scored against the identical corpus and query set, and their scorecards SHALL be directly comparable

#### Scenario: The token axis is reported alongside recall

- **WHEN** the context-dump baseline and hybrid search are compared
- **THEN** each scorecard SHALL report tokens returned alongside recall, so a recall difference is interpretable against its context cost

### Requirement: Scorecards MUST state the arithmetic ceiling of their own metrics

Precision@k is bounded above by the gold-set shape: a query set that is mostly single-gold cannot approach a Precision@5 of 1.0 no matter how perfect the retriever. Every committed scorecard SHALL state the arithmetic maximum of each aggregate metric given the gold-set shape, and SHALL name which metric is the discriminating signal for that corpus.

#### Scenario: A saturated metric is labelled

- **GIVEN** a query set whose gold-set shape caps Precision@5 well below 1.0
- **WHEN** a scorecard is generated
- **THEN** it SHALL state that ceiling and SHALL identify recall as the discriminating metric

### Requirement: Regressions MUST fail CI via a committed ratchet

Committed baseline scorecards SHALL define a floor per metric. CI SHALL run the harness and SHALL fail when any metric falls below its floor. The harness SHALL run as a target separate from the unit-test suite, because it is slow, and a floor SHALL only be lowered by an explicit committed change to the baseline.

#### Scenario: A tuning change that regresses recall is rejected

- **WHEN** a change lowers Recall@5 below the committed floor
- **THEN** the evaluation job SHALL fail

#### Scenario: A tuning change that improves recall passes and can raise the floor

- **WHEN** a change raises Recall@5 above the committed floor
- **THEN** the job SHALL pass, and the baseline MAY be updated in the same change to ratchet the floor upward

#### Scenario: The harness does not slow the unit suite

- **WHEN** the unit test suite runs
- **THEN** the evaluation harness SHALL NOT execute as part of it
