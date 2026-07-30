## ADDED Requirements

### Requirement: Bounded ancestry traversal MUST be one recursive query over `memory.replaces`

Walking a memory's `replaces` ancestry SHALL be a single bounded statement issued by `MemoryRepository`, not a loop in a service issuing one probe per ancestor. Two consumers need it — save-time dismissal suppression (ids) and `memory.get`'s predecessor projection — and both SHALL be served by that one traversal. There SHALL NOT be a second implementation of the walk outside `apps/server/src/db/repositories/`, because the graph is the memory aggregate's own edge structure and the layer that materialises it is the layer that traverses it.

The traversal is deliberately unscoped: `replaces` links never cross a `(scope, project_id)` boundary, and the caller has already resolved scope for the row it starts from. It SHALL therefore carry the `unsafe` prefix, mirroring the `MemoryService.unsafe*` reads it replaces on this path, rather than being left unprefixed and invisible to the confinement gate.

The recursive term SHALL walk `memory.replaces` with `json_each`, and SHALL NOT walk the `memory_replaces` edge table. That table's primary key is `(predecessor_id, successor_id)` and, being `WITHOUT ROWID`, it carries no other index — so keying on `successor_id` makes SQLite build a transient index over the entire table on every call. Measured on one host at 39 / 1 999 / 19 999 edges, with `EXPLAIN QUERY PLAN` captured for each:

| recursive term                              | plan line for the join                                       |    39 |   1 999 |    19 999 |
| ------------------------------------------- | ------------------------------------------------------------ | ----: | ------: | --------: |
| `memory_replaces` on `successor_id`          | `SEARCH mr USING AUTOMATIC COVERING INDEX (successor_id=?)`   | 0.015 |   0.165 | **1.640** |
| `memory.replaces` + `json_each`              | `SEARCH m USING INDEX sqlite_autoindex_memory_1 (id=?)`       | 0.014 |   0.015 | **0.015** |

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

## MODIFIED Requirements

### Requirement: Repositories per aggregate own all SQL for their tables

The data layer SHALL provide one repository per aggregate at `apps/server/src/db/repositories/`: `memory` (owning `memory` and `memory_fts`), `relations` (`memory_relations`), `agent-sessions` (`sessions`), `prompts` (`prompts` and `prompts_fts`), `projects`, `tokens`, `consolidation` (`consolidation_ops`, `consolidation_runs`), `vectors` (`memory_vec`, including sqlite-vec kNN queries), and `dashboard-sessions` (`dashboard_sessions`, the cookie-auth table). Each repository SHALL be a class receiving the database handle via constructor injection, instantiated once during server bootstrap. Raw SQL inside repositories SHALL be limited to constructs the Drizzle builder cannot express: FTS5 `MATCH`, sqlite-vec functions, `json_each`, recursive common table expressions (`WITH RECURSIVE`), PRAGMA, and `VACUUM INTO`.

#### Scenario: A query expressible in the builder uses the builder

- **WHEN** a repository implements a query consisting of standard relational operations (joins, grouped counts, filters, ordering, pagination)
- **THEN** it SHALL use the Drizzle query builder, not the `sql` template tag

#### Scenario: FTS5 search lives in its content table's repository

- **WHEN** any layer needs full-text search over memories or prompts
- **THEN** it SHALL call the corresponding repository method; the FTS5 `MATCH` statement exists only inside that repository
