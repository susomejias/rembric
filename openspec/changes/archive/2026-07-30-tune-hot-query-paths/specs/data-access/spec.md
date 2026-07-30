## ADDED Requirements

### Requirement: Hot query paths MUST retain the index and query shapes their measured basis rests on

Every figure below was captured on one machine against a corpus rebuilt by
`pnpm run corpus:build -- --db <dir> --memories 50000 --sessions 50000 --relations 43000 --prompts 50000 --seed 1`.
They establish the **relative ordering of alternatives and the shape of the
growth**, which is what the decisions rest on — not absolute latency on any
host. A reader on other hardware SHALL expect different absolute numbers and the
same ordering; a change that reverses an ordering is the signal to re-open the
decision.

`EXPLAIN QUERY PLAN` is the primary detector, not wall-clock. A `SCAN` is
invisible at the few hundred rows a real installation holds today and fatal at
50k, so several requirements below govern queries that measure acceptably at
present size and whose plan shows unbounded growth.

#### Requirement scope

This governs the query shapes named here. It does not freeze the schema: an
index may be replaced by one that strictly contains it, and a query may be
rewritten, provided the plan claim below still holds and the result set is
proven unchanged.

**`searchMemoryIds`' explicit-`status` caller SHALL be served without a sort**, by
`memory(scope, project_id, status, created_at)` — measured **0.010 ms**.

Its **default caller is knowingly left unserved**, and that is recorded here so it
is not read as an oversight. The default predicate is `status != 'archived'`, a
**range**, and a range on the third column leaves `created_at` unsorted, so the
four-column index cannot serve it end to end: measured **3.09 ms** with
`USE TEMP B-TREE FOR ORDER BY`. A partial index
`memory(scope, project_id, created_at) WHERE status != 'archived'` does serve it
(**0.048 ms**) and was implemented, measured and then **withdrawn**: it shares the
`(scope, project_id)` prefix with `memory_scope_seen_idx`, and at the row counts a
real installation actually holds the planner prefers the partial index and sorts —
displacing the no-sort plan that the recency-index requirement publishes for
`recentForContext`. At 50 000 memories the planner chooses correctly and no
displacement occurs, so the conflict exists precisely at production scale today
and disappears at the scale the figures were taken.

Resolving it means choosing between two per-turn readers, or finding an index that
serves both orderings, and that is a decision this change does not own. Carried as
`serve-unarchived-scope-scan-without-displacing-recency`.

**`entities.linkMemory`'s get-or-create SHALL use a row-value predicate, not an
OR chain.** `(kind, value) IN (VALUES …)` plans as an unconditional four-column
seek. The OR chain's plan is **statistics-dependent**: with `sqlite_stat1`
present it is a `MULTI-INDEX OR` at 0.015 ms, and with statistics absent — the
state a database sits in after any hard kill, and the state any bulk writer
reaches mid-run — it degrades to a `(scope, project_id)` prefix scan whose cost
is linear in the scope's entity count. Measured with statistics deleted:
**21.6 ms versus 0.017 ms**, a factor of 1272. The requirement is about removing
the stats-dependence on the save path, not the best case, which is a wash.

**`findActiveForTransport` SHALL NOT order its candidate rows.** It returns the
sole match or nothing, so with `LIMIT 2` no ordering can change its result. An
`ORDER BY started_at` cost a temp B-tree that the filtering index — ordered by
`COALESCE(last_activity_at, started_at)`, a different expression — could not
supply, and for the `project_id IS NULL` shape the planner abandoned the index
entirely in favour of one that supplied the order for free. Measured
1.93 ms → **0.096 ms**. This runs on **every MCP call**.

**Counts SHALL NOT be computed by an anti-join or a redundant aggregate where an
arithmetic difference or a plain `count(*)` is exact.** Each rewrite below was
verified to return an identical result on the 50k corpus:

| read | before | after | |
| --- | --- | --- | --- |
| `entities` scan backlog | 7.48 ms | 0.014 ms | 551× |
| `adminCountEntities({})` | 177.9 ms | 0.183 ms | 972× |
| `adminCountEntities({kind})` | 137.4 ms | 25.7 ms | 5.4× |
| `relations.adminCountWithFilters({})` | 25.4 ms | 0.004 ms | 6964× |
| `relations.adminCountWithFilters({status})` | 20.8 ms | 0.420 ms | 49.6× |
| `memory.adminCountBySession(page)` | 6.35 ms | 0.007 ms | 906× |
| `prompts` session-prefix range vs `LIKE` | 6.30 ms | 0.002 ms | 2906× |

**The embedding backlog is the exception and SHALL NOT use the arithmetic form.**
The same rewrite measured 14.6× there and is unsafe: `memory_vec` has no
`AFTER DELETE` trigger, so a deleted memory leaves its vector behind and the
difference goes negative — observed on a real dev database at 35 memories against
4747 vec rows. The arithmetic MAY be used as a **gate** in which only an exact 0
short-circuits, with every other value falling through to the anti-join, and the
reported count SHALL come from the anti-join.

Each rests on a stated schema fact, and each SHALL be re-verified if that fact
changes: the entity scan backlog on `memory_entity_scan.memory_id` being a primary
key with no orphan rows and no filter the arithmetic omits; the entity count on
grouping a left join by the left table's primary key yielding one row per entity; the relation count on both endpoints being NOT NULL foreign keys
onto a primary key; the prefix range on `session_id` collating BINARY, which is
why SQLite's `LIKE` optimisation cannot apply.

**A per-page decoration SHALL be computed for the page, not for the table.**
`adminCountBySession` (both the `memory` and `prompts` twins) grouped the whole
table to label 25 visible rows, at the same cost on page 1 and page 400. The
page's ids are passed instead, through `json_each` rather than one placeholder
per id.

**An unpaginated total SHALL NOT re-run an identical FTS scan when the page
already proves it.** `prompts.searchByScope` and the dashboard memories search
each ran the same `MATCH` twice — once for the page, once for `COUNT(*)`. Both
now over-fetch one row: at offset 0, a page that is not full **is** the total, so
the second scan is skipped, and the exact total is preserved in every case.

#### Rejected alternatives, recorded so they are not re-proposed

- **A `GROUP BY status, type` rewrite for `countByStatusAndTypeInScope`.** Does not help — still a temp B-tree. An index on `(scope, project_id, type)` does: 2.71 ms → 0.667 ms.
- **Ordering the entity fan-out by the link table's primary key.** Measured 1.46 ms → **0.014 ms** with an identical result set on a ULID corpus, and **rejected**: it is equivalent only while every `memory.id` is a ULID whose timestamp prefix equals its `created_at`. That holds for every row the application writes but is not enforced, and the existing repository fixture — which inserts synthetic ids — orders differently under it. Adopting it would turn a documented chronological guarantee into "chronological as long as ids are ULIDs", which is a contract change and not a tuning change. Carried as `order-entity-fanout-by-link-pk`; its prerequisite invariant is now pinned by a test.
- **A denormalised counter for `scopeActiveMemoryCount`.** Re-measured at **0.184 ms** per save, not the 1.09 ms this change's own audit reported. A drifting counter is worse than a sub-millisecond count, on the same grounds that deferred `memory_entities.link_count`.
- **An expression index for `abandonInactiveSince`.** It shares `findActiveForTransport`'s `COALESCE` expression but not its `token_id`/`project_id` equality prefix, so the partial index added for that method does not serve it. Measured effect on the sweep's candidate scan: none (1.56 ms → 1.76 ms, inside noise). Not added.

#### Scenario: An index is added for the unarchived scope scan

- **WHEN** a change adds an index to serve `searchMemoryIds`' default `status != 'archived'` caller
- **THEN** it SHALL capture `recentForContext`'s plan **at the row counts a real installation holds**, not only at 50k, because that is where the displacement occurs
- **AND** a plan that moves `recentForContext` off `memory_scope_seen_idx` onto a sort SHALL block the addition until the two readers are reconciled

#### Scenario: A contributor simplifies the row-value predicate back to an OR chain

- **WHEN** `linkMemory`'s `(kind, value) IN (VALUES …)` is rewritten as an OR chain of AND pairs
- **THEN** the change SHALL be rejected
- **AND** the reason SHALL be the statistics-dependence, verified with `sqlite_stat1` both present and deleted, not the best-case timing — which is a wash

#### Scenario: An ORDER BY is restored to `findActiveForTransport`

- **WHEN** an ordering clause is added back to the candidate query
- **THEN** it SHALL be rejected unless the ordering is observable in the returned value
- **AND** the reviewer SHALL note that `LIMIT 2` plus "sole match or nothing" makes it unobservable by construction

#### Scenario: A count is rewritten as an arithmetic difference

- **WHEN** a change replaces an anti-join count with a difference of two table counts
- **THEN** it SHALL establish that the subtracted table cannot hold a row whose counterpart is gone, by naming the trigger or constraint that guarantees it
- **AND** where no such guarantee exists the difference SHALL be used only as a gate on an exact zero, never as the reported number, because a negative difference reads as "nothing pending" while rows are pending

#### Scenario: A count rewrite's supporting schema fact changes

- **WHEN** a migration removes a primary key, adds a filter to the reader an arithmetic count mirrors, or makes a joined foreign key nullable
- **THEN** the count that rested on that fact SHALL be re-verified against the anti-join form it replaced
- **AND** a divergence SHALL be treated as a correctness defect, because these counts feed operator dashboards and a `memory.doctor` threshold

#### Scenario: A figure here is read as a performance guarantee

- **WHEN** a reader treats a number in this requirement as the latency to expect on their host
- **THEN** the reading is wrong: the figures are one machine's, and they are recorded to establish which of two alternatives is faster and how each grows
- **AND** the corpus invocation beside them is what makes a re-measurement on other hardware possible

### Requirement: The dense retrieval branch has a measured latency floor that MUST be recorded, not rediscovered

The dense branch's floor SHALL be treated as a recorded property of the retrieval
path, not as an open defect: `knnByQueryVector` costs approximately **42 ms at
50 000 memories** and there is no index fix. sqlite-vec brute-forces the partition; scope, status and type
**are** already pushed into the vec0 index before distance is computed, and `k`
is not the lever — measured k=64 at 34.6 ms against k=400 at 40.5 ms. Cost is
linear in partition size: 14.8k → 37k vectors is 2.5× the rows and 2.56× the
time.

This is the per-turn latency floor for `memory.search`'s dense branch. It is
written down so it is not re-reported as a defect by the next audit. Lowering it
means partitioning differently or adopting another vector index, which is a
larger change than tuning.

#### Scenario: A later audit reports the dense branch as slow

- **WHEN** an audit measures `knnByQueryVector` at tens of milliseconds and proposes an index
- **THEN** the finding SHALL be closed against this requirement rather than treated as new
- **AND** reopening it SHALL require a proposal that changes the partitioning or the vector index, since the filters are already inside vec0 and `k` has been measured not to be the lever
