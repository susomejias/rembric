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

    const apply = db.transaction(() => {
      for (const stmt of statements) {
        db.exec(stmt);
      }
      recordStmt.run(file, Date.now());
    });

    apply.immediate();
    applied.push(file);
  }

  return { applied, skipped };
}

function isCommentOnly(stmt: string): boolean {
  return stmt
    .split('\n')
    .map((line) => line.trim())
    .every((line) => line === '' || line.startsWith('--'));
}
