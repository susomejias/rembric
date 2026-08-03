import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

import { migrate } from './migrate.js';
import { createQueryTokenizerTables } from './query-tokenizer.js';
import * as schema from './schema/index.js';

export type Schema = typeof schema;
export type Db = BetterSQLite3Database<Schema>;

/**
 * Transaction-only view of the Db handed to services. Services own
 * transaction boundaries but never execute SQL themselves — repository
 * methods called inside the callback share the single synchronous
 * better-sqlite3 connection and therefore participate automatically.
 */
export type TransactionRunner = Pick<Db, 'transaction'>;

export interface CreateDbOptions {
  /** Directory containing the SQLite file. Created (0700) if missing. */
  dataDir: string;
  /** Override the migrations directory. Defaults to colocated `migrations/`. */
  migrationsDir?: string;
  /**
   * If true, opens the DB in read-only mode. Useful for the CLI `status`
   * subcommand against a running server's data dir.
   */
  readonly?: boolean;
}

export interface DbHandle {
  db: Db;
  raw: Database.Database;
  /** fts5 arguments the query-tokenising table inherited from `memory_fts`. */
  queryTokenizer: string[];
  close: () => void;
}

export function createDb(opts: CreateDbOptions): DbHandle {
  if (!opts.readonly && !existsSync(opts.dataDir)) {
    mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
  }

  const dbPath = join(opts.dataDir, 'data.db');
  const sqlite = new Database(dbPath, opts.readonly ? { readonly: true } : undefined);

  // Load the sqlite-vec extension before anything touches the DB.
  sqliteVec.load(sqlite);

  // Read-only-safe tuning pragmas, applied to every connection: a bigger page
  // cache and mmap window cut syscalls on the FTS/vec read path, temp_store in
  // memory keeps ORDER BY / GROUP BY sorts off disk, and a non-zero busy_timeout
  // stops the read-only CLI `status` path from hitting immediate SQLITE_BUSY
  // under a concurrent writer. These never write to the database.
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('cache_size = -65536'); // 64 MB
  sqlite.pragma('mmap_size = 268435456'); // 256 MB
  sqlite.pragma('temp_store = MEMORY');

  if (!opts.readonly) {
    // Write pragmas: journal_mode=WAL allows concurrent readers while a writer
    // is active; synchronous=NORMAL is the recommended pairing for WAL.
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('synchronous = NORMAL');
    sqlite.pragma('foreign_keys = ON');

    migrate(sqlite, {
      migrationsDir: opts.migrationsDir ?? defaultMigrationsDir(),
    });

    // ANALYZE, not `PRAGMA optimize`: optimize re-analyzes only on a ~10x row-count
    // change, so a database that grew and was then SIGKILLed (close-time optimize
    // never runs) boots with statistics frozen at its old size. analysis_limit caps
    // the sample, keeping this a few ms at 50k rows. Needs a writable connection.
    sqlite.pragma('analysis_limit = 1000');
    sqlite.exec('ANALYZE');
  }

  // After the migrations: the declaration it derives from is whatever they left
  // behind (see query-tokenizer.ts).
  const queryTokenizer = createQueryTokenizerTables(sqlite);

  const db = drizzle(sqlite, { schema });

  return {
    db,
    raw: sqlite,
    queryTokenizer,
    close: () => {
      // Update statistics for tables touched this run before closing.
      if (!opts.readonly) sqlite.pragma('optimize');
      sqlite.close();
    },
  };
}

function defaultMigrationsDir(): string {
  // At runtime this file lives in dist/db/client.js next to dist/db/migrations/.
  // During tests with tsx / vitest it resolves to src/db/client.ts next to
  // src/db/migrations/.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, 'migrations');
}
