import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Database } from 'better-sqlite3';

/**
 * Minimal migrations runner.
 *
 * Discovers every `*.sql` file in `migrationsDir`, sorts them lexically,
 * and applies any not yet recorded in the `_migrations` table. Each file's
 * statements are split on `--> statement-breakpoint` markers (matching the
 * drizzle-kit output convention) and applied inside a single transaction.
 *
 * The transaction acts as a per-file lock: if two processes attempt to
 * migrate concurrently, SQLite serializes them via BEGIN IMMEDIATE.
 *
 * FK-safety dance: SQLite refuses `DROP TABLE` on a parent table whose
 * children reference live rows when `foreign_keys=ON` (the default set
 * by `db/client.ts`). `PRAGMA foreign_keys` cannot be changed inside an
 * open transaction, and `PRAGMA defer_foreign_keys` does NOT defer the
 * DROP-TABLE check (verified empirically: SQLite's DROP-TABLE FK check
 * is independent of the per-row deferral mechanism). The canonical
 * recipe — and the one we follow here — is: disable FKs outside the
 * transaction, BEGIN IMMEDIATE, apply the migration, run
 * `PRAGMA foreign_key_check` as the final pre-commit step, COMMIT, then
 * re-enable FKs. Any FK violation introduced by the migration surfaces
 * as a non-empty `foreign_key_check` result and aborts the transaction.
 */

const MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS _migrations (
    filename   TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )
`;

const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

export interface MigrateOptions {
  migrationsDir: string;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

interface AppliedRow {
  filename: string;
}

export function migrate(db: Database, opts: MigrateOptions): MigrateResult {
  db.exec(MIGRATIONS_TABLE);

  const files = readdirSync(opts.migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const seen = new Set(
    db
      .prepare<[], AppliedRow>('SELECT filename FROM _migrations')
      .all()
      .map((row) => row.filename),
  );

  const applied: string[] = [];
  const skipped: string[] = [];
  const recordStmt = db.prepare('INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)');

  for (const file of files) {
    if (seen.has(file)) {
      skipped.push(file);
      continue;
    }

    const sql = readFileSync(join(opts.migrationsDir, file), 'utf8');
    const statements = sql
      .split(STATEMENT_BREAKPOINT)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !isCommentOnly(s));

    // Snapshot FK enforcement, disable around the migration (see note above),
    // restore afterwards. Setting pragmas outside a transaction is what SQLite
    // requires for `foreign_keys`.
    const fkRow = db.prepare<[], { foreign_keys: number }>('PRAGMA foreign_keys').get();
    const fkWasOn = fkRow?.foreign_keys === 1;
    if (fkWasOn) db.exec('PRAGMA foreign_keys = OFF');

    try {
      const apply = db.transaction(() => {
        for (const stmt of statements) {
          db.exec(stmt);
        }
        // Pre-commit FK integrity gate. `foreign_key_check` returns one
        // row per dangling reference; non-empty means the migration left
        // the DB in an inconsistent state and we abort the transaction.
        const violations = db
          .prepare<
            [],
            { table: string; rowid: number | bigint; parent: string; fkid: number }
          >('PRAGMA foreign_key_check')
          .all();
        if (violations.length > 0) {
          throw new Error(
            `Migration ${file} left foreign key violations: ${JSON.stringify(violations)}`,
          );
        }
        recordStmt.run(file, Date.now());
      });

      apply.immediate();
      applied.push(file);
    } finally {
      if (fkWasOn) db.exec('PRAGMA foreign_keys = ON');
    }
  }

  return { applied, skipped };
}

function isCommentOnly(stmt: string): boolean {
  return stmt
    .split('\n')
    .map((line) => line.trim())
    .every((line) => line === '' || line.startsWith('--'));
}
