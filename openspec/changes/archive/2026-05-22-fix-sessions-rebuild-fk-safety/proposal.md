## Why

Migration `0011_summary_length_check.sql` performs the SQLite table-rebuild dance on `sessions` — a parent table referenced by `prompts.session_id`, `memory.session_id`, and `confirmations.session_id`. With `PRAGMA foreign_keys = ON` (set by `apps/server/src/db/client.ts:50` before migrations run), the `DROP TABLE sessions` step fails on any database that already holds child rows referencing a session:

```
rembric: FOREIGN KEY constraint failed
```

The bug shipped through CI because the only test for 0011 (`apps/server/src/db/migrations.test.ts`) exercised a fresh DB, and the dev stack wipes/reseeds before testing — neither path holds child rows when 0011 first applies. Production (with months of `memory` and `prompts` accumulated) does, and the server refused to boot after pulling the image.

The first instinct (and the one prescribed in the original `summary-length-cap` change task 4.2) was `PRAGMA foreign_keys = OFF` around the rebuild — but the migration runner wraps every file in `db.transaction(...).immediate()`, and `PRAGMA foreign_keys` is silently ignored mid-transaction. The second instinct (`PRAGMA defer_foreign_keys = ON`) does honor in-transaction setting, but an empirical test confirms it does NOT defer SQLite's DROP-TABLE FK check — that check fires independently of the per-row deferral mechanism. The only working approach is the canonical SQLite recipe: disable FKs _outside_ the transaction, do the rebuild, run `PRAGMA foreign_key_check` as the final pre-commit step, COMMIT, then re-enable FKs. Since this dance is needed for any table-rebuild migration on any FK parent, the fix belongs in the migration runner — not in each `.sql` file.

## What Changes

- **BREAKING (runner semantics)** Modify `apps/server/src/db/migrate.ts` so each migration is wrapped in: snapshot `foreign_keys` pragma → set OFF → `BEGIN IMMEDIATE` → apply statements → `PRAGMA foreign_key_check` (abort transaction on any non-empty result) → record in `_migrations` → COMMIT → restore `foreign_keys` to its prior value. The pragma flip happens outside the transaction (required by SQLite); the integrity gate inside the transaction prevents FK violations from being committed.
- Add a regression test in `apps/server/src/db/migrations.test.ts` that exercises the production scenario: apply migrations up to and including 0010 against a DB pre-populated with token + project + session + `prompts`/`memory`/`confirmations` rows referencing the session; assert the runner applies 0011 successfully and all FK references still resolve via `PRAGMA foreign_key_check`.
- Add a structural invariant in `apps/server/src/test/invariants.test.ts` that asserts `migrate.ts` keeps the FK-toggling dance: presence of `PRAGMA foreign_keys = OFF`, `PRAGMA foreign_keys = ON` in a `finally` block, and `PRAGMA foreign_key_check`. If a future refactor breaks any of these, CI fails.
- Document the SQLite table-rebuild + runner contract in `CLAUDE.md` under a new subsection so future migration authors don't have to rediscover this.
- Add a new requirement to `openspec/specs/persistence/spec.md` (via this change's spec delta) codifying the runner-level FK-safety contract.

No migration `.sql` files change. The fix is centralized in the runner.

## Capabilities

### New Capabilities

_None._ This change reinforces existing requirements in `persistence`.

### Modified Capabilities

- `persistence`: new requirement that the migration runner MUST disable `foreign_keys` around each migration transaction and validate via `foreign_key_check` before commit. Migration `.sql` files MAY assume FKs are off during their execution and MUST NOT rely on row-level FK enforcement during the migration body.

## Impact

Affected code:

- `apps/server/src/db/migrate.ts` (runner: pragma toggle + foreign_key_check gate, ~25 lines added)
- `apps/server/src/db/migrations.test.ts` (new regression test)
- `apps/server/src/test/invariants.test.ts` (new structural check on migrate.ts)
- `CLAUDE.md` (new convention subsection)
- `openspec/specs/persistence/spec.md` (new requirement, via this change's delta)

Affected operators:

- Production servers stuck on `rembric: FOREIGN KEY constraint failed` recover by pulling the image with this fix and restarting. The next startup re-runs 0011 (still missing from `_migrations` because the prior transaction rolled back) and succeeds.
- Servers where 0011 already applied are untouched (the runner skips by `_migrations` row, same as before).
- Fresh installs apply 0011 directly under the new runner; no observable difference.

No data loss, no schema divergence, no manual operator step required.
