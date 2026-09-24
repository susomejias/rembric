import { createServer, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionProtocol } from '../bin/rembric-plugin-core.mjs';

const SLUG = 'hints-timeout-fixture';
const HINTS_PATH = `/api/${SLUG}/sessions/s-hints/recall-hints`;

interface Harness {
  core: ReturnType<typeof createSessionProtocol>;
  server: Server;
  stderr: string[];
  holdRequests: boolean;
  held: ServerResponse[];
}

let harness: Harness;

beforeEach(async () => {
  const stderr: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });

  harness = { core: null as never, server: null as never, stderr, holdRequests: false, held: [] };

  const server: Server = createServer((_req, res) => {
    if (harness.holdRequests) {
      harness.held.push(res);
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, lines: ['entity: Some Memory Title'] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  harness.server = server;

  harness.core = createSessionProtocol({
    agent: 'hints-timeout-agent',
    serverUrl: `http://127.0.0.1:${addr.port}`,
    apiToken: 'fixture-token',
    slug: SLUG,
    cwd: '/tmp/hints-timeout-fixture',
  });
});

afterEach(async () => {
  for (const res of harness.held) res.destroy();
  await new Promise<void>((resolve) => harness.server.close(() => resolve()));
  vi.restoreAllMocks();
});

describe('recall-hints timeout diagnostics', () => {
  it('reports an actionable timeout line with the endpoint and budget, and still returns no hints', async () => {
    await harness.core.ensureSession('s-hints');
    harness.stderr.length = 0;
    harness.holdRequests = true;

    const lines = await harness.core.recallHints('s-hints', 'look for entity hints', 50);

    expect(lines).toEqual([]);
    const output = harness.stderr.join('');
    expect(output).toContain(`POST ${HINTS_PATH} timeout after 50ms`);
    expect(output).toContain('request abandoned');
    expect(output).not.toContain('The operation was aborted due to timeout');
  });

  it('does not report a timeout when the server answers in time (control)', async () => {
    await harness.core.ensureSession('s-hints');
    harness.stderr.length = 0;

    const lines = await harness.core.recallHints('s-hints', 'look for entity hints', 2000);

    expect(lines).toEqual(['entity: Some Memory Title']);
    expect(harness.stderr.join('')).toBe('');
  });

  it('keeps the raw message for non-timeout network errors', async () => {
    await harness.core.ensureSession('s-hints');
    harness.stderr.length = 0;
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

    const lines = await harness.core.recallHints('s-hints', 'look for entity hints', 50);

    expect(lines).toEqual([]);
    const output = harness.stderr.join('');
    expect(output).toContain(`POST ${HINTS_PATH} fetch failed`);
    expect(output).not.toContain('timeout after');
  });
});
