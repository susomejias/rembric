## Context

`apps/server/src/db/client.ts:50` enables `PRAGMA foreign_keys = ON` before running migrations. This is correct for runtime safety but interacts badly with the SQLite table-rebuild pattern. Migration `0011_summary_length_check.sql` rebuilds `sessions` to add a `CHECK` constraint to `sessions.summary`; `sessions` is a parent table for `prompts.session_id`, `memory.session_id`, and `confirmations.session_id`. With FKs enabled and any child row present, `DROP TABLE sessions` raises `FOREIGN KEY constraint failed`.

The migration runner (`apps/server/src/db/migrate.ts`) wraps every file in `db.transaction(...).immediate()`. SQLite forbids changing `PRAGMA foreign_keys` mid-transaction (the pragma is silently ignored). The deferred variant — `PRAGMA defer_foreign_keys = ON` — does honor in-transaction setting, but we verified empirically that it only defers per-row FK violations, NOT the DROP-TABLE check, which fires independently:

```sql
PRAGMA foreign_keys = ON;
CREATE TABLE parent (id INTEGER PRIMARY KEY);
CREATE TABLE child (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent(id));
INSERT INTO parent VALUES (1);
INSERT INTO child VALUES (10, 1);
BEGIN;
  PRAGMA defer_foreign_keys = ON;
  -- ... rebuild ...
  DROP TABLE parent;   -- ➜ FOREIGN KEY constraint failed
COMMIT;
```

Replacing `defer_foreign_keys = ON` with `PRAGMA foreign_keys = OFF` outside the BEGIN, then running `PRAGMA foreign_key_check` before COMMIT, succeeds.

## Goals / Non-Goals

Goals:

- Unblock production servers that are currently stuck on `rembric: FOREIGN KEY constraint failed` at startup.
- Preserve every existing migration body (no `.sql` file changes).
- Make future migrations FK-safe by default. The next person adding a table-rebuild migration should not have to remember anything about FKs.
- Catch any future FK violation a migration accidentally introduces — not just for rebuilds, but for any kind of FK-affecting change.

Non-goals:

- Per-file directive support (e.g., `-- migrate:fk-safe`). Rejected: every migration we ship is FK-affecting somewhere, and explicit opt-in is just deferred ignorance. Always-on with a `foreign_key_check` gate is simpler and safer.
- Rolling out a "repair 0012" migration. The runner is atomic; if 0011 failed it rolled back without recording, so the corrected runner re-applies it cleanly. Adding a 0012 would duplicate state-tracking work that `_migrations` already does.

## Decisions

### Decision 1 · Fix lives in the runner, not in the `.sql`

We considered three locations:

| Where                                         | Pros                             | Cons                                                                              |
| --------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------- |
| Per-file `PRAGMA defer_foreign_keys = ON`     | Minimal surface; explicit        | **Doesn't actually work** (verified empirically)                                  |
| Per-file `PRAGMA foreign_keys = OFF`          | Canonical SQLite recipe          | Impossible: pragma ignored mid-transaction; runner wraps in `db.transaction(...)` |
| Runner: pragma toggle around each transaction | Works; centralized; future-proof | Changes runner semantics for ALL migrations                                       |

The runner change is the only viable option once the empirical test ruled out `defer_foreign_keys`. Changing runner semantics globally is acceptable because the alternative — invoking custom statements to BEGIN/COMMIT manually per migration — is more invasive (requires splitting better-sqlite3's transaction abstraction) and harder to reason about.

### Decision 2 · Always disable FKs around every migration, not just rebuilds

We could detect the table-rebuild pattern (DROP TABLE + RENAME TO same identifier) and only toggle FKs for those files. We chose blanket disable because:

- Detection is heuristic; future migrations could use other DDL patterns that also trip the FK check.
- Even non-rebuild migrations occasionally need temporary FK-violating state mid-flight (e.g., when batch-renumbering rows). Always-OFF removes a class of pitfall.
- The `foreign_key_check` pre-commit gate makes always-OFF safe: any inconsistency the migration leaves behind aborts the transaction.
- Migration authors don't have to think about this. Less load-bearing knowledge to pass forward.

### Decision 3 · `PRAGMA foreign_key_check` is the integrity gate

`foreign_key_check` returns one row per dangling reference currently in the schema. With FKs disabled during the migration body, this is the _only_ safety net for accidental FK violations. We run it as the last statement inside the transaction, before recording `_migrations` and before COMMIT. A non-empty result throws and rolls back.

This is mildly stricter than runtime: at runtime, FK violations are caught per-INSERT/UPDATE. During a migration, an intermediate state that violates FKs is acceptable as long as the _final_ state is consistent.

### Decision 4 · `finally` restoration so a thrown migration cannot leave FKs disabled

If a migration throws (CHECK violation, syntax error, FK violation surfaced by the gate), the surrounding `try` body unwinds and the `finally` block re-enables `foreign_keys`. Without this, a failed startup would leave the connection (long-lived after migration) with FKs disabled, weakening runtime safety. The invariant test asserts the `finally` block exists.

### Decision 5 · No `.sql` migration changes

The migration files stay byte-identical (modulo a comment update in `0011` explaining the runner contract). Any servers where 0011 already applied skip the file by `_migrations` row. Servers where 0011 failed (no `_migrations` row, transaction rolled back) re-apply the unchanged SQL under the corrected runner and succeed. Fresh installs use the same path as failed-prod servers.

## Risks / Trade-offs

- **Risk**: A migration that _depends on_ row-level FK enforcement (e.g., relies on an INSERT failing with FK violation as a guard) now silently succeeds. _Mitigation_: such a migration is anti-pattern (schema-level guards belong in CHECK constraints, not in observed INSERT failures); the `foreign_key_check` gate catches the final-state inconsistency.
- **Risk**: `PRAGMA foreign_keys` toggle adds a few microseconds per migration application. _Mitigation_: irrelevant — migrations are startup-only and rare.
- **Trade-off**: We diverge from "the .sql is the entire story for a migration". The runner now contributes load-bearing behavior. Documented in CLAUDE.md and enforced by the invariant test.

## Migration Plan

1. Update `migrate.ts` (the runner change).
2. Add regression test in `migrations.test.ts`.
3. Add invariant test in `invariants.test.ts`.
4. Add convention subsection to `CLAUDE.md`.
5. Update `0011_summary_length_check.sql` comment header to reference the runner contract (no executable change).
6. CI green → bump server (release-please picks up the conventional commit).
7. Operators with the failing image pull the new tag; next restart re-runs 0011 under the corrected runner and is recorded in `_migrations`.

## Open Questions

None.
