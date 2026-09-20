import { homedir } from 'node:os';
import { join } from 'node:path';

import { createDb, type DbHandle } from '@rembric/db';

/**
 * Next re-evaluates modules on every HMR edit, so a module-level `createDb()`
 * would open a new handle on each reload — and a second writable connection to
 * one SQLite file under `journal_mode = WAL`. Per data-safety rule DS4 two
 * writers on one file interleave writes and surface `SQLITE_BUSY`, so the
 * handle is cached on the one object that survives a module reload.
 *
 * The assertion only adds the cache slot to `globalThis`'s type.
 */
const globalForDb = globalThis as typeof globalThis & { __rembricDb?: DbHandle };

/**
 * Same resolution as `apps/server/src/config.ts`: `REMBRIC_DATA_DIR`, default
 * `~/.rembric`. Data-safety rule DS1 — if this drifts, `createDb` creates a
 * fresh empty `data.db` and the process reads and writes a different file with
 * no error at all. (`createDb` logs the resolved path and whether the file
 * already existed, which is what makes that visible.)
 */
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
