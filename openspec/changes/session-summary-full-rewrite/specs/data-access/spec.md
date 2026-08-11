## MODIFIED Requirements

### Requirement: Repositories per aggregate own all SQL for their tables

The data layer SHALL provide one repository per aggregate at `apps/server/src/db/repositories/`: `memory` (owning `memory` and `memory_fts`), `relations` (`memory_relations`), `agent-sessions` (`sessions` and `session_summary_versions`), `prompts` (`prompts` and `prompts_fts`), `projects`, `tokens`, `consolidation` (`consolidation_ops`, `consolidation_runs`), `vectors` (`memory_vec`, including sqlite-vec kNN queries), and `dashboard-sessions` (`dashboard_sessions`, the cookie-auth table). Each repository SHALL be a class receiving the database handle via constructor injection, instantiated once during server bootstrap. Raw SQL inside repositories SHALL be limited to constructs the Drizzle builder cannot express: FTS5 `MATCH`, sqlite-vec functions, `json_each`, recursive common table expressions (`WITH RECURSIVE`), PRAGMA, and `VACUUM INTO`.

`session_summary_versions` belongs to the `agent-sessions` aggregate rather than to a repository of its own, and the reason is a write-ordering constraint rather than a preference: a version row is appended in the SAME transaction as the `UPDATE` of `sessions.summary` that it records (`sessions`, "Every curated session-summary write MUST append a version row in the same transaction"), and the two statements are meaningless apart. A second repository would let the service hold half the aggregate's write.

#### Scenario: A query expressible in the builder uses the builder

- **WHEN** a repository implements a query consisting of standard relational operations (joins, grouped counts, filters, ordering, pagination)
- **THEN** it SHALL use the Drizzle query builder, not the `sql` template tag

#### Scenario: FTS5 search lives in its content table's repository

- **WHEN** any layer needs full-text search over memories or prompts
- **THEN** it SHALL call the corresponding repository method; the FTS5 `MATCH` statement exists only inside that repository

#### Scenario: Summary-version SQL lives in the agent-sessions repository

- **WHEN** any layer inserts or reads a `session_summary_versions` row
- **THEN** the statement SHALL live in `db/repositories/agent-sessions-repository.ts`, and no SQL against that table SHALL appear in a service, dashboard handler, or MCP tool
- **AND** the unscoped whole-history read consumed by the dashboard SHALL carry the `admin` name prefix, so the confinement gate sees it
