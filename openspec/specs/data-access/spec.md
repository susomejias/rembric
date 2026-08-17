# data-access Specification

## Purpose

Defines where SQL may execute, the repository API contract (scoped vs `admin*` vs `unsafe*` method families), transaction ownership, the relocated append-only purge allow-list, the query shapes hot reads must retain (with the measurement behind each), and the grep invariants that enforce all of it.

## Requirements

### Requirement: SQL execution confined to the db layer

All SQL execution — Drizzle query-builder calls, the drizzle-orm `sql` template tag, and raw better-sqlite3 statement APIs — SHALL occur only in files under `apps/server/src/db/` (repositories, `diagnostics.ts`, `migrate.ts`, `client.ts`, migrations). Files under `src/services/`, `src/dashboard/`, `src/server/`, `src/mcp/`, `src/consolidation/`, and `src/embeddings/` SHALL NOT execute SQL. Test files (`**/*.test.ts`) and `src/scripts/seed-dev.ts` are exempt.

#### Scenario: Invariant test rejects SQL outside the db layer

- **WHEN** the invariants suite (`apps/server/src/test/invariants.test.ts`) scans non-test source files outside `apps/server/src/db/` for SQL-execution patterns (Drizzle builder entry points, the drizzle-orm `sql` tag import, `db.all`/`db.get`/`db.run`, `db.query.`, `raw.prepare`)
- **THEN** the suite SHALL fail with a message naming the offending file when any match is found outside the exempt set

#### Scenario: Dashboard handlers render without a db dependency

- **WHEN** a dashboard page module under `apps/server/src/dashboard/` declares its `*Deps` interface
- **THEN** the interface SHALL NOT expose the Drizzle `Db` or raw better-sqlite3 handle; handlers consume repositories and services only

### Requirement: Repositories per aggregate own all SQL for their tables

The data layer SHALL provide one repository per aggregate at `apps/server/src/db/repositories/`: `memory` (owning `memory` and `memory_fts`), `relations` (`memory_relations`), `agent-sessions` (`sessions`), `prompts` (`prompts` and `prompts_fts`), `projects`, `tokens`, `consolidation` (`consolidation_ops`, `consolidation_runs`), `vectors` (`memory_vec`, including sqlite-vec kNN queries), and `dashboard-sessions` (`dashboard_sessions`, the cookie-auth table). Each repository SHALL be a class receiving the database handle via constructor injection, instantiated once during server bootstrap. Raw SQL inside repositories SHALL be limited to constructs the Drizzle builder cannot express: FTS5 `MATCH`, sqlite-vec functions, `json_each`, recursive common table expressions (`WITH RECURSIVE`), PRAGMA, and `VACUUM INTO`.

The `agent-sessions` aggregate owns exactly one table. It briefly owned a second, `session_summary_versions`, whose membership was justified by a write-ordering constraint — the version row was appended in the same transaction as the `UPDATE` it recorded. That table is retired by `persistence`, "The `session_summary_versions` table MUST be dropped by a dedicated migration, with `0033` retained on disk" — the requirement that imposed the write-ordering constraint is removed rather than relocated, so nothing here points at it — the constraint went with it, and the aggregate's repository SHALL NOT carry a summary-version method of any name.

#### Scenario: A query expressible in the builder uses the builder

- **WHEN** a repository implements a query consisting of standard relational operations (joins, grouped counts, filters, ordering, pagination)
- **THEN** it SHALL use the Drizzle query builder, not the `sql` template tag

#### Scenario: FTS5 search lives in its content table's repository

- **WHEN** any layer needs full-text search over memories or prompts
- **THEN** it SHALL call the corresponding repository method; the FTS5 `MATCH` statement exists only inside that repository

#### Scenario: The agent-sessions repository holds no summary-version SQL

- **WHEN** `db/repositories/agent-sessions-repository.ts` is inspected
- **THEN** it SHALL contain no statement referencing `session_summary_versions` or the `sessionSummaryVersions` schema symbol, in any of the scoped, `unsafe*` or `admin*` families
- **AND** no such statement SHALL exist anywhere else in the tree either — the SQL-confinement gate is unchanged, and the table is simply gone from every layer

### Requirement: Scoped, unsafe, and admin method families

Repository read methods consumed by scoped service paths SHALL require scope context as explicit parameters and SHALL NOT default to unfiltered reads. Deliberately cross-scope repository methods consumed by services and operational code (consolidation engine, scope-check-then-use patterns) SHALL carry the `unsafe` prefix, mirroring the `MemoryService.unsafe*` convention. Unscoped reads SHALL carry the `admin` name prefix and SHALL be invoked only from an allow-listed call site. Services remain the sole resolvers of effective scope (`resolveEffectiveProject` / `scopeFromContext`); repositories enforce the filter they are given.

`admin` names what the read does to SCOPE — it does not filter — and not who consumes it. The definition is therefore "an unscoped repository read, invocable only from allow-listed call sites"; that the allow-list is predominantly the dashboard is an observation about who is on it, not what the prefix means. The distinction is load-bearing because the enforcing gate only ever checked confinement of a NAME to a set of call sites, never the tie between the name and the unscoped property, and describing the family by audience made an unscoped read on a non-dashboard path look like a different category needing a different prefix. It is not: one prefix, one meaning, and the argument for each call site is made per call site.

An `admin*` read SHALL be read-only with respect to the durable database. A write is admitted only when it is confined to a contentless table in the connection's temporary schema, so that neither the durable file nor its write-ahead log records it; the read stays read-only in the only sense the invariant is about.

There is no third, unprefixed category. An aggregate-count method is NOT exempt from the prefixes: the grep gate matches call sites by method-name prefix, so an unscoped read carrying neither prefix is invisible to it and can be served from an agent-facing path while the invariant test passes — which is exactly how an unscoped session count reached `memory.stats`. Every unscoped repository read SHALL therefore carry `admin`, whatever it returns.

Because that rule is a naming convention, and a naming convention cannot detect its own violations, the invariants suite SHALL additionally maintain a CLOSED inventory of the repository reads that are unscoped, un-keyed and unprefixed, asserted by SET EQUALITY against what the repository sources declare: adding such a read without listing it SHALL fail, and removing a listed one without unlisting it SHALL fail. This mirrors the two-sided allow-list the physical-purge `DELETE` statements already carry. The inventory SHALL cover the repositories owning tables with a `(scope, project_id)` content dimension, SHALL classify every repository file as either covered or control-plane so that a new repository cannot be added unclassified, and SHALL mark any entry that is also a violation of the `admin`-prefix rule above, so the inventory is not read as a blessing. The rule SHALL NOT instead be an absence-side pattern match over query text: `GROUP BY project_id` and `WHERE project_id = ?` are indistinguishable to a pattern, and the one measured attempt had a false negative on precisely the per-project count the inventory exists to record.

Four `admin*` call sites legitimately sit outside `src/dashboard/`, and each is named here rather than left to a general exemption. The gate SHALL admit them as `(file, method)` PAIRS, not as whole files: a file-level licence blesses every future `admin*` call in that file as well, which on the row-assembly path of retrieval is the most expensive place in the codebase to grant one.

- `src/server/dashboard-router.ts`, which renders the operator overview directly.
- The boot-time `memory.doctor` closure in `src/server/bootstrap.ts`. The doctor report is deliberately server-wide — `sessions.active`, the embedding and entity backlogs, the latest consolidation run and the review/pending queue depths are all unscoped by design, so that an operator debugging one project still sees the whole process's health. The closure is constructed once at boot and reads nothing per-request-scoped, so it does not leak cross-scope ROWS: every field it returns is a count or a timestamp. Reads reachable only from it SHALL still carry the `admin` prefix, so the gate sees them and the exemption is a listed call site rather than an unnamed naming gap. `vectors.adminBacklogCount()` and `consolidation.adminLatestRun()` were renamed under this rule, joining the sibling `entities.adminBacklogCount()` that already carried it.
- `src/services/agent-sessions.ts`, whose `adminCountByStatus()` is a service-layer pass-through to the repository read of the same name; its own callers are confined by the two entries above.
- `src/services/hybrid-search.ts`, which reads the relevance level's corpus-wide term statistics on every text query. This call site is AGENT-FACING, and it is admitted on the RETURN TYPES, never on the caller's audience. The `bootstrap.ts` argument above — constructed once at boot, reads nothing per-request-scoped — is FALSE here and SHALL NOT be reused: this is a per-request path. What holds instead is that the row-space of both reads is empty by construction. `adminDocumentCount()` returns one integer. `adminQueryTermFrequencies()` returns the caller's OWN query terms mapped to corpus-wide integers. Neither return type carries a memory id, content, or a `project_id`, so no change to a filter and no rename can turn either into a cross-scope row channel without changing the return type, which the compiler sees. The closest precedent is `MemoryRepository.unsafeAncestorIds` — unscoped, agent-facing, prefixed, and justified by an argument about the structure of the data rather than about who calls it. `adminQueryTermFrequencies()` is also the read-only carve-out above: it inserts the query text into a contentless FTS5 table in the `temp` schema in order to tokenise it through the index's own tokenizer.

#### Scenario: Invariant test pins admin call sites to the allow-list

- **WHEN** the invariants suite scans non-test source files outside the dashboard modules, the named call sites, and `apps/server/src/db/repositories/` for invocations of `admin`-prefixed repository methods
- **THEN** the suite SHALL fail, naming the offending file and the method, when any such call site is found

#### Scenario: An unscoped aggregate reachable from the doctor carries the prefix

- **WHEN** an unscoped repository read is reachable from the `memory.doctor` report
- **THEN** it SHALL carry the `admin` prefix, so it is inside the confinement gate rather than invisible to it

#### Scenario: Cross-scope semantics are preserved

- **WHEN** a service requests a memory through a repository with a scope that does not match the row's `(scope, project_id)`
- **THEN** the repository SHALL return no row and the service SHALL surface `not_found`, identical to pre-refactor behavior

#### Scenario: An agent-facing unscoped read is admitted on its return type

- **GIVEN** an unscoped repository read consumed from a per-request agent-facing path, whose return type is an aggregate carrying no row identity
- **WHEN** it is admitted to the allow-list
- **THEN** the admitting argument SHALL be that the return type has no row-space, and SHALL NOT be that the caller is operator-facing or constructed once at boot

#### Scenario: A listed file does not license a second admin method

- **GIVEN** a file already named in the `admin*` allow-list for one method
- **WHEN** a call to a DIFFERENT `admin*` method is added to that same file
- **THEN** the invariants suite SHALL fail naming the new method, because the licence is granted per `(file, method)` pair rather than per file

#### Scenario: A tokenising write to the temp schema keeps a read read-only

- **GIVEN** an `admin*` read that writes the query text to a contentless table in the connection's temporary schema in order to tokenise it
- **WHEN** the durable database file and its write-ahead log are inspected across many such reads
- **THEN** neither SHALL have grown, and the read SHALL still satisfy the read-only requirement

#### Scenario: An unscoped unprefixed read must be in the closed inventory

- **GIVEN** a repository owning a table with a `(scope, project_id)` content dimension
- **WHEN** a read method is added to it that takes no scope, no row key, and carries neither prefix
- **THEN** the invariants suite SHALL fail until the method is named in the inventory

#### Scenario: An inventory entry that no longer exists fails the suite

- **WHEN** an inventory entry is renamed, prefixed, or deleted in the repository source without being removed from the inventory
- **THEN** the invariants suite SHALL fail, so the inventory and the implementation move together

#### Scenario: A new repository cannot be added unclassified

- **WHEN** a repository file is added under `apps/server/src/db/repositories/` and is named in neither the covered nor the control-plane classification
- **THEN** the invariants suite SHALL fail, so a new aggregate cannot escape the inventory by not being scanned

### Requirement: Services own transaction boundaries

Transactions SHALL be opened only by services (and consolidation operations) via `db.transaction()`. Repositories SHALL NOT begin, commit, or roll back transactions. Repository methods called inside a service transaction callback participate in that transaction through the single shared better-sqlite3 connection.

#### Scenario: Atomic topic-key supersede spans repository calls

- **WHEN** `saveWithTopicKey` inserts a new memory row and supersedes the previously-active row in the same `(scope, project_id, topic_key)`
- **THEN** both writes SHALL execute inside one service-owned transaction and either both commit or both roll back

### Requirement: Purge escape hatches live in repositories with pinned allow-lists

The physical-purge statements (`DELETE FROM memory`, `DELETE FROM sessions`, `DELETE FROM prompts`) SHALL exist only inside their owning repositories (plus `src/scripts/seed-dev.ts`). The invariants suite SHALL allow-list exactly those files and SHALL assert positively that each allow-listed repository still contains its `DELETE` statement. Gating (admin bypass, journaling) remains in the calling service.

#### Scenario: DELETE outside the allow-list fails the suite

- **WHEN** any file other than the owning repository or the dev seed contains `DELETE FROM memory`, `DELETE FROM sessions`, or `DELETE FROM prompts`
- **THEN** the invariants suite SHALL fail naming the file

#### Scenario: Positive anchors prevent silent purge removal

- **WHEN** an allow-listed repository no longer contains its purge `DELETE` statement
- **THEN** the invariants suite SHALL fail, forcing the allow-list and the implementation to move together

### Requirement: Database diagnostics module

A function-style module at `apps/server/src/db/diagnostics.ts` SHALL own database-level introspection and administration: PRAGMA reads (`journal_mode`, `quick_check`, `page_count`, `page_size`, `freelist_count`), `dbstat` aggregation, dynamic table row counts, a liveness `ping`, and `VACUUM INTO`. Bootstrap, the data-loss guard, the healthz endpoint, and the maintenance dashboard SHALL consume this module instead of executing these statements themselves.

#### Scenario: Maintenance page reads diagnostics through the module

- **WHEN** the maintenance dashboard page renders database size, freelist, and per-table statistics
- **THEN** it SHALL obtain them via `diagnostics.ts` functions and the rendered values SHALL match pre-refactor output

#### Scenario: Backup uses the diagnostics module

- **WHEN** the server performs a `VACUUM INTO` backup
- **THEN** the statement SHALL execute inside `diagnostics.ts`, not in bootstrap code

### Requirement: Refactor preserves observable behavior

The repository extraction SHALL NOT change any observable behavior: HTTP endpoint responses, MCP tool results, dashboard page content, and database schema SHALL be identical before and after. No migration SHALL be added.

#### Scenario: Existing test suite passes unchanged

- **WHEN** the full test suite runs after each migration phase
- **THEN** all pre-existing tests SHALL pass without modification to their assertions (test wiring/setup MAY change to inject repositories)

### Requirement: Scoped repository reads MUST require a Scope parameter, not merely a naming convention

Data-access confinement is enforced by a grep gate that matches call sites by method-name prefix: `admin*` reads are callable only from allow-listed call sites, `unsafe*` marks a deliberate cross-scope read. A repository read that is unscoped but carries **neither** prefix is invisible to that gate, so an unscoped aggregate can be served from the MCP layer while the invariant test passes — which was the case for the session status count consumed by `memory.stats` until `countByStatus` was made to require a `Scope`.

Every repository read reachable from the MCP layer SHALL take the `Scope` as a required parameter, so omitting it is a type error rather than a naming oversight. An unscoped variant SHALL exist only under the `admin` prefix, bringing it inside the confinement gate.

An MCP-reachable read MAY legitimately take no `Scope` — but only when the scoped alternative does not exist or is shown by MEASUREMENT to be unaffordable, and only under the `admin` prefix with the call site named as a `(file, method)` pair. "Would be slower" is not the standard; the numbers and the instrument that produced them are, and they SHALL be recorded with the change that admits the read so that the next proposal to scope it meets a figure rather than an assertion. Two such records stand behind the relevance level's term statistics:

- **Structural.** `memory_fts_vocab` exposes `(term, doc, cnt)` and has no scope column, so `fts5vocab` cannot be scope-filtered at all. There is no filtered vocabulary read to substitute; a scoped document frequency has to be recomputed per scope by counting matching documents per term.
- **Measured.** That recomputation costs **29.6–115.6 ms per search** as ISOLATED STATEMENT TIME (50 000 rows over six scopes, p50 of 40, one warm process), against **1.2–3.8 ms** for the index-global read on the same instrument. The correctness control passed on 228 of 228 `(scope, term)` pairs — scoped `df` never exceeded global `df`. Separately, and on a DIFFERENT instrument, the whole search measures an end-to-end p50 of **15.2–15.9 ms** at 50 000 rows. The two SHALL be quoted as separate rows and SHALL NOT be combined into one table: the second is what a caller waits on, the first is one statement inside it, and reporting a statement figure as an end-to-end one has already produced a 39× claim for a 2.5× effect in this repository.

The consequence for the level is bounded in "The relevance level's term statistics MUST come from the search index": a term statistic carries no row identity, so the unscoped read is a cost decision and not a scope hole.

#### Scenario: An unscoped aggregate is renamed into the gate

- **WHEN** an unscoped session-count read exists
- **THEN** it SHALL carry the `admin` prefix and SHALL be callable only from the `(file, method)` pairs the allow-list names — which for this read are the dashboard router, the `memory.doctor` closure and the service pass-through between them, NOT the dashboard layer alone

#### Scenario: The MCP layer cannot omit scope

- **WHEN** an MCP handler calls a scoped repository read
- **THEN** the read SHALL require the `Scope` argument, so a scope-less call fails to compile

#### Scenario: An MCP-reachable unscoped read is admitted with a measurement

- **GIVEN** a repository read reachable from the MCP layer for which no scoped alternative exists in the schema
- **WHEN** it is admitted without a `Scope` parameter
- **THEN** the change admitting it SHALL record the cost of the scoped alternative, the instrument that produced the figure, and a correctness control, and SHALL name the read's call site as a `(file, method)` pair under the `admin` prefix

### Requirement: `project.list`'s per-project memory count MUST be a scoped repository read

The per-project memory count served to the `project.list` MCP tool SHALL be produced by a repository read that takes the scope as a required parameter, so that omitting it is a type error. It SHALL NOT be produced by an unparameterised read whose only predicate is `project_id IS NOT NULL`.

This closes the instance the requirement "Scoped, unsafe, and admin method families" already anticipated. `MemoryRepository.countByProject()` took no scope, counted every `status` across every project, and was reachable from an agent-facing MCP handler; because it carried neither the `admin` nor the `unsafe` prefix, the confinement gate — which matches call sites by method-name prefix — could not see it, and the only thing recording it was the closed inventory, which records rather than gates. It is the same failure mode as the unscoped session count that reached `memory.stats`, one tool over.

The replacement read SHALL carry NEITHER the `admin` nor the `unsafe` prefix, because it is in neither family: it filters to exactly one scope, so it is not unscoped, and it is not a deliberate cross-scope read. Prefixing it `admin` would additionally require adding the `project.list` handler to the `admin*` `(file, method)` allow-list — placing an agent-facing MCP path on the unscoped-read allow-list — and none of the four arguments that admit the existing non-dashboard entries applies: the read is on a per-request path (so the boot-time-closure argument fails), its return values are keyed by `project_id` (so the argument from return types carrying no scope identity fails), and the `memory` table has both a `scope` and a `project_id` column (so the structural argument that no scoped filter exists fails).

The measurement escape hatch in "Scoped repository reads MUST require a Scope parameter, not merely a naming convention" SHALL NOT be invoked for this read without recorded figures. A scoped alternative demonstrably exists — the shared `(scope, project_id)` builder fragment, and a sibling count method on the same repository that already takes both parameters — and no measurement of it was ever recorded. If a future change adopts a key-bounded aggregate over the authorized project ids instead of a per-scope read, it SHALL record the instrument and the numbers with that change, per that requirement.

The closed inventory of unscoped, un-keyed, unprefixed repository reads SHALL NOT list this read after this change. Because that inventory is asserted by SET EQUALITY, the source change and the inventory change SHALL land together: leaving the entry after the read is gone SHALL fail the suite, and removing the entry while the unscoped read remains SHALL also fail it.

#### Scenario: The count method requires the scope

- **WHEN** the repository read backing `project.list`'s per-project count is called without scope arguments
- **THEN** the call SHALL fail to compile, because the scope is a required parameter of the method signature

#### Scenario: The count method carries no `admin` or `unsafe` prefix

- **WHEN** the repositories are scanned for the read backing `project.list`'s per-project count
- **THEN** its name SHALL NOT begin with `admin` and SHALL NOT begin with `unsafe`
- **AND** the `admin*` `(file, method)` allow-list SHALL NOT gain an entry for the `project.list` handler

#### Scenario: The unscoped-read inventory no longer lists the count

- **WHEN** the invariants suite asserts set equality between the inventory and the unscoped, un-keyed, unprefixed reads the repository sources declare
- **THEN** neither side SHALL contain the per-project memory count read
- **AND** the suite SHALL fail if the inventory entry is kept while the read is scoped, and SHALL fail if the read is left unscoped while the inventory entry is removed

#### Scenario: The scope reaching the read comes from an already-authorized project row

- **GIVEN** a token whose scope authorizes reading project `p` but not project `q`
- **WHEN** `project.list` computes its per-project counts
- **THEN** the read SHALL be invoked for `p`'s scope and SHALL NOT be invoked for `q`'s scope
- **AND** the authorization filter over project rows SHALL run before any count is taken

### Requirement: Review-axis reads MUST be served by an index over `confirmations`, not by a join rewrite

`findNeedsReview`, `countNeedsReview`, `adminCountNeedsReview` and `findDecayCandidateIds` each derive their answer from correlated subqueries over `confirmations`, one per candidate row, keyed on equality over `(memory_id, verdict)`: `SELECT MAX(event_ts) … WHERE memory_id = ? AND verdict = ?` for the three review reads (plus an `… AND event_ts > ?` refutation-recency probe), and `SELECT count(*) … WHERE memory_id = ? AND verdict = 'affirm'` for the decay confidence floor. That form SHALL be retained and served by a composite index over `(memory_id, verdict, event_ts)`. It SHALL NOT be rewritten as a `LEFT JOIN` against grouped derived tables.

The reason is measured, not stylistic. A `LEFT JOIN` + `GROUP BY` rewrite must materialise one grouped pass over the whole of `confirmations` per verdict before the outer predicate discards anything, and then build an automatic index over each derived table; the correlated form does work proportional only to the candidate rows it visits. Measured on a migrated temp database with verified-identical result sets, `countNeedsReview` as correlated-subqueries-plus-index against the join rewrite:

| active rows | confirmations/memory | correlated + index | `LEFT JOIN` + `GROUP BY` |
| ----------- | -------------------- | ------------------ | ------------------------ |
| 20 000      | 1.05                 | 8.7 ms             | 12.8 ms                  |
| 50 000      | 1.05                 | 23.5 ms            | 35.8 ms                  |
| 50 000      | 4                    | 28.0 ms            | 51.3 ms                  |
| 50 000      | 12                   | 32.5 ms            | 86.8 ms                  |

These figures establish an **ordering between the two forms on one host**, not absolute latency on any host. The ordering is what the requirement rests on, and it does not cross over: the join loses at every size and density measured, and its disadvantage widens with both, because its cost scales with the size of `confirmations` while the indexed correlated form scales with surviving candidates.

Neither form removes the `O(active rows)` outer scan. That scan is inherent — the predicate is a function of each active row's own type and timestamps, so every active row must be considered — and SHALL NOT be treated as evidence that the query shape is wrong.

#### Scenario: The correlated form is not replaced by a join

- **WHEN** a change proposes rewriting the review-axis subqueries as a `LEFT JOIN` against grouped derived tables
- **THEN** it SHALL be rejected unless it presents a measurement showing the join faster at both 20 000 and 50 000 active rows and at more than one confirmation density

#### Scenario: The reads are indexed rather than scanned

- **GIVEN** the composite index over `confirmations (memory_id, verdict, event_ts)`
- **WHEN** `EXPLAIN QUERY PLAN` is run on each of the four review-axis reads
- **THEN** every plan line that accesses `confirmations` SHALL report `USING COVERING INDEX confirmations_memory_verdict_ts_idx`

#### Scenario: The benefit is stated as density-dependent

- **WHEN** the value of the composite index is described
- **THEN** it SHALL be stated as a function of confirmation density and not as a single percentage: at ~1 confirmation per memory the measured gains at 20 000 active rows are 3.8 / 8.2 / 6.7 / 20.1% (`findNeedsReview` / `countNeedsReview` / `adminCountNeedsReview` / `findDecayCandidateIds`), the first three at or inside the ~6% run-to-run noise floor, whereas at 4 confirmations per memory they are 30–41% and at 12 they are 31–66%
- **AND** the "25–45%" figure that originally motivated the index SHALL NOT be restated as unconditional: it corresponds to ~4 confirmations per memory, not to the ~1 per memory a young corpus carries, and the index earns its place because the gain grows monotonically with re-affirmation while costing nothing measurable on the write path

### Requirement: Bounded ancestry traversal MUST be one recursive query over `memory.replaces`

Walking a memory's `replaces` ancestry SHALL be a single bounded statement issued by `MemoryRepository`, not a loop in a service issuing one probe per ancestor. Two consumers need it — save-time dismissal suppression (ids) and `memory.get`'s predecessor projection — and both SHALL be served by that one traversal. There SHALL NOT be a second implementation of the walk outside `apps/server/src/db/repositories/`, because the graph is the memory aggregate's own edge structure and the layer that materialises it is the layer that traverses it.

The traversal is deliberately unscoped: `replaces` links never cross a `(scope, project_id)` boundary, and the caller has already resolved scope for the row it starts from. It SHALL therefore carry the `unsafe` prefix, mirroring the `MemoryService.unsafe*` reads it replaces on this path, rather than being left unprefixed and invisible to the confinement gate.

The recursive term SHALL walk `memory.replaces` with `json_each`, and SHALL NOT walk the `memory_replaces` edge table. That table's primary key is `(predecessor_id, successor_id)` and, being `WITHOUT ROWID`, it carries no other index — so keying on `successor_id` makes SQLite build a transient index over the entire table on every call. Measured on one host at 39 / 1 999 / 19 999 edges, with `EXPLAIN QUERY PLAN` captured for each:

| recursive term                      | plan line for the join                                      |    39 | 1 999 |    19 999 |
| ----------------------------------- | ----------------------------------------------------------- | ----: | ----: | --------: |
| `memory_replaces` on `successor_id` | `SEARCH mr USING AUTOMATIC COVERING INDEX (successor_id=?)` | 0.015 | 0.165 | **1.640** |
| `memory.replaces` + `json_each`     | `SEARCH m USING INDEX sqlite_autoindex_memory_1 (id=?)`     | 0.014 | 0.015 | **0.015** |

These figures establish an ORDERING between the two forms on one host, not absolute latency on any host, and the ordering is what the requirement rests on: one form is flat in corpus size and the other is linear in the edge table, on a connection shared by every MCP client, the HTTP API, the dashboard and `/healthz`.

An index on `memory_replaces(successor_id)` SHALL NOT be added to make the edge-table form competitive. It would buy nothing over a form that is already flat, while adding a second index maintained by three triggers on the save path. `memory_replaces` keeps the forward direction it was built for (`findSuccessorId`).

The recursive term SHALL project the id ALONE, so `UNION` deduplicates on the id. A recursive term carrying any additional column (a depth counter, for example) deduplicates on the whole row, which re-admits an id reachable at two different depths — a DAG with a shared ancestor then yields duplicates and consumes the bound with them.

The bound SHALL be applied as a `LIMIT` on the statement, which is what makes the cost independent of chain length: SQLite drives the recursive CTE as a co-routine and stops materialising once the limit is met. Measured on a 1 000-deep chain, the same statement is 0.015 ms/call with the `LIMIT` and 0.796 ms/call without it.

Replacing a probe loop with a single statement SHALL be proven equivalent, not assumed. The proof SHALL cover the returned ids AND their order, over at least: a linear chain longer than the bound; a DAG with more than one start id and a shared ancestor; a `replaces` cycle; an ancestor id with no `memory` row; and a fan-out wide enough that the bound truncates mid-level.

#### Scenario: The plan is a primary-key seek per hop

- **WHEN** `EXPLAIN QUERY PLAN` is captured for the ancestry traversal
- **THEN** the line joining `memory` SHALL report a `SEARCH … (id=?)` primary-key seek
- **AND** no line SHALL report `AUTOMATIC COVERING INDEX`, `SCAN memory`, or `SCAN memory_replaces`

#### Scenario: The walk costs one statement

- **GIVEN** a memory whose ancestry reaches at least as many predecessors as the bound
- **WHEN** its ancestry is read
- **THEN** exactly one ancestry statement SHALL be executed, whatever the bound is set to

#### Scenario: A statement count is measured where the counter can see every execution

- **WHEN** a change measures how many statements a path executes
- **THEN** the counter SHALL wrap the terminal `all`/`get`/`run` of each prepared statement rather than counting `prepare` calls, because a statement prepared once and executed many times is one `prepare` and many executions
- **AND** the measurement SHALL be taken on a connection whose statements were all prepared under the counter, so that any path which does cache a prepared statement cannot execute it unobserved

#### Scenario: A second traversal implementation is rejected

- **WHEN** a service or handler implements a breadth-first walk of `replaces` itself
- **THEN** it SHALL be rejected in favour of the repository traversal, whatever projection it needs

#### Scenario: Row projection stays drizzle-mapped

- **WHEN** the ancestry read returns rows rather than ids
- **THEN** the projection SHALL be selected through the Drizzle builder as a `Pick<Memory, …>` so timestamps and JSON columns are mapped by the schema, and SHALL NOT be hand-hydrated from a raw result row

### Requirement: A recorded performance claim MUST be reproducible by a committed harness

A figure asserted about this repo's query performance — a wall-clock timing, a plan shape, a file size, a per-save cost — SHALL be reproducible by a reader who has only the repository. The corpus it was measured on SHALL be describable as a command against a harness committed to the tree, at a stated size and shape, rather than quoted from a database that existed on one machine on one day.

This is scoped to a claim RECORDED in a published spec, a change's `proposal.md` / `design.md` / `measurements.md`, or a code comment that a future decision would rest on. An ad-hoc timing taken while debugging is not governed by this.

The requirement exists because the alternative was measured and found wanting. A full audit of thirteen repositories was performed at 1k / 20k / 50k rows and its conclusions were published; the generator that built those corpora was scratch code and did not survive the session, so every one of those figures became unfalsifiable by anyone but its author. Two later changes had to record dev-corpus figures as "not re-derivable" for the same reason.

A claim's record SHALL therefore carry the harness invocation that rebuilds its corpus — size, shape and seed — beside the figure. A figure whose corpus cannot be rebuilt SHALL be marked as not re-derivable where it appears, rather than presented as though a reader could check it.

The harness SHALL be deterministic under a stated seed, so that a before-and-after comparison is a comparison of the same corpus rather than of two samples.

#### Scenario: A performance figure is recorded with no way to rebuild its corpus

- **WHEN** a change records a timing, a plan shape or a size measured at a corpus scale the repository cannot reproduce
- **THEN** the change SHALL be rejected, or the figure SHALL be marked in place as not re-derivable with the reason
- **AND** a figure marked that way SHALL NOT be used as the sole evidence for a decision the change is asking a reviewer to accept

#### Scenario: A claim cites a corpus the harness can rebuild

- **WHEN** a change records `EXPLAIN QUERY PLAN` output or a wall-clock figure at a stated corpus size
- **THEN** the record SHALL name the harness invocation — the sizes on each axis and the seed — that produces that corpus
- **AND** running that invocation SHALL produce a corpus of the stated shape, so the plan can be re-captured

#### Scenario: Two measurements are compared before and after a change

- **WHEN** a change reports that a query improved from one figure to another
- **THEN** both figures SHALL have been taken against corpora built from the same harness invocation and the same seed
- **AND** a comparison across two independently generated corpora SHALL NOT be reported as a before-and-after, because the difference may be the corpus

#### Scenario: The harness cannot represent what a claim needs

- **WHEN** a claim concerns behaviour the harness deliberately does not model — retrieval quality, ranking, or anything that depends on what the embedding vectors mean
- **THEN** the claim SHALL NOT cite a corpus built by the harness
- **AND** the record SHALL name the instrument that can answer it instead

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

| read                                        | before   | after    |       |
| ------------------------------------------- | -------- | -------- | ----- |
| `entities` scan backlog                     | 7.48 ms  | 0.014 ms | 551×  |
| `adminCountEntities({})`                    | 177.9 ms | 0.183 ms | 972×  |
| `adminCountEntities({kind})`                | 137.4 ms | 25.7 ms  | 5.4×  |
| `relations.adminCountWithFilters({})`       | 25.4 ms  | 0.004 ms | 6964× |
| `relations.adminCountWithFilters({status})` | 20.8 ms  | 0.420 ms | 49.6× |
| `memory.adminCountBySession(page)`          | 6.35 ms  | 0.007 ms | 906×  |
| `prompts` session-prefix range vs `LIKE`    | 6.30 ms  | 0.002 ms | 2906× |

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

### Requirement: The scoped pending-judgment reads MUST share one endpoint-lifecycle predicate

`listPendingInScope` and `countPendingInScope` are a page and its depth. They already share `endpointsInScope`, the single definition of "both endpoints lie in the resolved scope", because two copies of a scope rule drift silently. The endpoint-lifecycle rule the `memory` capability requires ("A pending judgment MUST be withheld from the agent queue once either endpoint is retired") SHALL be defined exactly once in the relations repository, beside `endpointsInScope`, and applied by both reads. A second copy is prohibited: a list and a total that disagree present as a working feature whose queue can never be drained.

The predicate SHALL be expressed as equality predicates on the already-joined source and target memory aliases, which both reads join to satisfy `endpointsInScope`. It SHALL NOT be implemented as an additional join, a correlated subquery, or a post-read filter in a caller.

A caller-side filter is specifically prohibited on two independent grounds: the row limit is applied in SQL, so dropping rows afterwards returns a short page that is indistinguishable from the end of the queue; and a lifecycle predicate in a service, MCP handler or dashboard handler violates the SQL-confinement requirement of this capability.

The lifecycle predicate SHALL NOT be folded into `endpointsInScope`. That helper serves reads which must keep seeing retired rows — the sweep's own candidate selection and the unscoped `admin*` reads — and conflating "in scope" with "still active" would make the next such read wrong by default rather than by choice.

`countPendingInScope` SHALL NOT be rewritten as an arithmetic difference of table-level counts, the form this capability prefers elsewhere for relation counts. That rewrite rests on both endpoints being NOT NULL foreign keys onto a primary key, which says nothing about the endpoints' `status`; a difference computed over `memory_relations` alone cannot see the column this predicate reads.

#### Scenario: A second copy of the predicate is introduced

- **WHEN** a change adds the endpoint-lifecycle condition inline to one of the two reads instead of reusing the shared definition
- **THEN** the change SHALL be rejected
- **AND** the reason SHALL be that the page and the total must be provably identical in what they exclude, not coincidentally identical

#### Scenario: The filter is moved to the caller

- **WHEN** a change removes the predicate from the repository and filters the returned rows in `apps/server/src/mcp/memory-tools.ts` instead
- **THEN** the change SHALL be rejected
- **AND** the reasons SHALL be both the truncated page (the limit is applied before the filter) and the data-access confinement rule

#### Scenario: The scope helper absorbs the lifecycle predicate

- **WHEN** a change adds the `status = 'active'` conditions to `endpointsInScope` so every caller inherits them
- **THEN** the change SHALL be rejected, because the sweep's aged-pending selection and the `admin*` reads share that helper and MUST keep returning retired-endpoint rows

#### Scenario: The pending count is rewritten as an arithmetic difference

- **WHEN** a change replaces `countPendingInScope`'s join-and-count with a difference of table-level counts
- **THEN** the change SHALL be rejected
- **AND** the reason SHALL be that the predicate reads `status` on the joined memory rows, which no count over `memory_relations` alone can observe — the schema fact behind the other relation-count rewrites does not extend to it
