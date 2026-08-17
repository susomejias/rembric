## MODIFIED Requirements

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
