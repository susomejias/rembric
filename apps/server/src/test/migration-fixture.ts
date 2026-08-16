import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDb, type DbHandle } from '../db/index.js';

/**
 * Stepping a database to the state just before one migration, then forward
 * through it.
 *
 * A migration that rebuilds a table, moves rows between them, or repartitions a
 * virtual table is only observable this way: `createTestDb` applies every
 * migration to an empty file, so the interesting population never exists. The
 * migrations directory is therefore staged file by file.
 */

const SOURCE_DIR = fileURLToPath(new URL('../db/migrations', import.meta.url));

export interface MigrationFixture {
  dataDir: string;
  migrationsDir: string;
  /** Every migration ordering before the one under test. */
  stagePrior: () => void;
  /** The migration under test — verbatim, or a substituted body for fault injection. */
  stage: (body?: string) => void;
  /**
   * The migration under test AND every later one. Required by any assertion
   * that reads a row back through a repository or service: the Drizzle schema
   * always describes HEAD, so a file frozen at an older migration is missing
   * columns the ORM's `SELECT *` names.
   */
  stageThroughHead: () => void;
  unstage: () => void;
  /** The migration's committed text. */
  source: () => string;
  open: (onMigrationProgress?: (line: string) => void) => DbHandle;
  cleanup: () => void;
}

export function createMigrationFixture(migration: string): MigrationFixture {
  const dataDir = mkdtempSync(join(tmpdir(), 'rembric-migration-data-'));
  const migrationsDir = mkdtempSync(join(tmpdir(), 'rembric-migration-sql-'));
  const staged = join(migrationsDir, migration);

  return {
    dataDir,
    migrationsDir,
    stagePrior: () => {
      for (const f of readdirSync(SOURCE_DIR)) {
        if (f.endsWith('.sql') && f < migration)
          copyFileSync(join(SOURCE_DIR, f), join(migrationsDir, f));
      }
    },
    stage: (body?: string) => {
      if (body === undefined) copyFileSync(join(SOURCE_DIR, migration), staged);
      else writeFileSync(staged, body);
    },
    stageThroughHead: () => {
      for (const f of readdirSync(SOURCE_DIR)) {
        if (f.endsWith('.sql') && f >= migration)
          copyFileSync(join(SOURCE_DIR, f), join(migrationsDir, f));
      }
    },
    unstage: () => unlinkSync(staged),
    source: () => readFileSync(join(SOURCE_DIR, migration), 'utf8'),
    // Silenced by default, as `createTestDb` is: every open applies migrations,
    // so the progress lines would narrate themselves once per test.
    open: (onMigrationProgress = () => {}) =>
      createDb({ dataDir, migrationsDir, onMigrationProgress }),
    cleanup: () => {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(migrationsDir, { recursive: true, force: true });
    },
  };
}
