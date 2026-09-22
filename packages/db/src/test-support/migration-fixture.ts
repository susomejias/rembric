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

import { createDb, defaultMigrationsDir, type DbHandle } from '@rembric/db';

const SOURCE_DIR = defaultMigrationsDir();

export interface MigrationFixture {
  dataDir: string;
  migrationsDir: string;
  /** Every migration ordering before the one under test. */
  stagePrior: () => void;
  /** The migration under test — verbatim, or a substituted body for fault injection. */
  stage: (body?: string) => void;
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
    open: (onMigrationProgress = () => {}) =>
      createDb({ dataDir, migrationsDir, onMigrationProgress, onStartupLog: () => {} }),
    cleanup: () => {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(migrationsDir, { recursive: true, force: true });
    },
  };
}
