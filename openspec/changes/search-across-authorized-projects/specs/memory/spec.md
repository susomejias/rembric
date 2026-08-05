## ADDED Requirements

### Requirement: `Scope` MUST be a single closed arm, and a widened read MUST be a distinct type a write cannot hold

`Scope` SHALL have exactly one arm, naming exactly one project. The global arm, the `SCOPE_GLOBAL` constant, the global branches of `memoryMatchesScope`, `scopeWhere` and `scopeCondition`, the `GLOBAL_PARTITION_KEY` sentinel and `partitionKeyFor`'s sentinel branch SHALL be deleted, along with the global arms of the repository option bags that mirror them. `partitionKeyFor` SHALL become the owning memory's `project_id` with no fallback, which is what "with no sentinel value and no unpartitioned rows" already requires of the stored column.

A read whose result set spans several projects SHALL be expressed as a **distinct type**, not as a field on `Scope` and not as a value travelling beside it. `Scope` SHALL remain the parameter of every write and of every read that is not `memory.search`; the widened type SHALL be accepted only by the search path. Passing a widened scope to a write SHALL therefore be a compile error rather than a runtime refusal.

The widened type SHALL carry the project ids it spans and the home project the connection resolved to, and every id it carries SHALL have been individually authorized for `read` before the value was constructed. It SHALL be constructed at exactly one site, and that confinement SHALL be enforced by a CI grep gate whose assertion carries its own non-vacuity control, so an empty match set cannot satisfy it.

This does not remove the `memory.scope` column, the scope-bearing indexes, or the nullability of `sessions.project_id` / `prompts.project_id`. Those remain governed by "Every memory MUST belong to exactly one project" and are a separate change.

#### Scenario: A write cannot be handed a widened scope

- **GIVEN** a widened scope value spanning two projects
- **WHEN** it is passed to any memory write path
- **THEN** the code SHALL fail to compile, and no runtime refusal SHALL be relied upon to produce that outcome

#### Scenario: The widening has exactly one construction site

- **WHEN** the CI invariant test greps the production tree for the widened scope's discriminant
- **THEN** it SHALL find exactly one production file constructing it
- **AND** the test SHALL assert the match set is non-empty, so a renamed discriminant fails loudly rather than passing vacuously

#### Scenario: The global arm is gone from the type and from every branch that read it

- **WHEN** the tree is compiled and the invariant suite runs
- **THEN** no production or test file SHALL construct a global scope, reference `SCOPE_GLOBAL` or `GLOBAL_PARTITION_KEY`, or branch on a scope discriminant other than the single project arm

#### Scenario: A one-project widened set is the narrow scope

- **GIVEN** a token authorized to read exactly one project
- **WHEN** a widened search is requested
- **THEN** the constructed value SHALL be the narrow `Scope`, and the query issued SHALL be the same query a non-widened search issues

### Requirement: A widened search MUST rank by relevance over one globally-ordered list per branch

Where a search spans several projects, each retrieval branch SHALL produce **one list ordered globally across the whole widened set** before fusion, never one list per project fused together. The dense branch SHALL name the partitions in a single kNN whose results are ordered by distance across all of them; the lexical branch SHALL apply a multi-project predicate and stay in one relevance order. Fusing per-project lists is forbidden because Reciprocal Rank Fusion orders by rank position, so each project would contribute its own rank-1 row and a project holding three memories would be weighted like the best home match.

The project a row belongs to SHALL NOT influence its score. No home-project boost, multiplier or tier SHALL be applied. Where two rows carry an equal fused score, a row from the home project SHALL sort first; that tiebreak SHALL NOT be able to move a row above another row with a strictly better score.

**The candidate window SHALL NOT be divided by the size of the widened set.** Each branch SHALL draw the same candidate window it draws for a narrow search, so the pool grows with the set rather than being rationed across it. Dividing it hands every project an identical quota regardless of its size or its distance from the query, which makes the home project's share of the pool a function of how many projects the token happens to reach rather than of the corpus — the same defect as fusing per-project lists, arriving by arithmetic instead of by fusion. The measured price of not dividing is a single-digit percentage of end-to-end latency, falling as the corpus grows, and it is accepted.

Term statistics SHALL remain corpus-wide and SHALL NOT be recomputed per widened set, per "The relevance level's term statistics MUST come from the search index". A widened query therefore applies the identical IDF weighting a narrow query applies, and widening SHALL NOT be treated as an occasion to re-derive any relevance constant.

The dense branch SHALL name its partitions rather than omitting the partition predicate. A predicate-free kNN carries no scope bound at all, so it cannot restrict a widened read to the authorized set; it is refused on that ground and not on cost, and the refusal SHALL hold whether it measures slower or faster than the set form — it has measured both. It also returns strictly fewer candidates over the same corpus, because `k` then applies globally instead of per named partition.

#### Scenario: A foreign row outranks a home row when it is more relevant

- **GIVEN** a widened search over the home project and one other project, where the other project holds the strictly better match
- **WHEN** the search runs with the default limit
- **THEN** the better match SHALL appear above every home-project row it outscores

#### Scenario: A small project does not get a free top slot

- **GIVEN** a widened search over a large home project and a project holding three weakly-matching memories
- **WHEN** the search runs
- **THEN** no row from the small project SHALL be ranked above a home row with a strictly better fused score

#### Scenario: A small project does not get a fixed share of the candidate pool

- **GIVEN** a widened search over a large home project and a project holding fewer memories than the candidate window
- **WHEN** the candidates handed to fusion are counted per project
- **THEN** the small project SHALL contribute only the candidates it has, and the home project SHALL contribute a full window
- **AND** adding a further authorized project to the set SHALL NOT reduce what the home project contributes

#### Scenario: The home tiebreak applies only on an exact tie

- **GIVEN** two rows with equal fused scores, one in the home project and one in another
- **WHEN** the page is ordered
- **THEN** the home-project row SHALL precede the other
- **AND** where the scores are not equal, the ordering SHALL be by score alone

#### Scenario: Widening does not change term weights

- **GIVEN** a query issued narrowly and then widened over the same corpus
- **WHEN** the relevance level of a row present in both result sets is computed
- **THEN** its term weights SHALL be identical, because the document-frequency denominator is corpus-wide in both cases

## MODIFIED Requirements

### Requirement: Memory search MUST respect scope isolation

`memory.search` SHALL return only memories the connection is authorized to read. By default that is exactly one project — the scope the connection resolved to — and no argument SHALL admit a row from any other project.

`memory.search` MAY additionally accept one explicit, opt-in argument that widens the read to the set of projects the connection's **token is authorized to read**, and to no others. When that argument is absent the behaviour SHALL be identical to a server that does not implement it. When it is present, the widened set SHALL be computed by evaluating the same read-authorization predicate that filters the project listing, once per candidate project, and SHALL exclude archived projects. The set SHALL always contain the connection's resolved project.

Where the resolved project is not itself in that set — the reachable case is a connection pinned to a project that was archived afterwards, since only a path-scoped connection is refused at authentication for that — the widening SHALL be dropped and the resolved-scope result served unchanged, which is what the `auth` capability already requires of a widening that cannot be authorized. A widened set SHALL never be empty and SHALL never omit the home project; both properties SHALL be pinned by test rather than left to the constructor, because an empty membership list yields an empty result set rather than an error.

Under no circumstances SHALL a result set contain a row from a project the token was not authorized to read, whatever argument requested it. No other read tool SHALL accept such an argument, and no default, filter or configuration SHALL widen a read that did not explicitly ask to be widened.

#### Scenario: Searching within a project returns only that project plus globals when requested

The title predates this change twice over: there are no globals, and the widening that now exists is opt-in, so the unwidened behaviour this scenario pins is unchanged.

- **WHEN** `memory.search` is called without the widening argument in a connection resolved to project A
- **THEN** the response SHALL include memories with `project_id = 'A'` only, and no other argument SHALL admit another project's row

#### Scenario: Searching globals never returns project memories

The title predates this change: the global scope it names does not exist, and the only expressible widening names no project at all — it names the token's own read reach.

- **WHEN** a caller attempts to direct `memory.search` at a named scope other than the connection's resolved project
- **THEN** no such request SHALL be expressible: `memory.search` accepts no scope argument and no project argument, and scope resolution yields a project on every branch or refuses the call
- **AND** the cross-project argument SHALL NOT be a way to name a project: it selects the token's authorized set and admits no caller-supplied project id or slug

#### Scenario: A widened search returns only authorized projects

- **GIVEN** projects A, B and C, and a token authorized to read A and B but not C
- **WHEN** `memory.search` is called with the widening argument on a connection resolved to A, against a query every project can match
- **THEN** the response MAY contain rows from A and B
- **AND** it SHALL contain no row whose `project_id` is C
- **AND** at least one row from A and at least one row from B SHALL be returned, so the assertion is not satisfied by an empty result set

#### Scenario: The widened set always contains the home project

- **GIVEN** any connection whose scope resolved successfully
- **WHEN** a widened search is requested
- **THEN** the resolved project SHALL be among the projects searched, and the widened set SHALL never be empty

#### Scenario: An archived project is not admitted by widening

- **GIVEN** a token authorized to read projects A and B, where B is archived
- **WHEN** a widened search runs on a connection resolved to A
- **THEN** no row whose `project_id` is B SHALL be returned, and B SHALL NOT be named among the projects searched

#### Scenario: An archived home project drops the widening rather than the search

- **GIVEN** a connection resolved to project A by an explicit switch, A archived afterwards, and a token authorized to read live projects B and C
- **WHEN** a widened search is requested
- **THEN** the call SHALL succeed and return exactly what the same call without the argument returns
- **AND** no row from B or C SHALL be returned, and neither SHALL be named among the projects searched
- **AND** a control call from a live home over the same corpus SHALL widen, so the fallback is attributable to the archived home rather than to an empty reach

#### Scenario: No other read tool widens

- **WHEN** `memory.context`, `memory.get`, `memory.timeline`, `memory.stats` or the HTTP search endpoint is called with any argument
- **THEN** each SHALL return only rows from the connection's resolved project, and none SHALL accept a widening argument

### Requirement: The vector index MUST mirror the memory lifecycle and support scoped kNN over an arbitrary query vector

`memory_vec` is a derived index, not primary data: an embedding is a deterministic function of `memory.content` (which append-only preserves) and is recomputable at any time. The index therefore is NOT bound by the append-only invariant of the `memory` table; it MAY be updated to track the memory lifecycle, mirroring the existing `memory_fts` trigger-driven sync. `memory_vec` SHALL carry a scope-derived partition key — the owning memory's `project_id`, with no sentinel value and no unpartitioned rows — plus a `status` and a `type`. The partition key, `status`, and `type` SHALL be supplied when the embedding row is inserted (not by a trigger on the vector table, which the engine forbids); `status` SHALL thereafter be kept in sync with the owning memory's `status` by a trigger on the base `memory` table. The repository SHALL expose a scoped kNN query over an arbitrary query vector that filters by partition key plus requested `status` and optional `type`, so that a scoped search scans only its own partition and its own structured slice. Vectors SHALL be retained across `status` transitions so that `superseded` history remains semantically recoverable when explicitly requested. `archived` rows MAY still have retained vectors while present, but because the post-model-change backfill intentionally targets non-archived rows, archived rows are outside the semantic-search guarantee and SHALL be treated as lexical-only for correctness. Vectors SHALL be physically removed only when the owning memory row is physically purged through an existing journaled escape hatch.

**A partition key SHALL NOT be changed by `UPDATE`.** The vector engine rejects `UPDATE memory_vec SET partition_key = …` outright, so any migration or maintenance path that must move a row between partitions SHALL DELETE the row and re-INSERT it carrying the identical embedding blob. The re-inserted blob SHALL be byte-identical to the original; re-embedding is NOT an acceptable substitute, because it makes the operation's correctness depend on a background worker completing after the transaction commits.

**A wrongly-partitioned row is undetectable by the existing repair path, so it SHALL be pinned by test rather than left to a health check.** `findMissingEmbeddings` is an anti-join that detects the ABSENCE of a `memory_vec` row, not a wrong partition key: a stale-partition row is present, so it is never queued for re-embedding, the doctor's embeddings backlog reads zero, the dense branch filters it out forever, and the lexical branch keeps returning the memory — so search returns results and nothing anywhere reports a fault. Any change that moves rows between partitions SHALL assert both that the retiring partition is empty AND that the destination partition is non-empty, and SHALL exercise recall end-to-end through the search entry point rather than through the kNN repository method.

**The kNN SHALL be able to name several partitions in ONE query, and SHALL never omit the partition predicate.** The repository SHALL expose a kNN that filters on membership in a set of partition keys, retaining the `k = ?` form and the `status`/`type` filters unchanged, and SHALL order the result by distance so that rank position is a fact about the whole named set rather than about any one partition. A set of one SHALL be equivalent to the single-partition form, in the rows returned and at the recorded latency tolerance, so the two need not be carried as separate query shapes. An empty set SHALL be unreachable by construction, because the caller's own partition is always a member; that property SHALL be asserted, since an empty membership list yields an empty result set rather than an error and would fail silently. The partition predicate SHALL NOT be dropped as a way to search every partition: a kNN without it carries no scope bound, so it cannot restrict a read to the authorized set, and that refusal does not depend on its cost — it has been measured both slower and faster than the set form. It also returns strictly fewer rows over the same corpus, because `k` then applies globally rather than per named partition.

#### Scenario: Scoped kNN returns only in-scope active neighbors

- **WHEN** the search vector branch runs a kNN for a query vector in `scope = 'project'`, `project_id = 'A'`
- **THEN** it SHALL return only memories with that partition key and `status = 'active'`, and SHALL NOT return memories from a different `project_id` or with a non-`active` status

#### Scenario: Scoped kNN can target superseded history explicitly

- **GIVEN** a `superseded` memory in scope whose vector has been retained and re-embedded with the current model
- **WHEN** the search vector branch runs a kNN with `status = 'superseded'`
- **THEN** that memory MAY be returned by the dense branch
- **AND** rows with `status = 'active'` or a different scope SHALL NOT leak into that result set unless they also match the requested filter

#### Scenario: Scoped kNN isolates by type when a type is requested

- **GIVEN** two `active` in-scope memories with different `type` values (e.g. one `preference`, one `decision`)
- **WHEN** the search vector branch runs a kNN with a requested `type`
- **THEN** it SHALL return only the memory whose `type` matches the request, and the other `type` SHALL NOT leak into the result set

#### Scenario: A superseded memory keeps its vector

- **GIVEN** an `active` memory M with an embedding
- **WHEN** M is superseded (its `status` flips to `superseded`)
- **THEN** the `memory_vec` row for M SHALL be retained with its `status` updated to `superseded` by the base-table trigger, so M remains semantically recoverable and is excluded from the default `active` search

#### Scenario: Partitioning shards across scopes but not within one

- **GIVEN** a corpus spread across many project scopes
- **WHEN** a scoped search runs a kNN
- **THEN** it SHALL scan only its own partition (cost proportional to in-partition rows, not total corpus); within a single large partition the kNN remains a brute-force scan whose latency grows with the in-partition row count

#### Scenario: A partition key cannot be updated in place

- **WHEN** a statement attempts `UPDATE memory_vec SET partition_key = ?`
- **THEN** the engine SHALL reject it, and the only conforming way to move the row SHALL be DELETE followed by re-INSERT of the identical blob

#### Scenario: Repointed vectors remain reachable by the dense branch

- **GIVEN** a migration that has moved every vector out of a retiring partition
- **WHEN** the retiring partition is counted and a semantic search is run in the destination scope through the search entry point
- **THEN** the retiring partition SHALL hold zero rows, the total `memory_vec` row count SHALL be greater than zero, and a repointed memory SHALL be returned by the dense branch alongside a control memory native to the destination scope

#### Scenario: A multi-partition kNN returns one distance-ordered list

- **GIVEN** vectors in partitions A and B, where B holds a neighbour strictly nearer than A's second-nearest
- **WHEN** a kNN names both partitions in one query
- **THEN** the result SHALL be ordered by distance across both, so B's neighbour appears between A's two rows rather than after all of them

#### Scenario: A one-partition set is the single-partition query

- **WHEN** the multi-partition kNN is called with a set containing exactly one partition key
- **THEN** it SHALL return exactly what the single-partition form returns for that key

#### Scenario: An empty partition set cannot be constructed

- **WHEN** the widened scope is constructed for any successfully resolved connection
- **THEN** it SHALL contain at least the resolved project's partition key
- **AND** a test SHALL assert this, because an empty membership list produces an empty result set rather than an error

### Requirement: Every memory MUST belong to exactly one project

Every memory row SHALL be attached to exactly one project. `project_id` SHALL reference an existing row in `projects` and SHALL NOT be null. There SHALL be no memory that belongs to no project, and no read SHALL return a memory belonging to a project the caller's token was not authorized to read.

This replaces "Memories MUST be scoped to either global or a project". The `memory.scope` column remains present in this release, written as the constant `'project'` on every insert, solely so a rolled-back previous image can still execute its own queries; it carries no information and no read SHALL branch on it. Its removal is a separate change.

#### Scenario: A memory cannot be saved without a project

- **WHEN** a memory insert is attempted with `project_id` null
- **THEN** the insert SHALL be rejected and no row SHALL be created

#### Scenario: A memory cannot be saved against a project that does not exist

- **WHEN** a memory insert is attempted with a `project_id` naming no row in `projects`
- **THEN** the insert SHALL be rejected and no row SHALL be created

#### Scenario: No read admits a second project's rows

The title predates this change: a read now admits a second project's rows only when the caller explicitly asked for it and the token was authorized for that project. What the title pins for every other case is unchanged.

- **GIVEN** two projects each holding memories, and a token authorized to read only one of them
- **WHEN** a read is performed in the scope of that one, with or without the widening argument
- **THEN** the result SHALL contain only that project's memories, and no request argument SHALL be able to change that

#### Scenario: No write admits a second project

- **GIVEN** two projects each holding memories
- **WHEN** any write-classified tool is called with any argument
- **THEN** the row SHALL be written to the connection's resolved project, and no argument SHALL name or reach another

#### Scenario: The retained scope column is constant

- **WHEN** any memory row is inserted by any runtime path after this change
- **THEN** its `scope` column SHALL hold `'project'`
- **AND** no repository read SHALL use the value of `scope` to select rows other than as a constant conjunct
