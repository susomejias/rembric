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

/**
 * A migration announces its own slow steps: `-- progress: <text>` on a statement
 * emits `<text>` before that statement runs, and a statement headed `-- report:`
 * is a SELECT of one text value emitted instead of being executed. Both fire
 * inside the open write transaction, which is the only place they are useful —
 * a data-moving migration is the whole of the first boot after an upgrade (203 s
 * at 200 000 repointed rows, measured), and a summary printed after it is
 * precisely what is missing when an operator or an orchestrator kills the wait.
 */
const PROGRESS_MARKER = /^--\s*progress:\s*(\S.*)$/;
const REPORT_MARKER = /^--\s*report:\s*$/;

export interface MigrateOptions {
  migrationsDir: string;
  /**
   * Sink for the lines above. Defaults to stderr, which reaches a pipe
   * synchronously on POSIX even while a migration blocks the event loop
   * (measured); tests silence it.
   */
  onProgress?: (line: string) => void;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
  /** One line per `-- report:` statement in an applied migration. */
  reports: string[];
}

interface AppliedRow {
  filename: string;
}

export function migrate(db: Database, opts: MigrateOptions): MigrateResult {
  const emit = opts.onProgress ?? ((line: string) => console.error(`[migrate] ${line}`));
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
  const reports: string[] = [];
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
      .filter((s) => s.length > 0 && !isCommentOnly(s))
      .map(readMarkers);

    // Only a migration that announces something announces itself: without this
    // every boot would narrate all thirty-odd files to say nothing.
    const announces = statements.some((s) => s.progress !== null || s.report);
    if (announces) emit(`applying ${file}`);

    // Snapshot FK enforcement, disable around the migration (see note above),
    // restore afterwards. Setting pragmas outside a transaction is what SQLite
    // requires for `foreign_keys`.
    const fkRow = db.prepare<[], { foreign_keys: number }>('PRAGMA foreign_keys').get();
    const fkWasOn = fkRow?.foreign_keys === 1;
    if (fkWasOn) db.exec('PRAGMA foreign_keys = OFF');

    try {
      const fileReports: string[] = [];
      const apply = db.transaction(() => {
        for (const stmt of statements) {
          if (stmt.report) {
            const line = db.prepare(stmt.sql).pluck().get();
            if (typeof line === 'string') {
              fileReports.push(line);
              emit(line);
            }
            continue;
          }
          if (stmt.progress !== null) emit(stmt.progress);
          db.exec(stmt.sql);
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
      reports.push(...fileReports);
    } finally {
      if (fkWasOn) db.exec('PRAGMA foreign_keys = ON');
    }
  }

  return { applied, skipped, reports };
}

interface Statement {
  sql: string;
  progress: string | null;
  report: boolean;
}

function readMarkers(stmt: string): Statement {
  let progress: string | null = null;
  let report = false;
  for (const line of stmt.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('--')) break;
    progress = PROGRESS_MARKER.exec(trimmed)?.[1] ?? progress;
    report = report || REPORT_MARKER.test(trimmed);
  }
  return { sql: stmt, progress, report };
}

function isCommentOnly(stmt: string): boolean {
  return stmt
    .split('\n')
    .map((line) => line.trim())
    .every((line) => line === '' || line.startsWith('--'));
}
