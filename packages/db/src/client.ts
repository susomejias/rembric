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

export type TransactionRunner = Pick<Db, 'transaction'>;

export interface CreateDbOptions {
  /** Directory containing the SQLite file. Created (0700) if missing. */
  dataDir: string;
  /** Override the migrations directory. Defaults to colocated `migrations/`. */
  migrationsDir?: string;
  readonly?: boolean;
  /** Migration progress sink; defaults to stderr. See `migrate.ts`. */
  onMigrationProgress?: (line: string) => void;
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

  const log = opts.onStartupLog ?? ((line: string) => console.error(`[db] ${line}`));
  log(`data file ${resolve(dbPath)} (pre-existing: ${existsSync(dbPath)})`);

  const sqlite = new Database(dbPath, opts.readonly ? { readonly: true } : undefined);

  // Load the sqlite-vec extension before anything touches the DB.
  sqliteVec.load(sqlite);

  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('cache_size = -65536'); // 64 MB
  sqlite.pragma('mmap_size = 268435456'); // 256 MB
  sqlite.pragma('temp_store = MEMORY');

  if (!opts.readonly) {
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('synchronous = NORMAL');
    sqlite.pragma('foreign_keys = ON');

    migrate(sqlite, {
      migrationsDir: opts.migrationsDir ?? defaultMigrationsDir(),
      onProgress: opts.onMigrationProgress,
    });

    sqlite.pragma('analysis_limit = 1000');
    sqlite.exec('ANALYZE');
  }

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

export function defaultMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, 'migrations');
}
