import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDb, type DbHandle } from '@rembric/db';

export interface TestDb {
  handle: DbHandle;
  dataDir: string;
  cleanup: () => void;
}

export function createTestDb(): TestDb {
  const dataDir = mkdtempSync(join(tmpdir(), 'rembric-test-'));
  const handle = createDb({ dataDir, onMigrationProgress: () => {}, onStartupLog: () => {} });
  return {
    handle,
    dataDir,
    cleanup: () => {
      try {
        handle.close();
      } catch {}
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
