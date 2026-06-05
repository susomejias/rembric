## ADDED Requirements

### Requirement: `sessions.summary` MUST carry a length CHECK constraint enforcing `SUMMARY_MAX_CHARS`

The SQLite schema for the `sessions` table SHALL declare a `CHECK (summary IS NULL OR length(summary) <= 2000)` constraint on the `summary` column. The constraint SHALL be enforced on every INSERT and UPDATE so that no code path (existing service layer, new HTTP endpoint, manual SQL via the dashboard maintenance tools) can store a row whose `summary` exceeds the cap. SQLite `length()` counts code points; the JavaScript `String.prototype.length` cap applied at the service layer counts UTF-16 code units. The CHECK is therefore the more lenient of the two for non-BMP characters, which is the intended direction (the JS layer is the source of truth, the CHECK is the backstop).

The migration that adds the constraint SHALL be additive and SHALL bring pre-existing rows into compliance before the constraint is activated: any row whose `summary` exceeds `SUMMARY_MAX_CHARS` SHALL be truncated to `substr(summary, 1, 1987) || '…[truncated]'` in the same transaction that rebuilds the table. The constraint SHALL be added via the SQLite table-rebuild pattern (`CREATE TABLE sessions_new (…CHECK…)` → `INSERT … SELECT *` → `DROP TABLE sessions` → `ALTER TABLE … RENAME`), because SQLite does not support `ALTER TABLE … ADD CONSTRAINT`. The migration SHALL also recreate every index, trigger, and foreign-key declaration that existed on the original `sessions` table.

The append-only invariant on the `agent_sessions` schema is preserved: `summary` is explicitly enumerated as a mutable column in the invariant declaration (subject to `summary_final` precedence), so the migration's `UPDATE` of existing rows is consistent with the invariant. The invariant prohibits row `DELETE` and `UPDATE` of immutable columns (`agent`, `token_id`, `project_id`, `started_at`), neither of which is touched.

The migration SHALL be one-way: truncation is lossy and SHALL NOT be reversed by a down-migration. Operators wanting to preserve pre-cap content SHALL take a `sqlite3 .backup` before the upgrade, per `docs/backup.md`.

#### Scenario: Migration runs against a database with rows exceeding the cap

- **GIVEN** a populated database where row `S1` has `summary` of length 7 500 and row `S2` has `summary` of length 500
- **WHEN** migration `0010_summary_length_check.sql` is applied
- **THEN** `S1.summary` SHALL be truncated to exactly 2 000 chars ending with the literal suffix `…[truncated]`
- **AND** `S2.summary` SHALL remain unchanged at length 500
- **AND** `S1.summary_final` SHALL remain at its prior value (truncation does not lift or lower the precedence flag)
- **AND** all rows SHALL satisfy `length(summary) IS NULL OR length(summary) <= 2000`

#### Scenario: Direct INSERT of an oversized summary is rejected by the CHECK

- **GIVEN** the migration has been applied
- **WHEN** any code path attempts `INSERT INTO sessions (..., summary, ...) VALUES (..., 'A'.repeat(2001), ...)`
- **THEN** SQLite SHALL reject the INSERT with a `SQLITE_CONSTRAINT_CHECK` error
- **AND** the test suite SHALL prove this with a unit test that bypasses the service layer

#### Scenario: Direct UPDATE that would violate the CHECK is rejected

- **GIVEN** an existing row with `summary` of length 500
- **WHEN** any code path attempts `UPDATE sessions SET summary = 'A'.repeat(2001) WHERE id = ?`
- **THEN** SQLite SHALL reject the UPDATE with a `SQLITE_CONSTRAINT_CHECK` error and the row SHALL remain unchanged

#### Scenario: Migration is idempotent under drizzle's runner

- **WHEN** migration `0010_summary_length_check.sql` runs twice (e.g. drizzle's startup loop re-applies on warm start)
- **THEN** the second invocation SHALL be a no-op (the rebuilt table already has the CHECK; the truncation step targets only rows that exceed the cap, and after the first run none do)
- **AND** the schema and row count SHALL be unchanged across the second run

#### Scenario: Indexes and triggers survive the rebuild

- **WHEN** migration `0010_summary_length_check.sql` completes
- **THEN** every index that existed on the original `sessions` table (project lookup, token lookup, status filter, started_at/ended_at ordering, deleted_at filter) SHALL exist on the rebuilt table
- **AND** any trigger or foreign-key declaration declared in `0003_sessions_and_slugs.sql` and subsequent migrations SHALL continue to be enforced after the rebuild (verified by a follow-up insert/delete cycle in the integration test)
