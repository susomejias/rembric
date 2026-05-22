## ADDED Requirements

### Requirement: The migration runner MUST disable `foreign_keys` around each migration transaction

The migration runner at `apps/server/src/db/migrate.ts` SHALL execute each pending migration with the following structure:

1. Snapshot the current value of `PRAGMA foreign_keys`.
2. If FKs were enabled, execute `PRAGMA foreign_keys = OFF` *outside* the transaction. (SQLite ignores changes to this pragma inside an open transaction.)
3. `BEGIN IMMEDIATE` and apply the migration's statements.
4. As the final statement inside the transaction, execute `PRAGMA foreign_key_check`. If the result is non-empty, throw an error naming the migration file and including the violation rows; the transaction SHALL roll back.
5. Record the migration filename in `_migrations` and `COMMIT`.
6. Restore the original `PRAGMA foreign_keys` value via a `finally` block, so a thrown migration does not leave the long-lived connection with FKs disabled.

This dance is required because:

- SQLite refuses `DROP TABLE` on a parent table with live child references when `foreign_keys = ON`. The DROP-TABLE check fires independently of the per-row deferral mechanism (`PRAGMA defer_foreign_keys`).
- `PRAGMA foreign_keys` is silently ignored inside an open transaction, so the disable must precede `BEGIN`.
- `PRAGMA foreign_key_check` is the pre-commit integrity gate that compensates for the disabled enforcement during the migration body.

Migration `.sql` files MAY assume FKs are off during their execution and MUST NOT rely on row-level FK enforcement during the migration body.

#### Scenario: Table-rebuild migration on a parent table with live child rows

- **GIVEN** a populated database where `sessions` is referenced by rows in `prompts.session_id`, `memory.session_id`, and `confirmations.session_id`
- **AND** `PRAGMA foreign_keys = ON` (set by `db/client.ts` on startup)
- **WHEN** a migration runs that rebuilds `sessions` via `CREATE TABLE sessions_new …; INSERT INTO sessions_new SELECT * FROM sessions; DROP TABLE sessions; ALTER TABLE sessions_new RENAME TO sessions;`
- **THEN** the runner SHALL disable `foreign_keys` outside the transaction
- **AND** the migration SHALL succeed
- **AND** `PRAGMA foreign_key_check` inside the transaction SHALL return zero rows
- **AND** `foreign_keys` SHALL be restored to `ON` after COMMIT
- **AND** all child rows in `prompts` / `memory` / `confirmations` SHALL continue to reference valid `sessions.id` values

#### Scenario: Migration that introduces a foreign-key violation is rolled back

- **GIVEN** a migration whose body inserts a row into a child table referencing a non-existent parent row
- **WHEN** the runner reaches the `PRAGMA foreign_key_check` pre-commit gate
- **THEN** the check SHALL return one row identifying the dangling reference
- **AND** the runner SHALL throw with a message naming the migration file
- **AND** the transaction SHALL roll back, leaving `_migrations` unchanged
- **AND** `foreign_keys` SHALL be restored to `ON` by the `finally` block

#### Scenario: Migration 0011 re-applies cleanly on a previously-failed server

- **GIVEN** a server where `0011_summary_length_check.sql` previously failed with `FOREIGN KEY constraint failed` (so `_migrations` has no row for `0011_*`, and the schema is in the pre-rebuild state)
- **WHEN** the server starts with the corrected migration runner
- **THEN** the runner SHALL apply `0011_summary_length_check.sql` successfully
- **AND** the resulting `sessions` table SHALL carry the `CHECK (summary IS NULL OR length(summary) <= 2000)` constraint
- **AND** all pre-existing child rows in `prompts` / `memory` / `confirmations` SHALL still reference the rebuilt `sessions` rows

#### Scenario: Migration 0011 is a no-op on servers where it already applied

- **GIVEN** a server where `0011_summary_length_check.sql` previously applied successfully (so `_migrations` has a row for `0011_*`)
- **WHEN** the server starts with the corrected migration runner
- **THEN** the runner SHALL detect the existing `_migrations` entry by filename and SHALL skip the file entirely
- **AND** the database schema SHALL be unchanged
- **AND** the startup SHALL proceed without error

#### Scenario: Static invariant guards against future regression

- **GIVEN** the test suite in `apps/server/src/test/invariants.test.ts`
- **WHEN** CI runs
- **THEN** the suite SHALL assert that `migrate.ts` contains `PRAGMA foreign_keys = OFF`, `PRAGMA foreign_keys = ON` in a `finally` block, and `PRAGMA foreign_key_check`
- **AND** any future refactor that removes the FK-toggling dance SHALL fail CI
