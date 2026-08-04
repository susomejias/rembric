## ADDED Requirements

### Requirement: The persistence layer MUST add a `token_projects` join table as a purely additive migration

The schema SHALL gain a `token_projects` table recording which projects a set-scoped token reaches. The table is the authorization truth for the `projects` / `read:projects` scope arms, so both of its foreign keys SHALL be real and enforced rather than conventional.

Columns:

- `token_id` (TEXT NOT NULL, FK `tokens.id`)
- `project_id` (TEXT NOT NULL, FK `projects.id`)

Constraints and storage:

- `PRIMARY KEY (token_id, project_id)` — a token reaches a project once or not at all
- `WITHOUT ROWID` — the table is nothing but its composite key, so the primary-key index is the table and a rowid would be a second copy of the same data
- Both foreign keys SHALL reference the real parent tables, so a project **slug** written where an id belongs is rejected by SQLite and not by convention. This is the same enforcement `tokens.project_id` provides for the single-project arms.

No additional index SHALL be created: every read is keyed by `token_id`, which is the leading column of the primary key.

The migration SHALL be **purely additive** — a single `CREATE TABLE`, with no `CREATE TABLE … _new`, no `INSERT … SELECT`, no `DROP TABLE`, and no index or trigger recreation. In particular it SHALL NOT rebuild `tokens`: the existing `tokens_project_scope_check` already admits a scope string alongside `project_id IS NULL` through its first disjunct, which is the shape the set arms use, so the `CHECK` needs no extension.

Because `tokens` is not rebuilt, this migration SHALL NOT depend on the runner's `foreign_keys = OFF` envelope for a parent-table drop; the envelope applies as it does to every migration and the author SHALL add no pragma.

A later change adding a per-project access verb SHALL be able to do so additively with `ALTER TABLE token_projects ADD COLUMN access TEXT NOT NULL DEFAULT 'write'`. The default is what makes that additive on a populated table; the same `ADD COLUMN` without a default is rejected by SQLite. Recording it here means the one-verb-per-token decision is reversible without a rebuild.

#### Scenario: The migration leaves `tokens` untouched on a populated database

- **GIVEN** a database with existing `tokens` rows, including at least one `*` row, one `read:*` row and one row whose scope names a project by slug with `project_id IS NULL`
- **WHEN** the migration runs
- **THEN** every column of every pre-existing `tokens` row SHALL be byte-for-byte unchanged
- **AND** the number of `tokens` rows compared SHALL be non-zero and asserted, so the comparison is not over an empty set
- **AND** `PRAGMA foreign_key_check` SHALL return no rows and `PRAGMA integrity_check` SHALL return `ok`

#### Scenario: The migration performs no table rebuild

- **WHEN** the migration file is inspected
- **THEN** it SHALL contain exactly one `CREATE TABLE token_projects` statement
- **AND** it SHALL contain no `DROP TABLE`, no `ALTER TABLE … RENAME`, and no `INSERT … SELECT`

#### Scenario: A slug written where a project id belongs is rejected

- **WHEN** a `token_projects` row is inserted whose `project_id` is a project slug rather than a project id
- **THEN** SQLite SHALL reject the insert with a foreign-key constraint failure
- **AND** an insert naming a real `projects.id` and a real `tokens.id` SHALL be accepted

#### Scenario: An unknown token id is rejected

- **WHEN** a `token_projects` row is inserted whose `token_id` does not exist in `tokens`
- **THEN** SQLite SHALL reject the insert with a foreign-key constraint failure

#### Scenario: A token cannot be granted the same project twice

- **GIVEN** a `token_projects` row for token T and project P
- **WHEN** the same `(T, P)` pair is inserted again
- **THEN** SQLite SHALL reject the insert as a primary-key conflict

#### Scenario: The new table is enumerated by the schema inventory

- **WHEN** the schema-drift test compares the live table set against the pinned inventory
- **THEN** `token_projects` SHALL be present in both, and the comparison SHALL fail if the table is missing from either
