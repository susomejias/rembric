import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from '../config.js';
import { createDb } from '../db/index.js';

/**
 * `rembric db migrate` — applies pending migrations and exits.
 *
 * The migrations runner is also invoked automatically on server startup,
 * so the typical operator flow is: `npm i -g rembric@latest`, restart
 * the service. This command exists for one-shot maintenance windows.
 */
export function runDbMigrate(): void {
  const config = loadConfig();

  // Refuse to run if a wal/-shm file suggests the server is currently up.
  const walPath = join(config.dataDir, 'data.db-wal');
  if (existsSync(walPath)) {
    process.stderr.write(
      'rembric: data.db-wal exists; the server appears to be running.\n' +
        '         Stop the service before running db migrate to avoid contention.\n',
    );
    process.exit(75); // EX_TEMPFAIL
  }

  const handle = createDb({ dataDir: config.dataDir });
  try {
    process.stdout.write(JSON.stringify({ ok: true, dataDir: config.dataDir }, null, 2) + '\n');
  } finally {
    handle.close();
  }
}
