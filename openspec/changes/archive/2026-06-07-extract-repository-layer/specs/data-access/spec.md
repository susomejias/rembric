# data-access

Where SQL may execute, the repository API contract, transaction ownership, and the tests that enforce all of it.

## ADDED Requirements

### Requirement: SQL execution confined to the db layer

All SQL execution — Drizzle query-builder calls, the drizzle-orm `sql` template tag, and raw better-sqlite3 statement APIs — SHALL occur only in files under `apps/server/src/db/` (repositories, `diagnostics.ts`, `migrate.ts`, `client.ts`, migrations). Files under `src/services/`, `src/dashboard/`, `src/server/`, `src/mcp/`, `src/consolidation/`, and `src/embeddings/` SHALL NOT execute SQL. Test files (`**/*.test.ts`) and `src/scripts/seed-dev.ts` are exempt.

#### Scenario: Invariant test rejects SQL outside the db layer

- **WHEN** the invariants suite (`apps/server/src/test/invariants.test.ts`) scans non-test source files outside `apps/server/src/db/` for SQL-execution patterns (Drizzle builder entry points, the `sql` tag executed via `db.all`/`db.get`/`db.run`, `raw.prepare`, `.exec(`)
- **THEN** the suite SHALL fail with a message naming the offending file when any match is found outside the exempt set

#### Scenario: Dashboard handlers render without a db dependency

- **WHEN** a dashboard page module under `apps/server/src/dashboard/` declares its `*Deps` interface
- **THEN** the interface SHALL NOT expose the Drizzle `Db` or raw better-sqlite3 handle; handlers consume repositories and services only

### Requirement: Repositories per aggregate own all SQL for their tables

The data layer SHALL provide one repository per aggregate at `apps/server/src/db/repositories/`: `memory` (owning `memory` and `memory_fts`), `relations` (`memory_relations`), `agent-sessions` (`sessions`), `prompts` (`prompts` and `prompts_fts`), `projects`, `tokens`, `consolidation` (`consolidation_ops`, `consolidation_runs`), and `vectors` (`memory_vec`, including sqlite-vec kNN queries). Each repository SHALL be a class receiving the database handle via constructor injection, instantiated once during server bootstrap. Raw SQL inside repositories SHALL be limited to constructs the Drizzle builder cannot express: FTS5 `MATCH`, sqlite-vec functions, `json_each`, PRAGMA, and `VACUUM INTO`.

#### Scenario: A query expressible in the builder uses the builder

- **WHEN** a repository implements a query consisting of standard relational operations (joins, grouped counts, filters, ordering, pagination)
- **THEN** it SHALL use the Drizzle query builder, not the `sql` template tag

#### Scenario: FTS5 search lives in its content table's repository

- **WHEN** any layer needs full-text search over memories or prompts
- **THEN** it SHALL call the corresponding repository method; the FTS5 `MATCH` statement exists only inside that repository

### Requirement: Scoped and admin method families

Repository read methods consumed by scoped service paths SHALL require scope context as explicit parameters and SHALL NOT default to unfiltered reads. Deliberately cross-scope repository methods consumed by services and operational code (consolidation engine, scope-check-then-use patterns, stats counters) SHALL carry the `unsafe` prefix or be aggregate-count methods, mirroring the existing `MemoryService.unsafe*` convention. Dashboard-facing unscoped reads SHALL carry the `admin` name prefix, SHALL be read-only, and SHALL be invoked only from modules under `apps/server/src/dashboard/`. Services remain the sole resolvers of effective scope (`resolveEffectiveProject` / `scopeFromContext`); repositories enforce the filter they are given.

#### Scenario: Invariant test pins admin call sites to the dashboard

- **WHEN** the invariants suite scans non-test source files outside `apps/server/src/dashboard/` and outside `apps/server/src/db/repositories/` for invocations of `admin`-prefixed repository methods
- **THEN** the suite SHALL fail, naming the offending file, when any such call site is found

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

A function-style module at `apps/server/src/db/diagnostics.ts` SHALL own database-level introspection and administration: PRAGMA reads (`journal_mode`, `quick_check`, `page_count`, `page_size`, `freelist_count`), `dbstat` aggregation, dynamic table row counts, and `VACUUM INTO`. Bootstrap, the data-loss guard, and the maintenance dashboard SHALL consume this module instead of executing these statements themselves.

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
