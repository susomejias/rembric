import { homedir } from 'node:os';
import { join } from 'node:path';

import { createDb, type DbHandle } from '@rembric/db';

const globalForDb = globalThis as typeof globalThis & { __rembricDb?: DbHandle };

function resolveDataDir(): string {
  return process.env.REMBRIC_DATA_DIR ?? join(homedir(), '.rembric');
}

export function getDb(): DbHandle {
  const cached = globalForDb.__rembricDb;
  if (cached !== undefined) return cached;

  const handle = createDb({ dataDir: resolveDataDir() });
  globalForDb.__rembricDb = handle;
  return handle;
}
