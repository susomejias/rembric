import { execFile } from 'node:child_process';
import { constants } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecureContext } from 'node:tls';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

const run = promisify(execFile);
const hint = 'entity: Cold Connection Memory';
const coreUrl = new URL('../bin/rembric-plugin-core.mjs', import.meta.url).href;

it('retains hints after cold TLS setup, honours explicit deadlines, and abandons a stalled response once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rembric-recall-tls-'));
  const certFile = join(dir, 'cert.pem');
  const keyFile = join(dir, 'key.pem');
  await run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-keyout',
    keyFile,
    '-out',
    certFile,
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost',
  ]);
  const credentials = { cert: readFileSync(certFile), key: readFileSync(keyFile) };
  const context = createSecureContext(credentials);
  let mode: 'warm' | 'cold' | 'stalled' = 'warm';
  let posts = 0;
  const server = createServer(
    {
      ...credentials,
      secureOptions: constants.SSL_OP_NO_TICKET,
      SNICallback(_name, callback) {
        setTimeout(() => callback(null, context), 170);
      },
    },
    (req, res) => {
      req.resume();
      res.setHeader('Content-Type', 'application/json');
      if (!req.url?.endsWith('/recall-hints')) {
        if (mode === 'cold') res.setHeader('Connection', 'close');
        res.end(JSON.stringify({ ok: true, created: true }));
        return;
      }
      posts++;
      if (mode !== 'stalled') {
        setTimeout(() => res.end(JSON.stringify({ lines: [hint] })), 65);
      }
    },
  );
  server.on('newSession', (_id, _data, callback) => callback());
  server.on('resumeSession', (_id, callback) => callback(null, null));

  try {
    await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
    const { port } = server.address() as AddressInfo;
    const probe = async (transport: typeof mode, deadline?: number) => {
      mode = transport;
      posts = 0;
      const { stdout, stderr } = await run(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
        import { channel } from 'node:diagnostics_channel';
        import { setTimeout } from 'node:timers/promises';
        import { createSessionProtocol } from ${JSON.stringify(coreUrl)};
        const core = createSessionProtocol({agent:'fixture',serverUrl:'https://localhost:${port}',apiToken:'fixture-token',slug:'fixture'});
        await core.ensureSession('fixture-session');
        await setTimeout(30);
        let connects = 0;
        channel('undici:client:beforeConnect').subscribe(() => connects++);
        const start = performance.now();
        const lines = await core.recallHints('fixture-session', 'find src/connection.ts', ${deadline ?? 'undefined'});
        const result = { lines, connects, ms: performance.now() - start };
        process.stdout.write(JSON.stringify(result), () => process.exit(0));
      `,
        ],
        {
          env: { ...process.env, NODE_EXTRA_CA_CERTS: certFile },
          timeout: 5000,
        },
      );
      const result = JSON.parse(stdout) as { lines: string[]; connects: number; ms: number };
      expect(posts).toBe(1);
      return { ...result, stderr };
    };

    const warm = await probe('warm', 200);
    expect(warm.connects).toBe(0);
    expect(warm.lines).toEqual([hint]);
    expect(warm.stderr).toBe('');

    const shortCold = await probe('cold', 200);
    expect(shortCold.connects).toBeGreaterThan(0);
    expect(shortCold.lines).toEqual([]);
    expect(shortCold.stderr).toContain('timeout after 200ms');

    const cold = await probe('cold');
    expect(cold.connects).toBeGreaterThan(0);
    expect(cold.lines).toEqual([hint]);
    expect(cold.stderr).toBe('');

    const stalled = await probe('stalled');
    expect(stalled.lines).toEqual([]);
    expect(stalled.stderr).toContain('timeout after 500ms');
    expect(stalled.ms).toBeLessThan(1500);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
