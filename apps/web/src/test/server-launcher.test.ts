import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { copyFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveTrustedProxyHops, trustForwardedFor, trustedClientAddress } from '../../server.js';

import { findFreePort } from './net';

describe('trusted client address', () => {
  it('ignores a client-sent X-Forwarded-For when no proxy is trusted', () => {
    expect(trustedClientAddress('203.0.113.9', '192.0.2.1', 0)).toBe('192.0.2.1');
    expect(trustedClientAddress(undefined, '192.0.2.1', 0)).toBe('192.0.2.1');
  });

  it('takes the hop the trusted proxy appended, not the left-most one', () => {
    expect(trustedClientAddress('203.0.113.9, 198.51.100.7', '10.0.0.2', 1)).toBe('198.51.100.7');
    expect(trustedClientAddress('198.51.100.7', '10.0.0.2', 1)).toBe('198.51.100.7');
    expect(trustedClientAddress('203.0.113.9, 198.51.100.7, 10.0.0.3', '10.0.0.2', 2)).toBe(
      '198.51.100.7',
    );
  });

  it('clamps to the left-most entry when more hops are trusted than the chain holds', () => {
    expect(trustedClientAddress(undefined, '10.0.0.2', 1)).toBe('10.0.0.2');
    expect(trustedClientAddress('198.51.100.7', '10.0.0.2', 5)).toBe('198.51.100.7');
  });

  it('drops empty entries and joins repeated headers', () => {
    expect(trustedClientAddress(' , 198.51.100.7 ,', '10.0.0.2', 1)).toBe('198.51.100.7');
    expect(trustedClientAddress(['203.0.113.9', '198.51.100.7'], '10.0.0.2', 1)).toBe(
      '198.51.100.7',
    );
  });

  it('yields no identity when the socket address is gone', () => {
    expect(trustedClientAddress('203.0.113.9', undefined, 0)).toBeUndefined();
    expect(trustedClientAddress('203.0.113.9', undefined, 1)).toBeUndefined();
  });
});

describe('trustForwardedFor', () => {
  type FakeRequest = { headers: IncomingHttpHeaders; socket: { remoteAddress?: string } };
  type CreateServer = (listener: (req: FakeRequest) => void) => EventEmitter;

  function serve(hops: number, req: FakeRequest): IncomingHttpHeaders {
    let seen: IncomingHttpHeaders = {};
    const createServer: CreateServer = (listener) => new EventEmitter().on('request', listener);
    const wrapped = trustForwardedFor(createServer, hops) as CreateServer;
    wrapped((r) => (seen = { ...r.headers })).emit('request', req);
    return seen;
  }

  it('rewrites the header before the listener the server was created with runs', () => {
    const seen = serve(0, {
      headers: { 'x-forwarded-for': '203.0.113.9' },
      socket: { remoteAddress: '192.0.2.1' },
    });
    expect(seen['x-forwarded-for']).toBe('192.0.2.1');
  });

  it('warns once when a forwarded request arrives with no trusted proxy', () => {
    const warn = vi.fn();
    const createServer: CreateServer = (listener) => new EventEmitter().on('request', listener);
    const server = (trustForwardedFor(createServer, 0, warn) as CreateServer)(() => {});
    const forwarded = () => ({
      headers: { 'x-forwarded-for': '203.0.113.9' },
      socket: { remoteAddress: '172.18.0.3' },
    });

    server.emit('request', { headers: {}, socket: { remoteAddress: '172.18.0.3' } });
    expect(warn).not.toHaveBeenCalled();
    server.emit('request', forwarded());
    server.emit('request', forwarded());

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('172.18.0.3');
    expect(warn.mock.calls[0]?.[0]).toContain('REMBRIC_TRUSTED_PROXY_HOPS=1');
  });

  it('does not warn when a proxy hop is trusted', () => {
    const warn = vi.fn();
    const createServer: CreateServer = (listener) => new EventEmitter().on('request', listener);
    const server = (trustForwardedFor(createServer, 1, warn) as CreateServer)(() => {});

    server.emit('request', {
      headers: { 'x-forwarded-for': '203.0.113.9' },
      socket: { remoteAddress: '172.18.0.3' },
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it('removes the header rather than keep a client value when the socket address is gone', () => {
    const seen = serve(0, { headers: { 'x-forwarded-for': '203.0.113.9' }, socket: {} });
    expect('x-forwarded-for' in seen).toBe(false);
  });
});

describe('REMBRIC_TRUSTED_PROXY_HOPS', () => {
  it('defaults to 0 without a warning when unset or empty', () => {
    const warn = vi.fn();
    expect(resolveTrustedProxyHops({}, warn)).toBe(0);
    expect(resolveTrustedProxyHops({ REMBRIC_TRUSTED_PROXY_HOPS: ' ' }, warn)).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts a non-negative integer', () => {
    const warn = vi.fn();
    expect(resolveTrustedProxyHops({ REMBRIC_TRUSTED_PROXY_HOPS: '0' }, warn)).toBe(0);
    expect(resolveTrustedProxyHops({ REMBRIC_TRUSTED_PROXY_HOPS: ' 2 ' }, warn)).toBe(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['-1', '1.5', 'abc', '1e3', '99999999999999999999'])(
    'falls back to 0 with one warning on %s',
    (value) => {
      const warn = vi.fn();
      expect(resolveTrustedProxyHops({ REMBRIC_TRUSTED_PROXY_HOPS: value }, warn)).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('REMBRIC_TRUSTED_PROXY_HOPS');
    },
  );
});

describe('the launcher rewrites X-Forwarded-For before the generated server sees it', () => {
  const launcher = fileURLToPath(new URL('../../server.js', import.meta.url));
  let dir: string | undefined;
  let child: ChildProcess | undefined;

  afterEach(() => {
    child?.kill();
    child = undefined;
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function launch(
    env: Record<string, string>,
  ): Promise<{ port: number; stderr: () => string }> {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'rembric-launcher-')));
    copyFileSync(launcher, join(dir, 'server.js'));
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
    writeFileSync(
      join(dir, 'next-server.js'),
      [
        "import { createRequire } from 'node:module';",
        'const http = createRequire(import.meta.url)("http");',
        'http',
        '  .createServer((req, res) => res.end(JSON.stringify(req.headers["x-forwarded-for"] ?? null)))',
        '  .listen(Number(process.env.PORT), "127.0.0.1", () => console.error("READY"));',
      ].join('\n'),
    );
    const port = await findFreePort();
    const { REMBRIC_TRUSTED_PROXY_HOPS: _unset, ...inherited } = process.env;
    const proc = spawn(process.execPath, [join(dir, 'server.js')], {
      env: { ...inherited, REMBRIC_PORT: String(port), ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child = proc;
    let stderr = '';
    await new Promise<void>((resolve, reject) => {
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.includes('READY')) resolve();
      });
      proc.on('exit', (code) => reject(new Error(`launcher exited ${code}: ${stderr}`)));
    });
    return { port, stderr: () => stderr };
  }

  function seenForwardedFor(port: number, headers: Record<string, string>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/', headers }, (res) => {
        let text = '';
        res.on('data', (chunk: Buffer) => (text += chunk.toString()));
        res.on('end', () => resolve(JSON.parse(text)));
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('hops=0: a client-sent value cannot choose the identity', async () => {
    const { port } = await launch({});
    expect(await seenForwardedFor(port, { 'x-forwarded-for': '203.0.113.9' })).toBe('127.0.0.1');
    expect(await seenForwardedFor(port, {})).toBe('127.0.0.1');
  });

  it('hops=1 behind one proxy: the address the proxy appended is the identity', async () => {
    const { port } = await launch({ REMBRIC_TRUSTED_PROXY_HOPS: '1' });
    expect(await seenForwardedFor(port, { 'x-forwarded-for': '203.0.113.9, 198.51.100.7' })).toBe(
      '198.51.100.7',
    );
  });

  it('an invalid value warns once and trusts no proxy', async () => {
    const { port, stderr } = await launch({ REMBRIC_TRUSTED_PROXY_HOPS: 'two' });
    expect(await seenForwardedFor(port, { 'x-forwarded-for': '198.51.100.7' })).toBe('127.0.0.1');
    expect(stderr().match(/must be a non-negative integer/g)).toHaveLength(1);
    expect(stderr().match(/arrived with X-Forwarded-For/g)).toHaveLength(1);
  });
});
