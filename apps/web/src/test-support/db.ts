import { createDb, type DbHandle } from '@rembric/db';

/**
 * Open a handle on a data dir the boot harness already migrated. Unlike
 * `test/db.ts::createTestDb`, this never creates or removes the directory: the
 * `next start` process owns its lifetime, and a second connection to the same
 * SQLite file (WAL) is exactly how a test reaches the rows the HTTP surface
 * writes.
 */
export interface OpenedTestDb {
  handle: DbHandle;
  dataDir: string;
  cleanup: () => void;
}

export function openTestDb(dataDir: string): OpenedTestDb {
  // Same silenced logging `createTestDb` uses: the migrations were already
  // applied by the server's boot, so re-announcing them is pure noise.
  const handle = createDb({ dataDir, onMigrationProgress: () => {}, onStartupLog: () => {} });
  return {
    handle,
    dataDir,
    cleanup: () => {
      try {
        handle.close();
      } catch {
        // ignore double-close of a fixture the process already closed
      }
    },
  };
}
