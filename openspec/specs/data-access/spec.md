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

The data layer SHALL provide one repository per aggregate at `apps/server/src/db/repositories/`: `memory` (owning `memory` and `memory_fts`), `relations` (`memory_relations`), `agent-sessions` (`sessions`), `prompts` (`prompts` and `prompts_fts`), `projects`, `tokens`, `consolidation` (`consolidation_ops`, `consolidation_runs`), `vectors` (`memory_vec`, including sqlite-vec kNN queries), and `dashboard-sessions` (`dashboard_sessions`, the cookie-auth table). Each repository SHALL be a class receiving the database handle via constructor injection, instantiated once during server bootstrap. Raw SQL inside repositories SHALL be limited to constructs the Drizzle builder cannot express: FTS5 `MATCH`, sqlite-vec functions, `json_each`, PRAGMA, and `VACUUM INTO`.

#### Scenario: A query expressible in the builder uses the builder

- **WHEN** a repository implements a query consisting of standard relational operations (joins, grouped counts, filters, ordering, pagination)
- **THEN** it SHALL use the Drizzle query builder, not the `sql` template tag

#### Scenario: FTS5 search lives in its content table's repository

- **WHEN** any layer needs full-text search over memories or prompts
- **THEN** it SHALL call the corresponding repository method; the FTS5 `MATCH` statement exists only inside that repository

### Requirement: Scoped, unsafe, and admin method families

Repository read methods consumed by scoped service paths SHALL require scope context as explicit parameters and SHALL NOT default to unfiltered reads. Deliberately cross-scope repository methods consumed by services and operational code (consolidation engine, scope-check-then-use patterns) SHALL carry the `unsafe` prefix, mirroring the `MemoryService.unsafe*` convention. Dashboard-facing unscoped reads SHALL carry the `admin` name prefix, SHALL be read-only, and SHALL be invoked only from modules under `apps/server/src/dashboard/` (plus the two explicitly named non-dashboard call sites below). Services remain the sole resolvers of effective scope (`resolveEffectiveProject` / `scopeFromContext`); repositories enforce the filter they are given.

There is no third, unprefixed category. An aggregate-count method is NOT exempt from the prefixes: the grep gate matches call sites by method-name prefix, so an unscoped read carrying neither prefix is invisible to it and can be served from an agent-facing path while the invariant test passes — which is exactly how an unscoped session count reached `memory.stats`. Every unscoped repository read SHALL therefore carry `admin`, whatever it returns.

Two `admin*` call sites legitimately sit outside `src/dashboard/`, and both are named here rather than left to a general exemption:

- `src/server/dashboard-router.ts`, which renders the operator overview directly.
- The boot-time `memory.doctor` closure in `src/server/bootstrap.ts`. The doctor report is deliberately server-wide — `sessions.active`, the embedding and entity backlogs, the latest consolidation run and the review/pending queue depths are all unscoped by design, so that an operator debugging one project still sees the whole process's health. The closure is constructed once at boot and reads nothing per-request-scoped, so it does not leak cross-scope ROWS: every field it returns is a count or a timestamp. Reads reachable only from it SHALL still carry the `admin` prefix, so the gate sees them and the exemption is a listed call site rather than an unnamed naming gap. `vectors.adminBacklogCount()` and `consolidation.adminLatestRun()` were renamed under this rule, joining the sibling `entities.adminBacklogCount()` that already carried it.

#### Scenario: Invariant test pins admin call sites to the dashboard

- **WHEN** the invariants suite scans non-test source files outside the dashboard modules, the two named call sites, and `apps/server/src/db/repositories/` for invocations of `admin`-prefixed repository methods
- **THEN** the suite SHALL fail, naming the offending file, when any such call site is found

#### Scenario: An unscoped aggregate reachable from the doctor carries the prefix

- **WHEN** an unscoped repository read is reachable from the `memory.doctor` report
- **THEN** it SHALL carry the `admin` prefix, so it is inside the confinement gate rather than invisible to it

#### Scenario: Cross-scope semantics are preserved

- **WHEN** a service requests a memory through a repository with a scope that does not match the row's `(scope, project_id)`
- **THEN** the repository SHALL return no row and the service SHALL surface `not_found`, identical to pre-refactor behavior

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

Data-access confinement is enforced by a grep gate that matches call sites by method-name prefix: `admin*` reads are callable only from the dashboard, `unsafe*` marks a deliberate cross-scope read. A repository read that is unscoped but carries **neither** prefix is invisible to that gate, so an unscoped aggregate can be served from the MCP layer while the invariant test passes — which is the case today for the session status count consumed by `memory.stats`.

Every repository read reachable from the MCP layer SHALL take the `Scope` as a required parameter, so omitting it is a type error rather than a naming oversight. An unscoped variant SHALL exist only under the `admin` prefix, bringing it inside the confinement gate.

#### Scenario: An unscoped aggregate is renamed into the gate

- **WHEN** an unscoped session-count read exists
- **THEN** it SHALL carry the `admin` prefix and SHALL be callable only from the dashboard layer

#### Scenario: The MCP layer cannot omit scope

- **WHEN** an MCP handler calls a scoped repository read
- **THEN** the read SHALL require the `Scope` argument, so a scope-less call fails to compile

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
