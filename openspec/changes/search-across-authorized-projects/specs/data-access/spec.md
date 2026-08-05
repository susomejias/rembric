## MODIFIED Requirements

### Requirement: The dense retrieval branch has a measured latency floor that MUST be recorded, not rediscovered

The dense branch's floor SHALL be treated as a recorded property of the retrieval
path, not as an open defect: `knnByQueryVector` costs approximately **42 ms at
50 000 memories** and there is no index fix. sqlite-vec brute-forces the partition; scope, status and type
**are** already pushed into the vec0 index before distance is computed, and `k`
is not the lever — measured k=64 at 34.6 ms against k=400 at 40.5 ms. Cost is
linear in partition size: 14.8k → 37k vectors is 2.5× the rows and 2.56× the
time.

**The same law governs a search that names several partitions, and the floor is therefore a function of the union rather than of one partition.** Naming a set of partition keys rather than one SHALL be understood to cost approximately the sum of the named partitions' costs — measured over 8 equal partitions holding 50 000 vectors in total, ratios of 1.00 / ≈2.03 / ≈4.05 / ≈8.09 for one, two, four and all eight partitions, reproduced across four independent runs with under 8% spread on every arm. So widening a read to N projects costs what a single project of the combined size costs, and the shard-scan property the `k = ?` form exists to preserve survives the set form. A widened read is therefore a per-turn cost the CALLER chose, and it SHALL NOT be reported as a regression of the narrow path, whose figures are unchanged.

**Omitting the partition predicate to search everything is dominated and SHALL NOT be used.** Measured over the identical 50 000-vector corpus, the predicate-free form is never faster than the eight-partition set form while returning one eighth as many rows (64 against 512), and in half the measured runs it was ≈1.4× slower. The set form SHALL always name its partitions. **That arm is bimodal across runs where every other arm is tight, so any future claim about its cost SHALL rest on repeated runs**: a single run of it supported a stronger claim than three repeats would bear.

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
- **AND** a proposal to remove the partition predicate in order to speed it up SHALL be refused against the measurement that the predicate-free form is slower over the same rows

#### Scenario: A cost claim about the two forms names its instrument

- **WHEN** any change compares the single-partition and multi-partition kNN forms
- **THEN** it SHALL state whether the figures are isolated statement timings or end-to-end search latencies, and SHALL NOT present the two in one table
