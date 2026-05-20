import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDb, type DbHandle } from '../db/index.js';

/**
 * Per-test DB fixture: opens a fresh on-disk SQLite under a unique temp
 * directory, loads sqlite-vec, applies migrations, and returns a handle
 * the test can use. Always pair `createTestDb()` with `cleanup()` in an
 * `afterEach`/`afterAll` so the temp dir is removed and the connection
 * closed.
 *
 * On-disk (not `:memory:`) because sqlite-vec extension loading and the
 * FTS5 triggers behave more predictably against a regular file across
 * Node/Bun and macOS/Linux.
 */
export interface TestDb {
  handle: DbHandle;
  dataDir: string;
  cleanup: () => void;
}

export function createTestDb(): TestDb {
  const dataDir = mkdtempSync(join(tmpdir(), 'rembric-test-'));
  const handle = createDb({ dataDir });
  return {
    handle,
    dataDir,
    cleanup: () => {
      try {
        handle.close();
      } catch {
        // ignore double-close
      }
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
