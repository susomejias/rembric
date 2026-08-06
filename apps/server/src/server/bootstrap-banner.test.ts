import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createTestDb } from '../test/db.js';
import { FakeEmbedder } from '../test/embedder.js';
import { findFreePort } from '../test/index.js';

import { createServer, type BootstrappedServer } from './index.js';

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

  /**
   * The migration runner narrates from where an operator and a container health
   * check watch — the process log stream — and it has to arrive WHILE the
   * migration runs. A data-moving migration is the whole of the first boot after
   * an upgrade (measured 203 s at 200 000 repointed rows), so a summary printed
   * once the wait is over is precisely what is missing in every failure the
   * silence causes.
   */
  it('narrates every migration it applies, before the banner rather than after it', () => {
    const applying = lines.filter((l) => /^\[migrate\] applying \d{4}_/.test(l));
    // EVERY file, not just the ones whose author declared a slow step: which file
    // is being applied is the runner's knowledge, so a fresh boot narrates all of
    // them. This is a fresh data dir, so every migration applies.
    const files = readdirSync(fileURLToPath(new URL('../db/migrations', import.meta.url))).filter(
      (f) => f.endsWith('.sql'),
    );
    expect(files.length).toBeGreaterThan(1);
    expect(applying.map((l) => l.replace('[migrate] applying ', '')).sort()).toEqual(files.sort());
    const ready = lines.findIndex((l) => l.startsWith('[bootstrap] rembric v'));
    expect(ready).toBeGreaterThan(-1);
    expect(lines.indexOf(applying[applying.length - 1]!)).toBeLessThan(ready);
    // The runner's own phases too: they run after the last statement, so no
    // migration author can instrument them.
    expect(lines).toContain('[migrate] checking foreign keys');
    expect(lines).toContain('[migrate] committing');
    // Nothing repeats the report on the banner: one fact, one stream, once.
    expect(lines.filter((l) => /repointed \d+ previously-global/.test(l))).toEqual([
      '[migrate] repointed 0 previously-global memory row(s) into the default project default',
    ]);
  });
});
