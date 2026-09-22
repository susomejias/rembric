import { createDb, type DbHandle } from '@rembric/db';

export interface OpenedTestDb {
  handle: DbHandle;
  dataDir: string;
  cleanup: () => void;
}

export function openTestDb(dataDir: string): OpenedTestDb {
  const handle = createDb({ dataDir, onMigrationProgress: () => {}, onStartupLog: () => {} });
  return {
    handle,
    dataDir,
    cleanup: () => {
      try {
        handle.close();
      } catch {}
    },
  };
}
