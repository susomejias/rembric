## 1. Migration runner fix

- [x] 1.1 In `apps/server/src/db/migrate.ts`, wrap each migration application in: snapshot `PRAGMA foreign_keys`, `PRAGMA foreign_keys = OFF` (outside transaction), `BEGIN IMMEDIATE` (via `db.transaction(...).immediate()`), apply statements, run `PRAGMA foreign_key_check` and throw on non-empty result, record `_migrations`, COMMIT, restore `foreign_keys` in a `finally` block.
- [x] 1.2 Update the top-of-file docstring to document the FK-safety dance and reference the production incident and the invariant test.

## 2. Migration file comment

- [x] 2.1 Update the comment header of `apps/server/src/db/migrations/0011_summary_length_check.sql` to reference the runner contract (no executable change to the SQL).

## 3. Regression test

- [x] 3.1 In `apps/server/src/db/migrations.test.ts`, add a new `describe('migration 0011 with referencing children')` block that opens a fresh DB, applies migrations 0000…0010, populates token + project + session + child rows in `prompts`/`memory`/`confirmations` referencing the session, then re-runs `migrate(...)` against the full migrations dir.
- [x] 3.2 Assert: no throw; `PRAGMA foreign_key_check` returns zero rows; child rows still reference the rebuilt session; the new CHECK constraint rejects oversized summaries.
- [x] 3.3 Clean up temp DB and sliced migrations dir in `afterEach`.

## 4. Structural invariant

- [x] 4.1 In `apps/server/src/test/invariants.test.ts`, add a `describe('migration runner FK-safety invariant')` block.
- [x] 4.2 Assert `migrate.ts` contains `PRAGMA foreign_keys = OFF`, `PRAGMA foreign_keys = ON` in a `finally` block, and `PRAGMA foreign_key_check`.

## 5. Convention doc

- [x] 5.1 Add a `### Table-rebuild migrations (SQLite)` subsection to `CLAUDE.md` under `## Architecture`, explaining the SQLite gotchas (FKs ignored mid-transaction, `defer_foreign_keys` doesn't defer DROP TABLE) and pointing at the invariant test.

## 6. Validation

- [x] 6.1 `pnpm run typecheck` — green.
- [x] 6.2 `pnpm test` — green (including the new regression and invariant).

## 7. Archive

- [x] 7.1 After merge, archive this change with `/opsx:archive fix-sessions-rebuild-fk-safety`.
