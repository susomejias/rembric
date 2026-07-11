import { request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { TokensService } from '../services/tokens.js';
import { createTestDb } from '../test/db.js';
import { FakeEmbedder } from '../test/embedder.js';

import { type BootstrappedServer, createServer } from './index.js';

/**
 * Real-server coverage for the auth-surface hardening (change
 * `harden-auth-surface`): request-body bound (413), opt-in DNS-rebinding
 * Origin rejection, and the `Secure` session cookie on an HTTPS deployment.
 */

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = createNetServer();
    sock.on('error', reject);
    sock.listen(0, '127.0.0.1', () => {
      const addr = sock.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('no port'));
        return;
      }
      const { port } = addr;
      sock.close(() => resolve(port));
    });
  });
}

describe('HTTP hardening', () => {
  let server: BootstrappedServer;
  let baseUrl: string;
  const ADMIN_TOKEN = 'hardening-admin-token-with-enough-entropy-yy';

  beforeAll(async () => {
    const tmp = createTestDb();
    tmp.cleanup();
    const port = await findFreePort();
    server = await createServer(
      {
        REMBRIC_HOST: '127.0.0.1',
        REMBRIC_PORT: String(port),
        REMBRIC_DATA_DIR: tmp.dataDir,
        REMBRIC_ADMIN_TOKEN: ADMIN_TOKEN,
        // HTTPS issuer → Secure cookies + OAuth enabled.
        REMBRIC_PUBLIC_URL: 'https://rembric.example.com',
        // Smallest allowed body cap (64 KiB) so an oversized POST is cheap.
        MAX_BODY_BYTES: String(64 * 1024),
        // Opt-in DNS-rebinding: allow the loopback host + one origin.
        REMBRIC_MCP_ALLOWED_HOSTS: `127.0.0.1:${port}`,
        REMBRIC_MCP_ALLOWED_ORIGINS: 'https://good.example',
      },
      { embedder: new FakeEmbedder() },
    );
    baseUrl = `http://127.0.0.1:${port}`;
  }, 30_000);

  afterAll(async () => {
    await server?.shutdown();
  });

  function rawPost(path: string, headers: Record<string, string>): Promise<number> {
    const u = new URL(baseUrl + path);
    const body = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: u.hostname,
          port: Number(u.port),
          path: u.pathname,
          method: 'POST',
          headers: { ...headers, 'content-length': Buffer.byteLength(body) },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  it('rejects an oversized /mcp body with 413 (after auth, before buffering it all)', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
      body: 'x'.repeat(70_000),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('payload_too_large');
  });

  it('rejects a disallowed Origin on /mcp (DNS-rebinding protection)', async () => {
    // `fetch` forbids setting Origin/Host, so use a raw HTTP request.
    const status = await rawPost('/mcp', {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      origin: 'https://evil.example',
    });
    expect(status).toBe(403);
  });

  it('sets Secure on the session cookie for an HTTPS deployment', async () => {
    const res = await fetch(`${baseUrl}/dashboard/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(ADMIN_TOKEN)}`,
      redirect: 'manual',
    });
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('rembric_session=');
    expect(setCookie).toMatch(/;\s*Secure/i);
    expect(setCookie).toMatch(/HttpOnly/i);
  });

  it('returns an identical 401 for a valid-non-admin vs an invalid login token', async () => {
    // Mint a real, valid, non-admin token on the server's own connection.
    const tokensSvc = new TokensService(createRepositories(server.dbHandle.db));
    const nonAdmin = tokensSvc.create({ name: 'ro-login', scope: 'read:*' });

    async function login(token: string): Promise<{ status: number; text: string }> {
      const res = await fetch(`${baseUrl}/dashboard/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `token=${encodeURIComponent(token)}`,
        redirect: 'manual',
      });
      return { status: res.status, text: await res.text() };
    }

    const validNonAdmin = await login(nonAdmin.plaintext);
    const invalid = await login('definitely-not-a-real-token-value');
    expect(validNonAdmin.status).toBe(401);
    expect(invalid.status).toBe(401);
    // No validity oracle: the two responses are byte-identical.
    expect(validNonAdmin.text).toBe(invalid.text);
  });
});
