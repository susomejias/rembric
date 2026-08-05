import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
 * A migration announces its own slow steps in the runner's directive namespace,
 * alongside the breakpoint above: `--> progress: <text>` on a statement emits
 * `<text>` before that statement runs, and a statement headed `--> report:` is a
 * SELECT of one text value emitted after the transaction commits. `-->` rather
 * than a bare `--` so a prose comment that happens to read like a directive is
 * not one.
 *
 * The progress lines fire inside the open write transaction, which is the only
 * place they are useful — a data-moving migration is the whole of the first boot
 * after an upgrade (203 s at 200 000 repointed rows, measured), and a summary
 * printed after it is precisely what is missing when an operator or an
 * orchestrator kills the wait. A report is post-hoc by definition, so it is held
 * until the COMMIT succeeds: the pre-commit integrity gate below can still veto
 * a body whose report already read as done.
 */
const PROGRESS_MARKER = /^-->\s*progress:\s*(\S[^\r\n]*)$/m;
const REPORT_MARKER = /^-->\s*report:\s*$/m;

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
}

interface AppliedRow {
  filename: string;
}

/**
 * The statements the runner will apply, in order. Exported so a test reasoning
 * about a migration's statements uses the runner's own rule rather than a second
 * implementation of it that can disagree.
 *
 * A chunk carrying nothing but a directive is kept: dropping it here is how a
 * marker gets silently discarded. Executing it is a no-op, comments and all.
 */
export function splitStatements(sql: string): string[] {
  return sql
    .split(STATEMENT_BREAKPOINT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && (!isCommentOnly(s) || hasDirective(s)));
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
  const recordStmt = db.prepare('INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)');

  for (const file of files) {
    if (seen.has(file)) continue;

    const statements = splitStatements(readFileSync(join(opts.migrationsDir, file), 'utf8'));
    emit(`applying ${file}`);

    // Snapshot FK enforcement, disable around the migration (see note above),
    // restore afterwards. Setting pragmas outside a transaction is what SQLite
    // requires for `foreign_keys`.
    const fkRow = db.prepare<[], { foreign_keys: number }>('PRAGMA foreign_keys').get();
    const fkWasOn = fkRow?.foreign_keys === 1;
    if (fkWasOn) db.exec('PRAGMA foreign_keys = OFF');
    const restoreTemp = useDiskForTempStore(db);

    try {
      const reports: string[] = [];
      const apply = db.transaction(() => {
        for (const stmt of statements) {
          const progress = PROGRESS_MARKER.exec(stmt)?.[1];
          if (progress !== undefined) emit(progress);
          if (REPORT_MARKER.test(stmt)) {
            const line = db.prepare(stmt).pluck().get();
            if (typeof line !== 'string') {
              // A report that reads as nothing is the silent-absence failure the
              // reports exist to prevent. The SQL is static text, so this fires
              // in the author's test run rather than on an operator's upgrade.
              throw new Error(
                `Migration ${file} has a '--> report:' statement returning ${
                  line === undefined ? 'no rows' : JSON.stringify(line)
                } instead of one text value`,
              );
            }
            reports.push(line);
            continue;
          }
          db.exec(stmt);
        }
        // Pre-commit FK integrity gate. `foreign_key_check` returns one
        // row per dangling reference; non-empty means the migration left
        // the DB in an inconsistent state and we abort the transaction.
        emit('checking foreign keys');
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
        emit('committing');
      });

      apply.immediate();
      applied.push(file);
      for (const line of reports) emit(line);
    } finally {
      restoreTemp();
      if (fkWasOn) db.exec('PRAGMA foreign_keys = ON');
    }
  }

  return { applied };
}

/**
 * A migration's scratch tables are `CREATE TEMP TABLE`, and `db/client.ts` pins
 * `temp_store = MEMORY` process-wide — which would turn a repointing migration's
 * stash into resident memory (measured: 477 MB of blobs, 1585 MB peak RSS at
 * 200 000 rows). Spilling to disk instead costs ~12 s and keeps the ceiling off
 * the heap, because the worst case this runs in is a memory-capped container.
 *
 * The directory is the database's own, not SQLite's default `/var/tmp`: that is
 * the filesystem the upgrade's disk requirement is stated against, and the one
 * the process has already proved it can write. `sqlite3_temp_directory` is a
 * process-global, hence the restore.
 */
function useDiskForTempStore(db: Database): () => void {
  const store = db.prepare<[], { temp_store: number }>('PRAGMA temp_store').get()?.temp_store ?? 0;
  const dir = db
    .prepare<[], { temp_store_directory: string | null }>('PRAGMA temp_store_directory')
    .get()?.temp_store_directory;
  db.exec('PRAGMA temp_store = FILE');
  if (!db.memory)
    db.exec(`PRAGMA temp_store_directory = '${dirname(db.name).replace(/'/g, "''")}'`);
  return () => {
    db.exec(`PRAGMA temp_store = ${store}`);
    db.exec(`PRAGMA temp_store_directory = '${(dir ?? '').replace(/'/g, "''")}'`);
  };
}

function hasDirective(stmt: string): boolean {
  return PROGRESS_MARKER.test(stmt) || REPORT_MARKER.test(stmt);
}

function isCommentOnly(stmt: string): boolean {
  return stmt
    .split('\n')
    .map((line) => line.trim())
    .every((line) => line === '' || line.startsWith('--'));
}
