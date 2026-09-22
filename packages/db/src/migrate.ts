import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Database } from 'better-sqlite3';

const MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS _migrations (
    filename   TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )
`;

const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

const PROGRESS_MARKER = /^-->\s*progress:\s*(\S[^\r\n]*)$/m;
const REPORT_MARKER = /^-->\s*report:\s*$/m;

export interface MigrateOptions {
  migrationsDir: string;
  onProgress?: (line: string) => void;
}

export interface MigrateResult {
  applied: string[];
}

interface AppliedRow {
  filename: string;
}

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
