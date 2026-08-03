## ADDED Requirements

### Requirement: The `tokens` project binding MUST be closed at the database level

`tokens.scope` and `tokens.project_id` encode the same fact for a project-scoped token. The foreign key from `tokens.project_id` to `projects(id)`, present since `0000_initial_tables.sql:89,93`, proves that `project_id` names a real project; nothing proves the scope string agrees with it. Two columns encoding one fact, with only one of them enforced, is a drift the next author inherits.

`tokens` SHALL carry `CHECK (project_id IS NULL OR scope = 'project:' || project_id OR scope = 'read:project:' || project_id)`, declared in the Drizzle schema as well as the migration. The constraint encodes a representational invariant — two columns must name the same project — not a tunable policy value, and so is not of the class that `0012_drop_summary_length_check.sql` retired.

Adding it costs a table rebuild, because SQLite cannot add a `CHECK` to an existing column and the column shipped without one in `0000`. The rebuild SHALL preserve every historical row **verbatim**, with no normalisation of any column. A verbatim copy is safe because every pre-existing row already satisfies the constraint by one of two arms: rows the dashboard minted carry `project_id IS NULL` and pass via the NULL arm, and rows the dev seed minted pair `project_id` with a scope string composed from that same id and pass via a matching arm. The malformed `project:<slug>` rows pass via the NULL arm, and are exactly the rows the `auth` capability requires be left inert. A row that did disagree SHALL abort the migration — the intended outcome, never a rewrite. The constraint SHALL NOT assert the converse implication (that a project-shaped scope requires a non-`NULL` `project_id`), because that form would reject exactly those legacy rows and force either an aborted migration or the forbidden rewrite; the producer-side half of that implication is bought in the service's type signature instead.

`tokens` is a foreign-key **parent** of `sessions.token_id` (`0003_sessions_and_slugs.sql:27`) and `dashboard_sessions.token_id` (`0000_initial_tables.sql:103-108`). The migration SHALL add no `foreign_keys` pragma of its own — the runner owns them, and its `PRAGMA foreign_keys = OFF` … `PRAGMA foreign_key_check` … `COMMIT` envelope is both what makes dropping a populated parent legal and what proves nothing dangled before the commit.

A `DROP TABLE` takes every index on the table with it. The rebuild SHALL recreate `tokens_name_unique`, and the redeclared `id text PRIMARY KEY NOT NULL` SHALL reinstate `sqlite_autoindex_tokens_1`. `tokens_revoked_at_idx` SHALL NOT be recreated — `0028_drop_unusable_indexes.sql` dropped it as unusable, and the index snapshot's exact-set assertion is the guard that the rebuild neither loses an index nor resurrects one.

#### Scenario: A scope string disagreeing with the project binding is rejected after the migration

- **GIVEN** two existing projects with distinct ids `X` and `Y`
- **WHEN** a row is inserted or updated with `project_id = X` and `scope = 'project:' || Y`
- **THEN** the write SHALL be rejected by the `CHECK` constraint

#### Scenario: Agreeing rows and unbound rows are accepted

- **WHEN** a row is written with `project_id = X` and `scope = 'project:' || X`, or with `project_id = X` and `scope = 'read:project:' || X`, or with `project_id IS NULL` and any scope value
- **THEN** the write SHALL be accepted

#### Scenario: The rebuild preserves history verbatim

- **GIVEN** a populated `tokens` table holding an admin `*` row, a `read:*` row, and a legacy row with `scope = 'project:<slug>'` and `project_id IS NULL`
- **WHEN** the migration runs
- **THEN** it SHALL succeed and every column of every row SHALL be unchanged, including the legacy row's malformed scope string

#### Scenario: The rebuild preserves the index set exactly

- **WHEN** the migration runs
- **THEN** `tokens_name_unique` and `sqlite_autoindex_tokens_1` SHALL be present afterwards
- **AND** no other index on `tokens` SHALL exist

#### Scenario: Dropping the FK parent does not dangle a child row

- **GIVEN** a populated `sessions` table and a populated `dashboard_sessions` table, both referencing `tokens`
- **WHEN** the migration runs
- **THEN** it SHALL commit, and the runner's pre-commit `PRAGMA foreign_key_check` SHALL report no violation

#### Scenario: A second boot re-applies nothing

- **WHEN** the server starts again against a database where the migration has already run
- **THEN** the migration SHALL NOT be re-applied and the `CHECK` SHALL remain declared exactly once
