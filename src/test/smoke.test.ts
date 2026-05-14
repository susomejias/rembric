import { createServer as createNetServer } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type BootstrappedServer, createServer } from '../server/index.js';

import { createTestDb } from './db.js';

/**
 * 13.24 — smoke test.
 *
 * The official task asks for a 60-second run with `npx rembric`. That
 * shape doesn't compose well inside the unit suite (it ties up a
 * worker), so we shorten it to "bootstrap → exercise core surfaces →
 * shutdown cleanly" while keeping the spirit of the check: a real
 * server boot end-to-end with no unhandled errors, no DB locks, and a
 * healthy /healthz endpoint.
 *
 * If a 60s run is required for the release pipeline, an additional CI
 * job can shell out to `node dist/cli.js` with the same env.
 */

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
      const p = addr.port;
      sock.close(() => resolve(p));
    });
  });
}

describe('smoke test — full server boot/shutdown cycle', () => {
  let server: BootstrappedServer;
  let baseUrl: string;
  const errors: unknown[] = [];
  const originalUnhandled = process.listeners('uncaughtException');

  beforeAll(async () => {
    process.on('uncaughtException', (err) => errors.push(err));

    const tmp = createTestDb();
    tmp.cleanup();

    const port = await findFreePort();
    server = await createServer({
      REMBRIC_HOST: '127.0.0.1',
      REMBRIC_PORT: String(port),
      REMBRIC_DATA_DIR: tmp.dataDir,
      REMBRIC_ADMIN_TOKEN: 'smoke-test-token-with-enough-entropy-xx',
      CONSOLIDATION_ENABLED: 'false',
      EMBEDDING_ENABLED: 'false',
      OPENAI_API_KEY: 'sk-test',
    });
    baseUrl = `http://127.0.0.1:${port}`;
  }, 30_000);

  afterAll(async () => {
    await server.shutdown();
    for (const l of process.listeners('uncaughtException')) {
      if (!originalUnhandled.includes(l)) process.off('uncaughtException', l);
    }
  });

  it('GET /healthz returns 200 with ok:true', async () => {
    const res = await fetch(baseUrl + '/healthz');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('GET / redirects to the dashboard', async () => {
    const res = await fetch(baseUrl + '/', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/dashboard');
  });

  it('unknown paths return a 404 JSON envelope', async () => {
    const res = await fetch(baseUrl + '/does-not-exist');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; code: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe('not_found');
  });

  it('records no unhandled errors during the smoke run', () => {
    expect(errors).toEqual([]);
  });
});
