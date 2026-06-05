import { createServer as createNetServer } from 'node:net';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createTestDb } from '../test/db.js';
import { FakeEmbedder } from '../test/embedder.js';

import { createServer, type BootstrappedServer } from './index.js';

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

const BANNER_ADMIN_TOKEN = 'banner-test-token-with-enough-entropy-xx';

describe('startup banner', () => {
  let server: BootstrappedServer;
  const lines: string[] = [];

  beforeAll(async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });

    const tmp = createTestDb();
    tmp.cleanup();
    const port = await findFreePort();
    server = await createServer(
      {
        REMBRIC_HOST: '127.0.0.1',
        REMBRIC_PORT: String(port),
        REMBRIC_DATA_DIR: tmp.dataDir,
        REMBRIC_ADMIN_TOKEN: BANNER_ADMIN_TOKEN,
      },
      { embedder: new FakeEmbedder() },
    );

    spy.mockRestore();
  }, 30_000);

  afterAll(async () => {
    await server.shutdown();
  });

  it('emits the bootstrap banner with version + data_dir + counts', () => {
    const bootLines = lines.filter((l) => l.startsWith('[bootstrap]'));
    expect(bootLines.some((l) => /^\[bootstrap\] rembric v\S+ ready$/.test(l))).toBe(true);
    expect(bootLines.some((l) => l.startsWith('[bootstrap] data_dir='))).toBe(true);
    expect(
      bootLines.some((l) =>
        /^\[bootstrap\] counts: memory=\d+ projects=\d+ sessions=\d+ tokens=\d+ prompts=\d+$/.test(
          l,
        ),
      ),
    ).toBe(true);
    expect(bootLines.some((l) => l.startsWith('[bootstrap] listening on '))).toBe(true);
  });

  it('emits the "no prior state marker" line on a fresh data dir', () => {
    expect(lines.some((l) => l.includes('no prior state marker'))).toBe(true);
  });
});
