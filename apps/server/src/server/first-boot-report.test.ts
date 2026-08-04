import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb } from '../db/index.js';
import { FakeEmbedder } from '../test/embedder.js';

import { createServer, type BootstrappedServer } from './index.js';

/**
 * The first boot after the upgrade that repoints previously-global rows, seen
 * from where an operator and a container health check see it: the process log
 * stream. The migration IS that boot (measured 203 s at 200 000 repointed
 * rows), so the lines have to arrive while it runs, and the banner has to name
 * what moved and where to.
 */

const MIGRATION = '0031_default_project.sql';
const MIGRATIONS_SOURCE = fileURLToPath(new URL('../db/migrations', import.meta.url));
const ADMIN_TOKEN = 'first-boot-report-token-with-entropy-xx';
const GLOBAL_ROWS = 5;

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = createNetServer();
    sock.unref();
    sock.on('error', reject);
    sock.listen(0, '127.0.0.1', () => {
      const addr = sock.address();
      if (!addr || typeof addr === 'string') {
        sock.close();
        reject(new Error('no port'));
        return;
      }
      const port = addr.port;
      sock.close(() => resolve(port));
    });
  });
}

let dataDir: string;
let preMigrationsDir: string;
let server: BootstrappedServer;
let baseUrl: string;
let lines: string[];

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'rembric-first-boot-data-'));
  preMigrationsDir = mkdtempSync(join(tmpdir(), 'rembric-first-boot-migrations-'));
  for (const f of readdirSync(MIGRATIONS_SOURCE)) {
    if (f.endsWith('.sql') && f < MIGRATION) {
      copyFileSync(join(MIGRATIONS_SOURCE, f), join(preMigrationsDir, f));
    }
  }

  const pre = createDb({
    dataDir,
    migrationsDir: preMigrationsDir,
    onMigrationProgress: () => {},
  });
  const insert = pre.raw.prepare(
    `INSERT INTO memory (id, scope, project_id, type, title, content, tags, status, replaces, created_at)
       VALUES (?, 'global', NULL, 'reference', ?, ?, '[]', 'active', '[]', 0)`,
  );
  for (let i = 0; i < GLOBAL_ROWS; i++) insert.run(`g${i}`, `title ${i}`, `body ${i}`);
  pre.close();

  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const port = await findFreePort();
  try {
    server = await createServer(
      {
        REMBRIC_HOST: '127.0.0.1',
        REMBRIC_PORT: String(port),
        REMBRIC_DATA_DIR: dataDir,
        REMBRIC_ADMIN_TOKEN: ADMIN_TOKEN,
      },
      { embedder: new FakeEmbedder() },
    );
  } finally {
    lines = spy.mock.calls.map((c) => String(c[0]));
    spy.mockRestore();
  }
  baseUrl = `http://127.0.0.1:${port}`;
}, 30_000);

afterAll(async () => {
  await server.shutdown();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(preMigrationsDir, { recursive: true, force: true });
});

describe('first boot after the repointing migration', () => {
  it('narrates the migration before the banner, not after it', () => {
    const start = lines.indexOf(`[migrate] applying ${MIGRATION}`);
    const vec = lines.findIndex((l) => l.startsWith('[migrate] repartitioning the dense vector'));
    const ready = lines.findIndex((l) => l.startsWith('[bootstrap] rembric v'));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(vec).toBeGreaterThan(start);
    expect(ready).toBeGreaterThan(vec);
  });

  it('names the applied migration, the destination slug and the number of rows moved', () => {
    expect(lines).toContain(`[bootstrap] migrations applied: ${MIGRATION}`);
    expect(lines).toContain(
      `[bootstrap] repointed ${GLOBAL_ROWS} previously-global memory row(s) into the default project default`,
    );
    expect(lines.some((l) => l.startsWith('[bootstrap] counts: '))).toBe(true);
  });

  it('serves requests once the migration has been applied', async () => {
    const res = await fetch(baseUrl + '/healthz', {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(server.dbHandle.migrations.applied).toEqual([MIGRATION]);
  });
});
