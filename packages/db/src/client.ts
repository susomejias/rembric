import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
  /** Migration progress sink; defaults to stderr. See `migrate.ts`. */
  onMigrationProgress?: (line: string) => void;
  /**
   * Sink for the one provenance line emitted before the connection opens.
   * Defaults to stderr — the channel `migrate.ts` narrates on, so container
   * logs carry it. Injectable because a fixture opening thousands of
   * throwaway databases should not narrate every one.
   */
  onStartupLog?: (line: string) => void;
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

  // better-sqlite3 creates an empty database when the file is missing, so a
  // mistyped or unmounted REMBRIC_DATA_DIR makes the process read and write a
  // *different* file in complete silence. Naming the resolved path and whether
  // the file already existed is what turns that into a visible failure. The
  // `resolve` is for the log only: the path actually opened is unchanged.
  const log = opts.onStartupLog ?? ((line: string) => console.error(`[db] ${line}`));
  log(`data file ${resolve(dbPath)} (pre-existing: ${existsSync(dbPath)})`);

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
      onProgress: opts.onMigrationProgress,
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

/**
 * The migrations directory that belongs to the loaded module: `dist/migrations/`
 * in production, `src/migrations/` under vitest and tsx. Exported because it is
 * the package's answer to "where do the migrations live" — callers staging a
 * migration fixture or listing the directory must not re-derive it from their
 * own location and drift (design R6).
 */
export function defaultMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, 'migrations');
}
