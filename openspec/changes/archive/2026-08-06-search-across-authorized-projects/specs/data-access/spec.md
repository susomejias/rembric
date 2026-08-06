## MODIFIED Requirements

### Requirement: The dense retrieval branch has a measured latency floor that MUST be recorded, not rediscovered

The dense branch's floor SHALL be treated as a recorded property of the retrieval
path, not as an open defect: `knnByQueryVector` costs approximately **42 ms at
50 000 memories** and there is no index fix. sqlite-vec brute-forces the partition; scope, status and type
**are** already pushed into the vec0 index before distance is computed, and `k`
is not the lever — measured k=64 at 34.6 ms against k=400 at 40.5 ms. Cost is
linear in partition size: 14.8k → 37k vectors is 2.5× the rows and 2.56× the
time.

**The same law governs a search that names several partitions, and the floor is therefore a function of the union rather than of one partition.** Naming a set of partition keys rather than one SHALL be understood to cost approximately the sum of the named partitions' costs. **Measured as an ISOLATED STATEMENT** over 8 equal partitions holding 50 000 vectors in total: ratios of 1.00 / ≈2.07 / ≈3.88 / ≈8.26 for one, two, four and all eight partitions, five independent runs with a per-arm spread of 7–11%. The one cell that had departed from that law — 20 000 vectors over all eight partitions, read at 12.8× from a SINGLE run — did not reproduce and reads 8.13×, so the linearity is stronger than first recorded rather than weaker. The shard-scan property the `k = ?` form exists to preserve survives the set form, and a widened read is a per-turn cost the CALLER chose rather than a regression of the narrow path, whose figures are unchanged.

**The END-TO-END cost is much smaller than that ratio, and it is the figure any user-facing claim SHALL quote.** Measured through the search entry point on the SHIPPED path, on a realistically skewed corpus — one project holding 60% of it, the thinnest 2% — widening to every authorized project costs **2.2–3.0×** from the dominant project at 50 000 / 20 000 / 1 000 memories, and **4.1–5.1×** from the thinnest at 50 000 / 20 000, rising to **12.0×** at 1 000 where the narrow arm is 1.70 ms against the widened arm's 20.37 ms. The ratio FALLS as the corpus grows, because the widened pool is bounded by `window × N` while the narrow arm's fixed costs grow with the corpus; it is a bounded multiple, not a growing one. The gap between this and the statement ratio is not noise: only the dense and lexical reads scale with the widened set, while the query embedding, fusion, term statistics, relevance gate, ranking boost and row hydration do not. **The two SHALL NOT be presented in one table**, and a statement ratio SHALL NOT be quoted as what a caller waits for.

**The figures this requirement first carried — 1.32–1.35× and 2.39–2.55× — are RETRACTED, and the retraction is kept because it is the lesson.** They were taken against a prototype overlay that bounded the widened union with a single `LIMIT`, so it priced a candidate pool that does not grow with the set — the very defect the shipped implementation had to fix. An overlay that reproduces a page's ids is not thereby a valid instrument for its cost: it matched the narrow read's returned ids on every compared page and was still measuring the wrong thing, because the ids a page returns and the pool it was drawn from are different quantities. **An end-to-end cost SHALL therefore be measured on the shipped path rather than on a prototype**, and a figure inherited from one SHALL be re-measured before it is published.

**Omitting the partition predicate to search everything SHALL NOT be used, and the reason is authorization rather than cost.** A kNN carrying no partition predicate carries no scope bound at all — it reads every partition in the index — so it cannot restrict a read to the set of projects a token was authorized for, which is the shape of GHSA-cc4j-ch4r-9pf5 and is not redeemable by any measurement. It also returns strictly fewer candidates over the same corpus, because `k` then applies globally rather than per named partition: 64 rows against the eight-partition set form's 512. **The cost claim previously recorded here was wrong, and the correction is kept rather than dropped because it is the lesson.** A single run read the predicate-free form as ≈1.4× slower and bimodal where every other arm was tight; repeated, the bimodality did not reproduce and the form measured **2–8% faster** than the eight-partition set form at every magnitude. A rejection resting on cost would have been reversed by that re-measurement; the authorization argument stands whatever the clock says. **Any claim about this arm's cost SHALL rest on repeated runs**, since a single run of it supported a stronger claim than three repeats would bear — in both directions.

**The one-partition set form is the shape every EXISTING search takes wherever the repository carries a single query shape, so its cost is a fact about all of today's traffic rather than about the new feature.** Measured as an isolated statement, every scoped read is faster or equal in the set form — the dense read slower in 2 of 108 comparisons at a median ratio of 0.895×, the id-hydration read between 0.51× and 0.76×, the lexical read at parity where it costs anything — and end to end the difference sits inside the instrument's own resolution. A set of one and the equality form need not therefore be carried as two query shapes; a later change that adopts a second shape for the one-project case SHALL justify it against a measurement rather than against a plan.

**`EXPLAIN QUERY PLAN` does not discriminate between these forms** — both emit the same opaque vec0 virtual-table index string plus a temp B-tree for the ordering — so any claim about their relative cost SHALL rest on wall-clock, and a later audit SHALL NOT read the identical plans as evidence that the forms are equivalent.

This is the per-turn latency floor for `memory.search`'s dense branch. It is
written down so it is not re-reported as a defect by the next audit. Lowering it
means partitioning differently or adopting another vector index, which is a
larger change than tuning.

#### Scenario: A later audit reports the dense branch as slow

- **WHEN** an audit measures `knnByQueryVector` at tens of milliseconds and proposes an index
- **THEN** the finding SHALL be closed against this requirement rather than treated as new
- **AND** reopening it SHALL require a proposal that changes the partitioning or the vector index, since the filters are already inside vec0 and `k` has been measured not to be the lever

#### Scenario: A later audit reports a widened search as slow

- **WHEN** an audit measures a search naming N partitions at roughly N times the single-partition cost
- **THEN** the finding SHALL be closed against this requirement, because that ratio is the recorded law rather than a defect
- **AND** the audit SHALL state which instrument produced the ratio, since the end-to-end ratio is smaller than N and the two are not comparable
- **AND** a proposal to remove the partition predicate in order to speed it up SHALL be refused because that form carries no scope bound, and the refusal SHALL hold even where it is measured faster — which it has been

#### Scenario: A cost claim about the two forms names its instrument

- **WHEN** any change compares the single-partition and multi-partition kNN forms
- **THEN** it SHALL state whether the figures are isolated statement timings or end-to-end search latencies, and SHALL NOT present the two in one table
- **AND** where the claim is about what a caller waits for, the end-to-end figure SHALL be the one quoted

#### Scenario: The one-partition set form is not a regression of the narrow path

- **WHEN** a non-widened search is served through the set form with a single member
- **THEN** its end-to-end cost SHALL be within the tolerance the change committed BEFORE reading any after-number, so carrying one query shape rather than two is not a regression
- **AND** the comparison SHALL be paired and interleaved against the pre-change code rather than run separately, because an unpaired run of this instrument has been measured reading +12.1% where the paired run of the same change reads −1.2%
