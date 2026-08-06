# retrieval-evaluation Specification

## Purpose

A deterministic, offline harness that scores retrieval quality over a committed labelled corpus, with pluggable retrievers, baseline controls, and a CI ratchet. It exists so that every retrieval-tuning change (rank constants, thresholds, decay windows, review TTLs) is validated against a measured Precision@k / Recall@k / MRR / tokens-returned / latency scorecard instead of an argument.

## Requirements

### Requirement: The harness MUST score retrieval deterministically against a committed labelled corpus

The system SHALL provide an offline evaluation harness that ingests a committed corpus through the production write path, runs a committed query set against a retriever, and reports Precision@k, Recall@k, MRR, tokens returned, and p50/p95 latency. Scoring SHALL be fully deterministic: no language model participates in ingestion, retrieval, or grading. Gold units SHALL be memory ids, because the memory row is the retrieval unit.

Each run SHALL emit per-query rows and an aggregate summary, and the aggregate SHALL include a breakdown per question type, so a regression can be localised rather than merely detected. The per-question-type breakdown SHALL reach disk in the per-retriever report; `summary.json` carries the headline aggregate only, and its absence there is not a gap.

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

A corpus of unrelated memories does not discriminate between retrievers. The committed corpus SHALL include, for each gold memory, at least one same-project near-miss that shares vocabulary with it but does not answer the query. **It SHALL additionally include, for at least one gold-bearing query per gated `k`, a strongly-matching memory in a DIFFERENT project — one a scope-blind retriever would rank inside the top `k` — so that a loss of isolation costs a measurable metric rather than merely reordering rows nobody counts.** The query set SHALL include `abstention` queries whose answer is deliberately absent from the corpus, scored on whether the retriever returns nothing rather than the least-bad rows.

The query set SHALL contain at least eight `abstention` queries. A threshold cannot be calibrated against a metric with three attainable values: with two such queries the abstention rate can only read 0, 0.5 or 1, so no sweep over it can distinguish a good value from a lucky one, let alone identify a plateau. Each `abstention` query SHALL share vocabulary with the scope it is issued against, so that the lexical branch returns candidates and the query tests the relevance gate rather than an empty candidate set.

**Gold-set size is a gate on the harness's own discriminating power, not a corpus-authoring preference.** Where every gold set is far smaller than the gated `k`, Precision@k is pinned at its arithmetic ceiling and Recall@k saturates, so no row that fills a remaining slot can move a gated metric — including a row from another project. The query set SHALL therefore contain, for each gated `k`, at least one gold-bearing query whose gold set holds at least `k` members.

**The query set SHALL contain at least one query that explicitly requests widening, and its gold SHALL live in a project other than the one it is issued against.** Widened queries are excluded from the foreign-scope cap's denominator (see the modified ratchet requirement), so without such a query that exclusion is never exercised and "widened queries are gated by a different instrument" is an assertion rather than a fact. With one, deleting the widening drops its recall to zero and breaches an ordinary floor, which is what makes the claim checkable.

Question types SHALL cover at minimum: extraction, `knowledge-update`, `temporal`, `preference`, `multi-session-causal`, `cross-project-isolation`, `cross-project-widened`, and `abstention`.

**The `cross-scope` query type is retired with the scope it named.** Its two committed queries each carried one gold memory in the global scope and one in a project, and scored a retriever on returning both — a shape that cannot exist once every scope is closed. They SHALL be **rewritten rather than deleted, and the floor SHALL NOT be lowered to accommodate their loss.** Losing half the gold on two of sixteen gold-bearing queries costs 0.0625 of Recall@8, which puts the measured value 0.0125 below the committed k=8 floor while remaining above the k=5 floor — a CI failure caused by two fixtures describing a world that no longer exists, not by a retrieval regression. Recording it as the new normal via the explicit lowering opt-in is therefore forbidden for this change.

**No fixture SHALL construct a scope the server can no longer produce.** The ingestion path builds corpus rows through the production write path, so a corpus item naming a retired scope keeps a dead arm alive in the type system and exercises a code path no runtime caller can reach. Every corpus item and every query SHALL name a project.

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
- **WHEN** a query is run scoped to project A without any widening argument
- **THEN** project B's memory SHALL NOT appear in the results
- **AND** every gold id for that query SHALL live in project A, so the query is satisfiable without any scope being widened

#### Scenario: Retiring the global scope does not lower a committed floor

- **WHEN** the change that retires the global scope runs the harness against the committed baselines
- **THEN** Recall@8 SHALL be at or above the committed floor without the explicit lowering opt-in
- **AND** the retrieval fixtures SHALL be committed, so a run over a dirty working tree cannot be presented as the passing measurement

#### Scenario: A gold set is large enough to be displaced

- **WHEN** the committed query set is inspected for each gated `k`
- **THEN** at least one gold-bearing query SHALL carry at least `k` gold ids, so that a single non-gold row inside the page reduces Recall@k

#### Scenario: No corpus item names a retired scope

- **WHEN** the committed corpus and query set are inspected
- **THEN** every item and every query SHALL name a project, and none SHALL name the retired global scope

#### Scenario: A widened query's gold lives where the narrow search cannot reach it

- **GIVEN** the committed query set
- **WHEN** the queries declaring widening are inspected
- **THEN** at least one SHALL exist, and every gold id it carries SHALL belong to a project other than the one the query is issued against
- **AND** mutating the retriever's widening to read the home project alone SHALL drop that query's recall to zero and breach a committed floor

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

Committed baseline scorecards SHALL define a floor for each **quality** metric — Precision@k, Recall@k and MRR, enumerated as `FLOOR_METRICS` — and CI SHALL run the harness and fail when any of them falls below its floor. The harness SHALL run as a target separate from the unit-test suite, because it is slow, and a floor SHALL only be lowered by an explicit committed change to the baseline.

The lower-is-better metrics SHALL be enumerated separately, as `CAP_METRICS`, and gated as caps in their own baseline block: the abstention false-positive rate, the over-abstention rate (see "Abstention MUST be scored on both error axes and gated as a cap"), **and the foreign-scope rate**. Enumerating them apart from `FLOOR_METRICS` is what makes the comparison direction structural rather than remembered — a metric in the cap list cannot be accidentally compared like a floor.

**The foreign-scope rate SHALL be the fraction of returned rows whose `project_id` is not the project the query was issued against, aggregated over the queries that did not request widening, and its committed cap SHALL be exactly 0.** Unlike the other two caps it is not a tuning bound but an isolation gate: any value above zero means a read admitted a project nobody asked for. It is gated rather than merely reported because the quality metrics are blind to a total loss of isolation, so no floor metric can serve as its proxy. Queries that DO request widening SHALL be excluded from its denominator — foreign rows are their purpose — and SHALL instead be gated by the ordinary quality floors against gold that deliberately lives in another project.

One metric remains measured and reported but NOT gated, and the gap is stated rather than implied, because "a floor per metric" read as unconditional and a regression that doubled the tokens returned would pass CI unremarked: `avgTokensReturned` has no committed ceiling. It SHALL be closed by its own change; until then no requirement SHALL claim CI protects the token axis. **In particular the foreign-scope cap SHALL NOT be read as covering it: a widening that returns the same number of rows from the wrong projects moves no token count at all, and a widening that doubles the tokens returned from authorized projects breaches no cap.**

A cap SHALL be derived as `measured + headroom` where `headroom` is ONE query's worth of that metric's own step, computed from the committed query set's denominator for that metric rather than from a shared literal — the axes count over different query sets (empty-gold queries for the false-positive rate, gold-bearing ones for over-abstention, **returned rows on non-widened queries for the foreign-scope rate**), so a single headroom taken from the coarsest axis silently tolerates several queries going wrong on a finer one. A cap SHALL be clamped to 1, all three metrics being rates. **The foreign-scope cap is the exception that proves the rule and SHALL be committed at 0 with no headroom**, because one foreign row is not a tolerable measurement error — it is the defect.

The ratchet SHALL be enforced by the baseline WRITER, not left to the author's discipline, and SHALL apply in both directions of goodness: a floor SHALL never be reduced, and a cap SHALL never be raised, as a side effect of regenerating baselines. A bound derived from a measurement is not a gate on its own: regenerating baselines after a regression rewrites the bound PAST the regressed value, so the next run compares against the worse number and the job stays green permanently, with nothing recording that the gate moved. A proposed bound looser than the committed one is discarded in favour of the committed one, and the fact is reported.

Loosening a bound SHALL remain possible, because a deliberate trade (recall for tokens, say) is legitimate — but only through an explicit opt-in on the write, and every loosened bound SHALL be named in the output so it appears in review rather than only in a diff of generated JSON. The ratchets SHALL be pure functions, unit-tested independently of the slow harness, so the properties "a floor only ever moves up" and "a cap only ever moves down" are asserted rather than assumed.

#### Scenario: A tuning change that regresses recall is rejected

- **WHEN** a change lowers Recall@5 below the committed floor
- **THEN** the evaluation job SHALL fail

#### Scenario: A tuning change that improves recall passes and can raise the floor

- **WHEN** a change raises Recall@5 above the committed floor
- **THEN** the job SHALL pass, and the baseline MAY be updated in the same change to ratchet the floor upward

#### Scenario: Regenerating baselines after a regression does not lower the floor

- **GIVEN** a committed floor and a measurement whose derived floor would fall below it
- **WHEN** baselines are regenerated without the explicit lowering opt-in
- **THEN** the committed floor SHALL be preserved and the attempted reduction SHALL be reported

#### Scenario: Regenerating baselines after a regression does not raise a cap

- **GIVEN** a committed cap and a measurement whose derived cap would rise above it
- **WHEN** baselines are regenerated without the explicit loosening opt-in
- **THEN** the committed cap SHALL be preserved and the attempted increase SHALL be reported

#### Scenario: Lowering a floor is explicit and named

- **WHEN** baselines are regenerated WITH the lowering opt-in and a floor drops
- **THEN** the written floor SHALL be the lower value and the output SHALL name every metric and `k` that was lowered

#### Scenario: Repeated regeneration cannot drift a floor down

- **GIVEN** an unchanged measurement
- **WHEN** baselines are regenerated any number of times
- **THEN** every floor and every cap SHALL be identical after every write

#### Scenario: An ungated metric is reported, not enforced

- **WHEN** a change doubles `avgTokensReturned` without moving any quality metric
- **THEN** the harness SHALL report the new value and the job SHALL pass — the token axis carries no committed ceiling, and any claim that it is gated SHALL be treated as a spec defect

#### Scenario: A single foreign row fails the run

- **GIVEN** a query set in which no query requests widening
- **WHEN** one returned row carries a `project_id` other than the query's own
- **THEN** the foreign-scope rate SHALL exceed its committed cap of 0 and the job SHALL fail
- **AND** the unmutated run SHALL report exactly 0, so the cap is not satisfied by an empty result set

#### Scenario: A widened query is not penalised by the foreign-scope cap

- **GIVEN** a query that explicitly requests widening and whose gold lives in another project
- **WHEN** the retriever returns that gold row
- **THEN** the foreign-scope rate SHALL be unaffected, and the query SHALL be scored by the ordinary quality metrics

#### Scenario: The harness does not slow the unit suite

- **WHEN** the unit test suite runs
- **THEN** the evaluation harness SHALL NOT execute as part of it

### Requirement: Abstention MUST be scored on both error axes and gated as a cap

Abstention has two failure modes and the harness SHALL report each as its own number. Returning results for a query whose answer is absent is a **false positive**; returning nothing for a query that has a gold answer is **over-abstention**. Folding the second into recall makes it indistinguishable from bad ranking, which is precisely the distinction a floor calibration turns on: it is the difference between "the threshold is too high" and "retrieval is weak".

Every aggregate SHALL therefore report an abstention false-positive rate over the empty-gold queries and an over-abstention rate over the gold-bearing queries, at each committed `k` and in the per-question-type breakdown.

Both SHALL be gated in CI. Because lower is better for each, they SHALL be gated as **caps** — a run fails when a measured value rises above its committed cap — rather than as floors, and the committed baseline SHALL record them separately from the lower-is-worse floors so the two cannot be compared in the wrong direction.

A retriever's abstention SHALL be defined, for SCORING purposes, as returning no results — that is what a caller observes and it is the only definition all retrievers can satisfy. That scoring definition SHALL NOT be promoted into a correctness requirement on a retriever's own flag. A retriever that reports an explicit flag MAY legitimately return no results while reporting `abstained: false`: the `memory` capability mandates exactly that for a page sliced beyond a non-empty candidate pool ("BREAKING — offset is best-effort on the hybrid branch") and for a page the relative relevance filter shortened to nothing. Requiring the harness to fail on it would put the harness in contradiction with the shipped retrieval contract, and the retrieval contract is the authority on what a retriever does.

The remaining direction IS a correctness requirement and SHALL be enforced: a retriever that reports `abstained: true` while returning results is incoherent under any reading of the flag, and the harness SHALL fail the run naming the retriever, the query and the returned count. This is the direction a future abstention floor could plausibly break.

Because the committed corpus cannot exercise that check — no committed query yields an empty candidate pool, so no outcome exercises either direction — the check SHALL NOT be presented as covered by the evaluation run. It SHALL instead carry a direct test over constructed outcomes, asserting that the enforced direction fails and that the permitted combination passes. A guard whose only evidence is a green job that would be green without it SHALL be treated as untested.

#### Scenario: A gold-bearing query that returns nothing is visible as over-abstention

- **GIVEN** a query with a gold answer, and an abstention floor set high enough to reject it
- **WHEN** the harness scores the run
- **THEN** the over-abstention rate SHALL be non-zero, and SHALL be reported separately from recall

#### Scenario: A regression in either abstention axis fails CI

- **GIVEN** a committed cap for the abstention false-positive rate and for the over-abstention rate
- **WHEN** a change raises either measured value above its cap
- **THEN** the evaluation job SHALL fail, naming the metric and both values

#### Scenario: An abstention flag that disagrees with the result set fails the run

- **GIVEN** a retriever that reports an explicit abstention flag
- **WHEN** it reports `abstained: true` while returning one or more results
- **THEN** the evaluation job SHALL fail, naming the retriever, the query and the number of results returned
- **AND** the converse combination SHALL NOT fail the run, which the next scenario pins

#### Scenario: An empty result set with `abstained: false` does not fail the run

- **GIVEN** a retriever that reports an explicit abstention flag
- **WHEN** it returns no results while reporting `abstained: false` — the response the `memory` capability mandates for a page sliced beyond a non-empty candidate pool
- **THEN** the evaluation job SHALL NOT fail on the flag check
- **AND** the query SHALL still be scored as an abstention for the two rate metrics, which are defined on emptiness

#### Scenario: The flag check is tested directly, not inferred from a green run

- **WHEN** the flag check is exercised over constructed outcomes rather than over the committed corpus
- **THEN** an outcome reporting `abstained: true` with results SHALL produce a failure naming that outcome
- **AND** an outcome reporting `abstained: false` with no results SHALL produce no failure

### Requirement: The harness MUST emit a reproducible calibration sweep for the abstention gates

A threshold chosen by inspecting one scorecard is a guess with a number attached. The harness SHALL provide a sweep mode that runs the production retriever across a committed grid of abstention-floor and relative-ratio values and reports, per grid point, recall, the abstention false-positive rate, the over-abstention rate and tokens returned, at every committed `k`.

The sweep SHALL be invocable as a documented command so that any reviewer can reproduce the grid that justified a value, and SHALL be deterministic on unchanged inputs like every other harness output. It SHALL also report each component of the relevance level — the lexical coverage and the dense cosine of that same leading row — so that a decision to split the single level into per-branch thresholds can be made on measured evidence rather than on preference.

Because the lexical component is weighted by corpus term statistics, the sweep SHALL additionally report the statistics that produced the weights: the document total the weights were computed against, and, for the leading row of each query, the document frequency of every query term. Without them a reader cannot tell a level that moved because the row changed from one that moved because the corpus did, and the grid stops being reproducible from the committed corpus alone.

A change to the definition of the relevance level SHALL be justified by a sweep run against an UNCHANGED corpus and query set, and SHALL cite the previous committed grid as its before. Changing the corpus and the level function in one change makes the comparison uninterpretable, so the two SHALL land as separate changes.

#### Scenario: The sweep reports every axis at every grid point

- **WHEN** the sweep is run
- **THEN** it SHALL emit one row per grid point containing recall, the abstention false-positive rate, the over-abstention rate and tokens returned, at each committed `k`

#### Scenario: A value's plateau is visible in the sweep output

- **GIVEN** a candidate value that satisfies every acceptance criterion
- **WHEN** the sweep output is read
- **THEN** the adjacent grid points' results SHALL be present in the same output, so whether the value sits in a plateau or on a cliff edge is readable without re-running the harness

#### Scenario: Two sweeps on unchanged inputs agree

- **WHEN** the sweep is run twice against identical corpus, query set and grid
- **THEN** every reported value SHALL be identical apart from latency

#### Scenario: The weighting behind a level is readable from the grid

- **WHEN** the sweep output is read for any one query
- **THEN** it SHALL contain the document total and the per-term document frequencies that produced that query's leading level, so the level can be recomputed by hand from the committed corpus

#### Scenario: A level-function change is measured against the same fixtures

- **GIVEN** a change that alters how the relevance level is computed
- **WHEN** its sweep is reviewed
- **THEN** it SHALL have been produced against the same corpus and query set as the grid it cites as its before, and a change that alters both the fixtures and the level function SHALL be rejected

### Requirement: The harness MUST be able to FAIL on over-widening, and the proof is a mutation that reddens it

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
