## MODIFIED Requirements

### Requirement: SQL execution confined to the db layer

All SQL execution — Drizzle query-builder calls, the drizzle-orm `sql` template tag, and raw better-sqlite3 statement APIs — SHALL occur only in files under `packages/db/src/` (repositories, `diagnostics.ts`, `migrate.ts`, `client.ts`, `schema/`, migrations). Files under `packages/core/src/services/`, `packages/core/src/consolidation/`, `packages/core/src/embeddings/`, `packages/mcp/src/`, `apps/server/src/dashboard/`, and `apps/server/src/server/` SHALL NOT execute SQL. Test files (`**/*.test.ts`) and `apps/server/src/scripts/seed-dev.ts` are exempt.

#### Scenario: Invariant test rejects SQL outside the db layer

- **WHEN** the invariants suite (`apps/server/src/test/invariants.test.ts`) scans non-test source files outside `packages/db/src/` for SQL-execution patterns (Drizzle builder entry points, the drizzle-orm `sql` tag import, `db.all`/`db.get`/`db.run`, `db.query.`, `raw.prepare`)
- **THEN** the suite SHALL fail with a message naming the offending file when any match is found outside the exempt set

#### Scenario: Dashboard handlers render without a db dependency

- **WHEN** a dashboard page module under `apps/server/src/dashboard/` declares its `*Deps` interface
- **THEN** the interface SHALL NOT expose the Drizzle `Db` or raw better-sqlite3 handle; handlers consume repositories and services only

### Requirement: Repositories per aggregate own all SQL for their tables

The data layer SHALL provide one repository per aggregate at `packages/db/src/repositories/`: `memory` (owning `memory` and `memory_fts`), `relations` (`memory_relations`), `agent-sessions` (`sessions`), `prompts` (`prompts` and `prompts_fts`), `projects`, `tokens`, `consolidation` (`consolidation_ops`, `consolidation_runs`), `vectors` (`memory_vec`, including sqlite-vec kNN queries), and `dashboard-sessions` (`dashboard_sessions`, the cookie-auth table). Each repository SHALL be a class receiving the database handle via constructor injection, instantiated once during server bootstrap. Raw SQL inside repositories SHALL be limited to constructs the Drizzle builder cannot express: FTS5 `MATCH`, sqlite-vec functions, `json_each`, recursive common table expressions (`WITH RECURSIVE`), PRAGMA, and `VACUUM INTO`.

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

### Requirement: Purge escape hatches live in repositories with pinned allow-lists

The physical-purge statements (`DELETE FROM memory`, `DELETE FROM sessions`, `DELETE FROM prompts`) SHALL exist only inside their owning repositories under `packages/db/src/repositories/` (plus the dev seed at `apps/server/src/scripts/seed-dev.ts`). The invariants suite SHALL allow-list exactly those files and SHALL assert positively that each allow-listed repository still contains its `DELETE` statement. Gating (admin bypass, journaling) remains in the calling service.

#### Scenario: DELETE outside the allow-list fails the suite

- **WHEN** any file other than the owning repository or the dev seed contains `DELETE FROM memory`, `DELETE FROM sessions`, or `DELETE FROM prompts`
- **THEN** the invariants suite SHALL fail naming the file

#### Scenario: Positive anchors prevent silent purge removal

- **WHEN** an allow-listed repository no longer contains its purge `DELETE` statement
- **THEN** the invariants suite SHALL fail, forcing the allow-list and the implementation to move together
