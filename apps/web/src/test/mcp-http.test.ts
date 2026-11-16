import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { TokensService, type TokenPair } from '@rembric/core';
import { createRepositories } from '@rembric/db';
import { DESCRIPTION_MAX_LENGTH } from '@rembric/mcp';
import { NextRequest } from 'next/server';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { POST as oauthPost } from '../app/(oauth)/[...path]/route';
import { POST as loginPost } from '../app/dashboard/login/verify/route';
import { DELETE, GET, POST } from '../app/mcp/[[...path]]/route';
import { resetMcpRateLimiterForTests } from '../lib/rate-limit';
import { getServices } from '../lib/services';
import { getSession } from '../lib/session';

vi.mock('@/lib/auth', async () => await import('../lib/auth'));
vi.mock('@/lib/http-redirect', async () => await import('../lib/http-redirect'));
vi.mock('@/lib/services', async () => await import('../lib/services'));
vi.mock('@/lib/session', async () => await import('../lib/session'));

type MutableGlobal = typeof globalThis & {
  __rembricServices?: unknown;
  __rembricDb?: { raw: { close: () => void }; close: () => void };
  __rembricMcpSurface?: { close?: () => Promise<void> };
  __rembricDashboardSessions?: unknown;
};

const globalForApp = globalThis as MutableGlobal;

function resetAppGlobals(): void {
  try {
    globalForApp.__rembricDb?.close();
  } catch (error) {
    console.error('[test] app-globals db close failed', error);
  }
  delete globalForApp.__rembricServices;
  delete globalForApp.__rembricDb;
  delete globalForApp.__rembricMcpSurface;
  delete globalForApp.__rembricDashboardSessions;
}

const ORIGIN = 'http://127.0.0.1:8787';

describe('MCP HTTP transport and auth hardening (in-process route handler)', () => {
  let dataDir: string;
  let adminToken: string;
  let services: ReturnType<typeof getServices>;

  beforeAll(() => {
    resetAppGlobals();
    dataDir = mkdtempSync(join(tmpdir(), 'rembric-web-mcp-http-'));
    process.env['REMBRIC_DATA_DIR'] = dataDir;
    process.env['REMBRIC_PUBLIC_URL'] = 'https://rembric.example.com';
    process.env['REMBRIC_SESSION_SECRET'] = 'web-mcp-http-session-secret-long-enough';
    services = getServices();
    adminToken = services.tokens.create({ name: 'hardening-admin', scope: '*' }).plaintext;
  });

  afterAll(async () => {
    await globalForApp.__rembricMcpSurface?.close?.();
    await new Promise((resolve) => setImmediate(resolve));
    resetAppGlobals();
    delete process.env['REMBRIC_DATA_DIR'];
    delete process.env['REMBRIC_PUBLIC_URL'];
    delete process.env['REMBRIC_SESSION_SECRET'];
    delete process.env['RATE_LIMIT_ENABLED'];
    delete process.env['RATE_LIMIT_RPS'];
    delete process.env['RATE_LIMIT_BURST'];
    resetMcpRateLimiterForTests();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function mcpRequest(
    body: unknown,
    headers: Record<string, string> = {},
    method = 'POST',
  ): Request {
    return mcpRequestForToken(adminToken, body, headers, method);
  }

  function mcpRequestForToken(
    token: string,
    body: unknown,
    headers: Record<string, string> = {},
    method = 'POST',
  ): Request {
    return new Request(`${ORIGIN}/mcp`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  type RouteContext = { params: Promise<{ path?: string[] }> };
  const ctx: RouteContext = { params: Promise.resolve({}) };

  const initializeBody = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'c', version: '0' },
    },
  };

  async function rpcResult(res: Response): Promise<Record<string, unknown>> {
    const text = await res.text();
    const data = text.startsWith('{')
      ? text
      : (text
          .split('\n')
          .find((line) => line.startsWith('data: '))
          ?.slice('data: '.length) ?? '');
    const parsed = JSON.parse(data) as { result?: Record<string, unknown> };
    if (parsed.result === undefined) throw new Error(`no JSON-RPC result in: ${text}`);
    return parsed.result;
  }

  describe('one stateless handler for both eras', () => {
    it('answers a 2025 initialize without minting an Mcp-Session-Id', async () => {
      const res = await POST(mcpRequest(initializeBody), ctx);
      expect(res.status).toBe(200);
      expect(res.headers.get('mcp-session-id')).toBeNull();
      const result = await rpcResult(res);
      expect(result['protocolVersion']).toBe('2025-06-18');
    });

    it('serves tools/list and tools/call on later requests that carry no session id', async () => {
      await POST(mcpRequest(initializeBody), ctx);
      const list = await POST(mcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), ctx);
      expect(list.status).toBe(200);
      const tools = (await rpcResult(list))['tools'] as Array<{ name: string }>;
      expect(tools.map((t) => t.name)).toContain('project.current');

      const call = await POST(
        mcpRequest({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'project.current', arguments: {} },
        }),
        ctx,
      );
      expect(call.status).toBe(200);
      const result = (await rpcResult(call)) as { isError?: boolean; structuredContent?: unknown };
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ source: 'default' });
    });

    it('ignores an mcp-session-id the server never minted instead of answering 404/-32001', async () => {
      const res = await POST(
        mcpRequest(
          { jsonrpc: '2.0', id: 1, method: 'tools/list' },
          { 'mcp-session-id': 'no-such-session-id' },
        ),
        ctx,
      );
      expect(res.status).toBe(200);
      expect(Array.isArray((await rpcResult(res))['tools'])).toBe(true);
    });

    for (const path of [[], ['some-project']]) {
      const at = path.length === 0 ? '/mcp' : `/mcp/${path.join('/')}`;
      const pathCtx = { params: Promise.resolve(path.length === 0 ? {} : { path }) };

      it(`answers GET on ${at} with 405 and opens no event stream`, async () => {
        const res = await GET(
          mcpRequest(undefined, { accept: 'text/event-stream' }, 'GET'),
          pathCtx,
        );
        expect(res.status).toBe(405);
        expect(res.headers.get('content-type') ?? '').not.toContain('text/event-stream');
      });

      it(`answers DELETE on ${at} with 405`, async () => {
        const res = await DELETE(mcpRequest(undefined, {}, 'DELETE'), pathCtx);
        expect(res.status).toBe(405);
      });
    }

    it('control: the same bearer POSTs a 2025 request to the same endpoint successfully', async () => {
      const res = await POST(mcpRequest({ jsonrpc: '2.0', id: 9, method: 'ping' }), ctx);
      expect(res.status).toBe(200);
    });
  });

  describe('transport contract pinned before the SDK v2 collapse', () => {
    it('answers a request with no bearer with an RFC 6750 challenge naming the resource metadata', async () => {
      const res = await POST(
        new Request(`${ORIGIN}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify(initializeBody),
        }),
        ctx,
      );
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toMatchInlineSnapshot(
        `"Bearer error="invalid_token", error_description="Missing Authorization header", resource_metadata="https://rembric.example.com/.well-known/oauth-protected-resource""`,
      );
    });

    it('control: the same request with a bearer is not challenged', async () => {
      const res = await POST(mcpRequest(initializeBody), ctx);
      expect(res.status).toBe(200);
      expect(res.headers.get('www-authenticate')).toBeNull();
    });

    it('answers a POST whose Accept omits text/event-stream with 406', async () => {
      const res = await POST(mcpRequest(initializeBody, { accept: 'application/json' }), ctx);
      expect(res.status).toBe(406);
      expect(await res.json()).toMatchInlineSnapshot(`
        {
          "error": {
            "code": -32000,
            "message": "Not Acceptable: Client must accept both application/json and text/event-stream",
          },
          "id": null,
          "jsonrpc": "2.0",
        }
      `);
    });

    it('opens no standalone GET stream, so no keepalive frame is ever written', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      try {
        const res = await GET(mcpRequest(undefined, { accept: 'text/event-stream' }, 'GET'), ctx);
        expect(res.status).toBe(405);
        vi.advanceTimersByTime(15_000);
        expect(await res.text()).not.toContain(': keepalive');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('2026-07-28 era served natively', () => {
    const MODERN = '2026-07-28';
    const envelope = {
      'io.modelcontextprotocol/protocolVersion': MODERN,
      'io.modelcontextprotocol/clientInfo': { name: 'probe', version: '0' },
      'io.modelcontextprotocol/clientCapabilities': {},
    };
    type RpcError = {
      id?: unknown;
      error?: { code?: number; data?: { supported?: string[]; requested?: string } };
    };

    function routeFetch(url: string | URL, init?: RequestInit): Promise<Response> {
      const rest = new URL(url).pathname
        .split('/')
        .filter((s) => s.length > 0)
        .slice(1);
      const request = new Request(url, init);
      const routeCtx = { params: Promise.resolve(rest.length > 0 ? { path: rest } : {}) };
      const method = request.method.toUpperCase();
      const handler = method === 'GET' ? GET : method === 'DELETE' ? DELETE : POST;
      return handler(request, routeCtx);
    }

    async function connect(mode: 'auto' | 'legacy'): Promise<Client> {
      const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
        fetch: routeFetch,
        requestInit: { headers: { Authorization: `Bearer ${adminToken}` } },
      });
      const client = new Client(
        { name: 'era-probe', version: '0.0.0' },
        { versionNegotiation: { mode } },
      );
      await client.connect(transport);
      return client;
    }

    it('answers a server/discover probe with a result instead of -32022', async () => {
      const res = await POST(
        mcpRequest(
          { jsonrpc: '2.0', id: 7, method: 'server/discover', params: { _meta: envelope } },
          { 'mcp-protocol-version': MODERN, 'mcp-method': 'server/discover' },
        ),
        ctx,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as RpcError & { result?: { supportedVersions?: string[] } };
      expect(body.id).toBe(7);
      expect(body.error).toBeUndefined();
      expect(body.result?.supportedVersions).toContain(MODERN);
    });

    it('accepts a modern-era notification instead of refusing it with -32022', async () => {
      const res = await POST(
        mcpRequest(
          { jsonrpc: '2.0', method: 'notifications/cancelled', params: { _meta: envelope } },
          { 'mcp-protocol-version': MODERN, 'mcp-method': 'notifications/cancelled' },
        ),
        ctx,
      );
      expect(res.status).toBe(202);
    });

    for (const mode of ['auto', 'legacy'] as const) {
      it(`a client negotiating in ${mode} mode connects and gets the same tools, then calls one`, async () => {
        const client = await connect(mode);
        try {
          expect(client.getProtocolEra()).toBe(mode === 'auto' ? 'modern' : 'legacy');
          const { tools } = await client.listTools();
          const legacyList = await POST(
            mcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
            ctx,
          );
          const legacyTools = (await rpcResult(legacyList))['tools'] as Array<{ name: string }>;
          expect(tools.map((t) => t.name)).toEqual(legacyTools.map((t) => t.name));

          const current = await client.callTool({ name: 'project.current', arguments: {} });
          expect(current.isError).not.toBe(true);
          expect(current.structuredContent).toMatchObject({ source: 'default' });
        } finally {
          await client.close();
        }
      });
    }

    it('control: a malformed modern request keeps the SDK rejection', async () => {
      const res = await POST(
        mcpRequest(
          { jsonrpc: '2.0', id: 8, method: 'tools/list' },
          { 'mcp-protocol-version': MODERN },
        ),
        ctx,
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as RpcError).error?.code).toBe(-32602);
    });

    it('control: an envelope claiming a 2025-era version keeps the SDK answer', async () => {
      const legacyClaim = { ...envelope, 'io.modelcontextprotocol/protocolVersion': '2025-06-18' };
      const res = await POST(
        mcpRequest({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: { _meta: legacyClaim } }),
        ctx,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as RpcError;
      expect(body.error?.code).toBe(-32022);
      expect(body.error?.data?.supported).toEqual([MODERN]);
    });
  });

  describe('body cap and DNS-rebinding gates', () => {
    for (const key of [
      'MAX_BODY_BYTES',
      'REMBRIC_MCP_ALLOWED_HOSTS',
      'REMBRIC_MCP_ALLOWED_ORIGINS',
    ]) {
      afterEach(() => delete process.env[key]);
    }
    afterEach(resetMcpSurface);

    async function resetMcpSurface(): Promise<void> {
      await globalForApp.__rembricMcpSurface?.close?.();
      delete globalForApp.__rembricMcpSurface;
    }

    async function withBodyCap(value: string): Promise<void> {
      process.env['MAX_BODY_BYTES'] = value;
      await resetMcpSurface();
    }

    it('refuses a body over MAX_BODY_BYTES with the SDK’s 413 JSON-RPC error', async () => {
      await withBodyCap('1024');
      const res = await POST(mcpRequest({ ...initializeBody, pad: 'x'.repeat(4096) }), ctx);
      expect(res.status).toBe(413);
      expect(res.headers.get('connection')).toBeNull();
      expect(await res.json()).toEqual({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Payload Too Large: Request body must not exceed 1024 bytes',
        },
        id: null,
      });
    });

    it('stops reading an over-cap body instead of buffering all of it', async () => {
      await withBodyCap('1024');
      const chunk = new TextEncoder().encode('x'.repeat(512));
      let pulled = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += chunk.byteLength;
          if (pulled > 8 * 1024 * 1024) controller.close();
          else controller.enqueue(chunk);
        },
      });
      const request = new Request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' });
      const res = await POST(request, ctx);
      expect(res.status).toBe(413);
      expect(pulled).toBeLessThan(64 * 1024);
    });

    it('control: a body under the same cap still reaches the transport', async () => {
      await withBodyCap('1024');
      const res = await POST(mcpRequest(initializeBody), ctx);
      expect(res.status).toBe(200);
    });

    it('control: an invalid MAX_BODY_BYTES falls back to the default cap', async () => {
      const padded = {
        ...initializeBody,
        params: { ...initializeBody.params, clientInfo: { name: 'x'.repeat(4096), version: '0' } },
      };
      for (const invalid of ['-1', '1.5']) {
        await withBodyCap(invalid);
        const res = await POST(mcpRequest(padded), ctx);
        expect(res.status).toBe(200);
      }
    });

    it('refuses a disallowed Origin with the SDK’s 403 body, and passes an allowed one', async () => {
      process.env['REMBRIC_MCP_ALLOWED_ORIGINS'] = 'https://allowed.example';

      const denied = await POST(
        mcpRequest(initializeBody, { origin: 'https://evil.example' }),
        ctx,
      );
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Invalid Origin: evil.example' },
        id: null,
      });

      const allowed = await POST(
        mcpRequest(initializeBody, { origin: 'https://allowed.example' }),
        ctx,
      );
      expect(allowed.status).toBe(200);
    });

    it('matches an Origin entry by hostname, ignoring scheme and port', async () => {
      process.env['REMBRIC_MCP_ALLOWED_ORIGINS'] = 'https://allowed.example';
      const res = await POST(
        mcpRequest(initializeBody, { origin: 'http://allowed.example:8443' }),
        ctx,
      );
      expect(res.status).toBe(200);
    });

    it('refuses a rebinding Host with the SDK’s 403 body, and passes an allowed one', async () => {
      process.env['REMBRIC_MCP_ALLOWED_HOSTS'] = 'rembric.example.com:443';

      const denied = await POST(mcpRequest(initializeBody, { host: '127.0.0.1:8787' }), ctx);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Invalid Host: 127.0.0.1' },
        id: null,
      });

      process.env['REMBRIC_MCP_ALLOWED_HOSTS'] = '127.0.0.1:8787';
      const allowed = await POST(mcpRequest(initializeBody, { host: '127.0.0.1:8787' }), ctx);
      expect(allowed.status).toBe(200);
    });

    it('admits the host of a configured host:port entry on any port', async () => {
      process.env['REMBRIC_MCP_ALLOWED_HOSTS'] = 'other.example, rembric.example.com:443';
      for (const host of ['rembric.example.com:443', 'rembric.example.com']) {
        const res = await POST(mcpRequest(initializeBody, { host }), ctx);
        expect(res.status).toBe(200);
      }
    });

    it('refuses a rebinding request before authenticating it', async () => {
      process.env['REMBRIC_MCP_ALLOWED_HOSTS'] = 'rembric.example.com';
      process.env['REMBRIC_MCP_ALLOWED_ORIGINS'] = 'https://rembric.example.com';
      const anonymous = (headers: Record<string, string>): Request =>
        new Request(`${ORIGIN}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...headers,
          },
          body: JSON.stringify(initializeBody),
        });

      const badHost = await POST(anonymous({ host: 'attacker.example' }), ctx);
      expect(badHost.status).toBe(403);
      expect(badHost.headers.get('www-authenticate')).toBeNull();

      const badOrigin = await POST(
        anonymous({ host: 'rembric.example.com', origin: 'https://attacker.example' }),
        ctx,
      );
      expect(badOrigin.status).toBe(403);

      const allowed = await POST(anonymous({ host: 'rembric.example.com' }), ctx);
      expect(allowed.status).toBe(401);
    });

    it('control: with neither allow-list set, a request with no Origin/Host is untouched', async () => {
      const res = await POST(mcpRequest(initializeBody), ctx);
      expect(res.status).toBe(200);
    });
  });

  function loginRequest(token: string): NextRequest {
    return new NextRequest(`${ORIGIN}/dashboard/login/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(token)}`,
    });
  }

  describe('post-auth fixed-window limiter', () => {
    afterEach(() => {
      delete process.env['RATE_LIMIT_ENABLED'];
      delete process.env['RATE_LIMIT_RPS'];
      delete process.env['RATE_LIMIT_BURST'];
      resetMcpRateLimiterForTests();
    });

    it('keeps the disabled default and refuses invalid credentials before quota accounting', async () => {
      const token = services.tokens.create({ name: 'rate-disabled', scope: '*' }).plaintext;
      const first = await POST(mcpRequestForToken(token, initializeBody), ctx);
      const second = await POST(mcpRequestForToken(token, initializeBody), ctx);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      process.env['RATE_LIMIT_ENABLED'] = 'true';
      process.env['RATE_LIMIT_RPS'] = '1';
      process.env['RATE_LIMIT_BURST'] = '1';
      resetMcpRateLimiterForTests();
      const invalid = await POST(mcpRequestForToken('not-a-real-token', initializeBody), ctx);
      expect(invalid.status).toBe(401);
      const allowed = await POST(mcpRequestForToken(token, initializeBody), ctx);
      expect(allowed.status).toBe(200);
      const blocked = await POST(mcpRequestForToken(token, initializeBody), ctx);
      expect(blocked.status).toBe(429);
    });

    it('fails closed with 500 when the direct limiter returns an unexpected error', async () => {
      process.env['RATE_LIMIT_ENABLED'] = 'true';
      process.env['RATE_LIMIT_RPS'] = '1';
      process.env['RATE_LIMIT_BURST'] = '1';
      resetMcpRateLimiterForTests();
      const consume = vi
        .spyOn(RateLimiterMemory.prototype, 'consume')
        .mockRejectedValueOnce(new Error('store failure'));

      const response = await POST(mcpRequestForToken(adminToken, initializeBody), ctx);

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        ok: false,
        code: 'internal_error',
        message: 'An unexpected error occurred.',
      });
      expect(consume).toHaveBeenCalledWith(expect.any(String));
    });

    it('isolates quotas by resolved static token id', async () => {
      process.env['RATE_LIMIT_ENABLED'] = 'true';
      process.env['RATE_LIMIT_RPS'] = '1';
      process.env['RATE_LIMIT_BURST'] = '1';
      resetMcpRateLimiterForTests();
      const tokenA = services.tokens.create({ name: 'rate-a', scope: '*' }).plaintext;
      const tokenB = services.tokens.create({ name: 'rate-b', scope: '*' }).plaintext;

      expect((await POST(mcpRequestForToken(tokenA, initializeBody), ctx)).status).toBe(200);
      expect((await POST(mcpRequestForToken(tokenA, initializeBody), ctx)).status).toBe(429);
      expect((await POST(mcpRequestForToken(tokenB, initializeBody), ctx)).status).toBe(200);
    });

    it('keeps an OAuth refresh rotation on the client identity bucket', async () => {
      const oauth = services.oauth;
      if (oauth === null) throw new Error('fixture: OAuth service is disabled');
      const client = oauth.registerClient({ redirectUris: ['https://client.example/callback'] });
      const code = oauth.issueCode({
        clientId: client.clientId,
        redirectUri: 'https://client.example/callback',
        codeChallenge: 'challenge',
        scope: '*',
        subject: 'oauth-subject',
      });
      const first = oauth.redeemCode({
        code,
        clientId: client.clientId,
        redirectUri: 'https://client.example/callback',
      });
      const refreshed: TokenPair = oauth.refresh({
        refreshToken: first.refreshToken,
        clientId: client.clientId,
      });

      process.env['RATE_LIMIT_ENABLED'] = 'true';
      process.env['RATE_LIMIT_RPS'] = '1';
      process.env['RATE_LIMIT_BURST'] = '1';
      resetMcpRateLimiterForTests();
      expect((await POST(mcpRequestForToken(first.accessToken, initializeBody), ctx)).status).toBe(
        200,
      );
      const blocked = await POST(mcpRequestForToken(refreshed.accessToken, initializeBody), ctx);
      expect(blocked.status).toBe(429);
      expect(await blocked.json()).toMatchObject({
        ok: false,
        code: 'rate_limited',
        retryAfterSeconds: 1,
      });
      expect(blocked.headers.get('retry-after')).toMatch(/^[0-9]+$/);
    });
  });

  it.each(['2025-03-26', '2025-06-18'])(
    'applies promotion to the warmed same secret on the next MCP request and dashboard login (%s)',
    async (protocolVersion) => {
      const target = services.tokens.create({
        name: `promotion-http-${protocolVersion}`,
        scope: 'read:*',
      });
      const oauth = services.oauth;
      if (!oauth) throw new Error('fixture: OAuth disabled');
      const client = oauth.registerClient({ redirectUris: ['https://promotion.example/callback'] });
      const code = oauth.issueCode({
        clientId: client.clientId,
        redirectUri: 'https://promotion.example/callback',
        codeChallenge: 'challenge',
        scope: 'read:*',
        subject: target.token.id,
      });
      const pair = oauth.redeemCode({
        code,
        clientId: client.clientId,
        redirectUri: 'https://promotion.example/callback',
      });
      const oauthBefore = services.db.raw
        .prepare('SELECT * FROM oauth_tokens WHERE subject = ?')
        .all(target.token.id);
      expect(oauthBefore).toHaveLength(2);
      const init = await POST(
        mcpRequestForToken(target.plaintext, {
          ...initializeBody,
          params: { ...initializeBody.params, protocolVersion },
        }),
        ctx,
      );
      expect(init.status).toBe(200);
      const headers = { 'mcp-protocol-version': protocolVersion };
      const selected = services.projects.create({ slug: `promotion-selected-${protocolVersion}` });
      const selectedCtx = { params: Promise.resolve({ path: [selected.slug] }) };
      const call = () =>
        POST(
          mcpRequestForToken(
            target.plaintext,
            {
              jsonrpc: '2.0',
              id: 2,
              method: 'tools/call',
              params: {
                name: 'memory.save_prompt',
                arguments: {
                  title: 'Promotion HTTP control',
                  content: 'The same secret can now write.',
                  tags: ['promotion-test'],
                },
              },
            },
            headers,
          ),
          selectedCtx,
        );
      async function result(response: Response) {
        expect(response.status).toBe(200);
        const text = await response.text();
        const json =
          text.startsWith('data:') || text.includes('\ndata:')
            ? text
                .split('\n')
                .find((line) => line.startsWith('data:'))
                ?.slice(5)
                .trim()
            : text;
        return JSON.parse(json ?? '') as {
          result: { isError?: boolean; content: { text: string }[] };
        };
      }
      const denied = await result(await call());
      expect(denied.result.isError).toBe(true);
      expect(JSON.stringify(denied)).toContain('forbidden');
      const loginDenied = await loginPost(loginRequest(target.plaintext));
      expect(loginDenied.headers.get('set-cookie')).toBeNull();
      expect(loginDenied.headers.get('location')).toContain('/dashboard/login');
      services.tokens.promoteToAdmin(target.token.id);
      const accepted = await result(await call());
      expect(accepted.result.isError).not.toBe(true);
      const saved: unknown = JSON.parse(accepted.result.content[0]?.text ?? '');
      expect(saved).toMatchObject({ ok: true });
      expect(saved).toHaveProperty('id', expect.any(String));
      expect(saved).toHaveProperty('createdAt', expect.any(String));
      const current = await result(
        await POST(
          mcpRequestForToken(
            target.plaintext,
            {
              jsonrpc: '2.0',
              id: 4,
              method: 'tools/call',
              params: { name: 'project.current', arguments: {} },
            },
            headers,
          ),
          selectedCtx,
        ),
      );
      expect(JSON.parse(current.result.content[0]?.text ?? '')).toMatchObject({
        projectId: selected.id,
        slug: selected.slug,
      });
      const loginAccepted = await loginPost(loginRequest(target.plaintext));
      expect(new URL(loginAccepted.headers.get('location') ?? '').pathname).toBe('/dashboard');
      expect(loginAccepted.headers.get('set-cookie')).toContain('rembric_session=');
      expect(
        services.db.raw
          .prepare('SELECT * FROM oauth_tokens WHERE subject = ?')
          .all(target.token.id),
      ).toEqual(oauthBefore);
      expect(oauth.authenticateAccessToken(pair.accessToken)?.scope).toBe('read:*');
    },
  );

  it.each(['2025-03-26', '2025-06-18'])(
    'rotation rejects old static/OAuth credentials and cookies, retaining new-secret MCP routing (%s)',
    async (protocolVersion) => {
      const target = services.tokens.create({
        name: `rotation-http-${protocolVersion}`,
        scope: '*',
      });
      const oauth = services.oauth;
      if (!oauth) throw new Error('fixture: OAuth disabled');
      const client = oauth.registerClient({ redirectUris: ['https://rotation.example/callback'] });
      const code = oauth.issueCode({
        clientId: client.clientId,
        redirectUri: 'https://rotation.example/callback',
        codeChallenge: 'challenge',
        scope: 'mcp',
        subject: target.token.id,
      });
      const pair = oauth.redeemCode({
        code,
        clientId: client.clientId,
        redirectUri: 'https://rotation.example/callback',
      });
      const verifier = 'rotation-pkce-verifier-with-at-least-forty-three-characters';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const issuePendingCode = (subject: string) =>
        oauth.issueCode({
          clientId: client.clientId,
          redirectUri: 'https://rotation.example/callback',
          codeChallenge: challenge,
          scope: 'mcp',
          subject,
        });
      const pendingCode = issuePendingCode(target.token.id);
      const controlSubject = (await services.tokens.authenticate(adminToken)).token.id;
      const controlCode = issuePendingCode(controlSubject);
      const exchange = (fields: Record<string, string>) =>
        oauthPost(
          new Request(`${ORIGIN}/token`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: client.clientId, ...fields }),
          }),
          { params: Promise.resolve({ path: ['token'] }) },
        );
      const redemption = (code: string) =>
        exchange({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          redirect_uri: 'https://rotation.example/callback',
        });
      const refreshControl = await exchange({
        grant_type: 'refresh_token',
        refresh_token: pair.refreshToken,
      });
      expect(refreshControl.status).toBe(200);
      const refreshed = (await refreshControl.json()) as {
        access_token: string;
        refresh_token: string;
      };
      const body = { ...initializeBody, params: { ...initializeBody.params, protocolVersion } };
      const init = await POST(mcpRequestForToken(target.plaintext, body), ctx);
      expect(init.status).toBe(200);
      const headers = { 'mcp-protocol-version': protocolVersion };
      const selected = services.projects.create({ slug: `rotation-selected-${protocolVersion}` });
      const selectedCtx = { params: Promise.resolve({ path: [selected.slug] }) };
      async function tool(secret: string, name: string, args: Record<string, unknown>) {
        const response = await POST(
          mcpRequestForToken(
            secret,
            {
              jsonrpc: '2.0',
              id: 9,
              method: 'tools/call',
              params: { name, arguments: args },
            },
            headers,
          ),
          selectedCtx,
        );
        expect(response.status).toBe(200);
        const text = await response.text();
        const payload =
          text
            .split('\n')
            .find((line) => line.startsWith('data:'))
            ?.slice(5)
            .trim() ?? text;
        const result = JSON.parse(payload) as {
          result: { isError?: boolean; content: { text: string }[] };
        };
        expect(result.result.isError).not.toBe(true);
        return JSON.parse(result.result.content[0]?.text ?? '') as Record<string, unknown>;
      }
      expect(await tool(target.plaintext, 'project.current', {})).toMatchObject({
        projectId: selected.id,
      });
      expect((await POST(mcpRequestForToken(pair.accessToken, body), ctx)).status).toBe(200);
      function cookieSource(response: Response) {
        const cookie = response.headers
          .get('set-cookie')
          ?.split(';')[0]
          ?.split('=')
          .slice(1)
          .join('=');
        if (!cookie) throw new Error('fixture: missing login cookie');
        return { get: () => ({ value: decodeURIComponent(cookie) }) };
      }
      const oldCookie = cookieSource(await loginPost(loginRequest(target.plaintext)));
      const controlCookie = cookieSource(await loginPost(loginRequest(adminToken)));
      expect(getSession(oldCookie)).not.toBeNull();
      expect(getSession(controlCookie)).not.toBeNull();

      const rotated = services.tokens.rotate(target.token.id);
      expect(rotated.token.id).toBe(target.token.id);
      expect(
        (
          await POST(
            mcpRequestForToken(
              target.plaintext,
              { jsonrpc: '2.0', id: 8, method: 'tools/list' },
              headers,
            ),
            selectedCtx,
          )
        ).status,
      ).toBe(401);
      expect((await POST(mcpRequestForToken(pair.accessToken, body), ctx)).status).toBe(401);
      expect(
        (await loginPost(loginRequest(target.plaintext))).headers.get('set-cookie'),
      ).toBeNull();
      expect(getSession(oldCookie)).toBeNull();
      expect(getSession(controlCookie)).not.toBeNull();
      expect((await POST(mcpRequestForToken(refreshed.access_token, body), ctx)).status).toBe(401);
      const deniedCode = await redemption(pendingCode);
      expect(deniedCode.status).toBe(400);
      expect(await deniedCode.json()).toMatchObject({ error: 'invalid_grant' });
      const deniedRefresh = await exchange({
        grant_type: 'refresh_token',
        refresh_token: refreshed.refresh_token,
      });
      expect(deniedRefresh.status).toBe(400);
      expect(await deniedRefresh.json()).toMatchObject({ error: 'invalid_grant' });
      expect((await redemption(controlCode)).status).toBe(200);
      expect(
        getSession(cookieSource(await loginPost(loginRequest(rotated.plaintext)))),
      ).not.toBeNull();
      expect(await tool(rotated.plaintext, 'project.current', {})).toMatchObject({
        projectId: selected.id,
        slug: selected.slug,
      });
      expect((await POST(mcpRequestForToken(adminToken, body), ctx)).status).toBe(200);
    },
  );

  it('sets Secure on the session cookie for an HTTPS deployment', async () => {
    const res = await loginPost(loginRequest(adminToken));
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('rembric_session=');
    expect(setCookie).toMatch(/;\s*Secure/i);
    expect(setCookie).toMatch(/HttpOnly/i);
  });

  it('returns an identical refusal for a valid-non-admin vs an invalid login token', async () => {
    const tokensSvc = new TokensService(createRepositories(services.db.db), services.db.db);
    const nonAdmin = tokensSvc.create({ name: 'ro-login', scope: 'read:*' });

    const validNonAdmin = await loginPost(loginRequest(nonAdmin.plaintext));
    const invalid = await loginPost(loginRequest('definitely-not-a-real-token-value'));

    expect(validNonAdmin.status).toBe(302);
    expect(invalid.status).toBe(302);
    expect(validNonAdmin.headers.get('location')).toBe(invalid.headers.get('location'));
    expect(await validNonAdmin.text()).toBe(await invalid.text());
  });

  describe('repository fingerprint header and unbound mode', () => {
    const FP = 'c3'.repeat(20);
    const FP_SHA256 = 'd4'.repeat(32);
    const HEADER = 'x-rembric-repo-fingerprint';
    const pathless = { params: Promise.resolve({}) };
    const at = (slug: string) => ({ params: Promise.resolve({ path: [slug] }) });

    let shop: { id: string; slug: string };
    let sandbox: { id: string; slug: string };
    let secret: { id: string; slug: string };
    let archived: { id: string; slug: string };
    let bothWriter: string;
    let shopWriter: string;
    let defaultId: string;

    beforeAll(() => {
      shop = services.projects.create({ slug: 'fp-shop' });
      sandbox = services.projects.create({ slug: 'fp-sandbox' });
      secret = services.projects.create({ slug: 'fp-secret' });
      archived = services.projects.create({ slug: 'fp-archived' });
      services.projects.archive(archived.id);
      defaultId = services.projects.getDefault().id;
      bothWriter = services.tokens.create({
        name: 'fp-both-writer',
        projects: [
          services.projects.getById(shop.id)!,
          services.projects.getById(sandbox.id)!,
          services.projects.getById(defaultId)!,
        ],
        access: 'write',
      }).plaintext;
      shopWriter = services.tokens.create({
        name: 'fp-shop-writer',
        project: services.projects.getById(shop.id)!,
        access: 'write',
      }).plaintext;
    });

    interface ToolResult {
      status: number;
      isError: boolean;
      body: Record<string, unknown>;
      error?: { code: number; message: string };
    }

    async function callTool(
      name: string,
      args: Record<string, unknown>,
      opts: { token?: string; headers?: Record<string, string>; ctx?: RouteContext } = {},
    ): Promise<ToolResult> {
      const res = await POST(
        mcpRequestForToken(
          opts.token ?? adminToken,
          { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } },
          opts.headers ?? {},
        ),
        opts.ctx ?? pathless,
      );
      const text = await res.text();
      if (res.status !== 200) {
        return {
          status: res.status,
          isError: true,
          body: JSON.parse(text) as Record<string, unknown>,
        };
      }
      const payload = text.startsWith('{')
        ? text
        : (text
            .split('\n')
            .find((line) => line.startsWith('data: '))
            ?.slice('data: '.length) ?? '');
      const parsed = JSON.parse(payload) as {
        result?: { isError?: boolean; content: { text: string }[] };
        error?: { code: number; message: string };
      };
      if (parsed.error) return { status: 200, isError: true, body: {}, error: parsed.error };
      return {
        status: 200,
        isError: parsed.result?.isError === true,
        body: parseToolText(parsed.result?.content[0]?.text ?? '{}'),
      };
    }

    function parseToolText(text: string): Record<string, unknown> {
      try {
        return JSON.parse(text) as Record<string, unknown>;
      } catch {
        return { text };
      }
    }

    function rowCounts(): { memory: number; sessions: number } {
      const count = (table: string) =>
        (services.db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      return { memory: count('memory'), sessions: count('sessions') };
    }

    function bindings(fingerprint: string): string[] {
      return services.repos.repositoryBindings
        .unsafeListAllForFingerprint(fingerprint)
        .map((b) => b.slug);
    }

    const SAVE = { type: 'project', title: 'fp save', content: 'fp save body', tags: ['fp-test'] };
    const UNBOUND_CALLS: [string, Record<string, unknown>][] = [
      ['memory.save', SAVE],
      ['memory.search', { query: 'fp' }],
      ['memory.context', {}],
      ['memory.session_start', { agent: 'fp-test' }],
    ];

    describe('header validation', () => {
      const malformed = [
        'ABC,def',
        'A'.repeat(40),
        'a'.repeat(39),
        'a'.repeat(41),
        `${FP}, ${FP}`,
        'Unavailable',
        `x${FP}`,
        '',
      ];

      it.each(malformed)('refuses %j with 400 before any tool runs', async (value) => {
        const before = rowCounts();
        const r = await callTool('memory.save', SAVE, {
          headers: { [HEADER]: value },
          ctx: at(shop.slug),
        });
        expect(r.status).toBe(400);
        expect(r.body).toMatchObject({ ok: false, code: 'invalid_repository_fingerprint' });
        expect(rowCounts()).toEqual(before);
      });

      it('refuses two header instances', async () => {
        const headers = new Headers({
          authorization: `Bearer ${adminToken}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        });
        headers.append(HEADER, FP);
        headers.append(HEADER, FP);
        const res = await POST(
          new Request(`${ORIGIN}/mcp`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
          }),
          pathless,
        );
        expect(res.status).toBe(400);
      });

      it.each([FP, FP_SHA256, 'unavailable'])(
        'control: %s is accepted and a path-scoped save lands in the URL project',
        async (value) => {
          const r = await callTool('memory.save', SAVE, {
            headers: { [HEADER]: value },
            ctx: at(shop.slug),
          });
          expect(r.isError).toBe(false);
          const row = services.db.raw
            .prepare('SELECT project_id FROM memory WHERE id = ?')
            .get(r.body['id']) as { project_id: string };
          expect(row.project_id).toBe(shop.id);
        },
      );
    });

    describe('an unbound request', () => {
      it.each(UNBOUND_CALLS)(
        'refuses %s with project_unbound and writes nothing',
        async (name, args) => {
          const before = rowCounts();
          const r = await callTool(name, args, { headers: { [HEADER]: FP } });
          expect(r.isError).toBe(true);
          expect(r.body['code']).toBe('project_unbound');
          expect(rowCounts()).toEqual(before);
        },
      );

      it.each(UNBOUND_CALLS)(
        'control: %s without the header serves the default project',
        async (name, args) => {
          const r = await callTool(name, args);
          expect(r.isError).toBe(false);
        },
      );

      it('control: a path-less save without the header lands in the default project', async () => {
        const r = await callTool('memory.save', SAVE);
        const row = services.db.raw
          .prepare('SELECT project_id FROM memory WHERE id = ?')
          .get(r.body['id']) as { project_id: string };
        expect(row.project_id).toBe(defaultId);
      });

      async function initializeInstructions(headers: Record<string, string>): Promise<string> {
        const res = await POST(
          mcpRequestForToken(
            adminToken,
            {
              jsonrpc: '2.0',
              id: 1,
              method: 'initialize',
              params: {
                protocolVersion: '2025-06-18',
                capabilities: {},
                clientInfo: { name: 'instructions-probe', version: '0' },
              },
            },
            headers,
          ),
          pathless,
        );
        expect(res.status).toBe(200);
        const text = await res.text();
        const payload = text.startsWith('{')
          ? text
          : (text
              .split('\n')
              .find((line) => line.startsWith('data: '))
              ?.slice('data: '.length) ?? '');
        return (JSON.parse(payload) as { result: { instructions: string } }).result.instructions;
      }

      it('initialize instructions say no project is selected instead of naming the default project', async () => {
        const unbound = await initializeInstructions({ [HEADER]: FP });
        expect(unbound).toContain('No project selected');
        expect(unbound).toContain('project_unbound');
        expect(unbound).not.toContain('default project');
        expect(unbound).toContain('memory.session_summary');
      });

      it('control: path-less initialize instructions without the header name the default project', async () => {
        const plain = await initializeInstructions({});
        expect(plain).toContain('Project always active: the default project');
        expect(plain).not.toContain('No project selected');
      });

      it('still answers project.list and project.current, reporting source unbound', async () => {
        const list = await callTool('project.list', {}, { headers: { [HEADER]: FP } });
        expect(list.isError).toBe(false);
        const current = await callTool('project.current', {}, { headers: { [HEADER]: FP } });
        expect(current.isError).toBe(false);
        expect(current.body).toEqual({
          slug: null,
          projectId: null,
          source: 'unbound',
          repository: { fingerprint: FP, boundSlugs: [], conflict: false },
        });
      });

      it('is unbound even when the fingerprint is bound: the header never selects a project', async () => {
        const fp = 'e5'.repeat(20);
        services.repositoryBindings.bind({
          fingerprint: fp,
          projectId: shop.id,
          createdBy: 'test',
        });
        const r = await callTool('memory.search', { query: 'fp' }, { headers: { [HEADER]: fp } });
        expect(r.body['code']).toBe('project_unbound');
      });

      it('treats unavailable as unbound and names its causes and remedies', async () => {
        const r = await callTool('memory.save', SAVE, { headers: { [HEADER]: 'unavailable' } });
        expect(r.body['code']).toBe('project_unbound');
        expect(String(r.body['message'])).toMatch(/shallow clone/);
        expect(String(r.body['message'])).toContain('.rembric');
        expect(String(r.body['message'])).not.toContain('project.bind_repository');
        const current = await callTool(
          'project.current',
          {},
          {
            headers: { [HEADER]: 'unavailable' },
          },
        );
        expect(current.body['repository']).toEqual({
          fingerprint: null,
          boundSlugs: [],
          conflict: false,
        });
      });

      it('names only remedies the token can perform', async () => {
        const admin = await callTool('memory.save', SAVE, { headers: { [HEADER]: FP } });
        expect(String(admin.body['message'])).toContain('project.bind_repository');
        expect(String(admin.body['message'])).toContain('dashboard');
        expect(String(admin.body['message'])).toContain(FP.slice(0, 12));
        const writer = await callTool('memory.save', SAVE, {
          token: bothWriter,
          headers: { [HEADER]: FP },
        });
        expect(writer.body['code']).toBe('project_unbound');
        expect(String(writer.body['message'])).not.toContain('project.bind_repository');
        expect(String(writer.body['message'])).toContain('dashboard');
        expect(String(writer.body['message'])).toContain('.rembric');
      });
    });

    describe('path-scoped requests are unchanged by the header', () => {
      it('an unknown slug is still project_not_found, not unbound', async () => {
        const r = await callTool(
          'memory.search',
          { query: 'fp' },
          {
            headers: { [HEADER]: FP },
            ctx: at('fp-no-such-project'),
          },
        );
        expect(r.body['code']).toBe('project_not_found');
        const control = await callTool(
          'memory.search',
          { query: 'fp' },
          {
            ctx: at('fp-no-such-project'),
          },
        );
        expect(control.body['code']).toBe('project_not_found');
      });

      it('project.current reports an explicit selection that overrides a binding', async () => {
        const fp = 'f6'.repeat(20);
        services.repositoryBindings.bind({
          fingerprint: fp,
          projectId: shop.id,
          createdBy: 'test',
        });
        const r = await callTool(
          'project.current',
          {},
          {
            token: bothWriter,
            headers: { [HEADER]: fp },
            ctx: at(sandbox.slug),
          },
        );
        expect(r.body).toEqual({
          slug: sandbox.slug,
          projectId: sandbox.id,
          source: 'url-path',
          repository: { fingerprint: fp, boundSlugs: [shop.slug], conflict: true },
        });
        const agreeing = await callTool(
          'project.current',
          {},
          {
            token: bothWriter,
            headers: { [HEADER]: fp },
            ctx: at(shop.slug),
          },
        );
        expect(agreeing.body['repository']).toEqual({
          fingerprint: fp,
          boundSlugs: [shop.slug],
          conflict: false,
        });
        const save = await callTool('memory.save', SAVE, {
          token: bothWriter,
          headers: { [HEADER]: fp },
          ctx: at(sandbox.slug),
        });
        const row = services.db.raw
          .prepare('SELECT project_id FROM memory WHERE id = ?')
          .get(save.body['id']) as { project_id: string };
        expect(row.project_id).toBe(sandbox.id);
      });

      it('project.current does not reveal a binding the token cannot read', async () => {
        const fp = '07'.repeat(20);
        services.repositoryBindings.bind({
          fingerprint: fp,
          projectId: secret.id,
          createdBy: 'test',
        });
        const r = await callTool(
          'project.current',
          {},
          {
            token: shopWriter,
            headers: { [HEADER]: fp },
            ctx: at(shop.slug),
          },
        );
        expect(r.body['repository']).toEqual({ fingerprint: fp, boundSlugs: [], conflict: false });
        const admin = await callTool(
          'project.current',
          {},
          {
            headers: { [HEADER]: fp },
            ctx: at(shop.slug),
          },
        );
        expect(admin.body['repository']).toEqual({
          fingerprint: fp,
          boundSlugs: [secret.slug],
          conflict: true,
        });
      });

      it('project.current carries no repository field without the header', async () => {
        const r = await callTool('project.current', {}, { ctx: at(shop.slug) });
        expect(r.body).toEqual({ slug: shop.slug, projectId: shop.id, source: 'url-path' });
        const pathlessCurrent = await callTool('project.current', {});
        expect(pathlessCurrent.body).toMatchObject({ projectId: defaultId, source: 'default' });
        expect(pathlessCurrent.body).not.toHaveProperty('repository');
      });
    });

    describe('project.bind_repository', () => {
      it('an admin binds an unbound repository from an unbound session', async () => {
        const fp = '18'.repeat(20);
        const resolved = services.repositoryBindings.resolve(
          { tokenId: 'fp-t', scope: 'projects', memberProjectIds: [shop.id] },
          { fingerprint: fp, remotes: ['github.com/acme/fp-shop'] },
        );
        expect(resolved).toEqual({ outcome: 'unbound', reason: 'not_bound' });
        const r = await callTool(
          'project.bind_repository',
          { slug: shop.slug },
          {
            headers: { [HEADER]: fp },
          },
        );
        expect(r.isError).toBe(false);
        expect(r.body).toMatchObject({ slug: shop.slug, fingerprint: fp });
        expect(String(r.body['message'])).toContain('next session');
        expect(bindings(fp)).toEqual([shop.slug]);
        expect(
          services.repos.pendingRepositories.findByIdentity(fp, 'unbound', null),
        ).toBeUndefined();
        expect(
          services.repos.repositoryBindings.unsafeListAllForFingerprint(fp)[0]?.remotes,
        ).toEqual(['github.com/acme/fp-shop']);
        const after = await callTool('memory.save', SAVE, { headers: { [HEADER]: fp } });
        expect(after.body['code']).toBe('project_unbound');
        expect(
          services.repositoryBindings.resolve(
            { tokenId: 'fp-t', scope: 'projects', memberProjectIds: [shop.id] },
            { fingerprint: fp, remotes: [] },
          ),
        ).toEqual({ outcome: 'bound', slug: shop.slug });
      });

      it('a non-admin token cannot bind, even with every other condition met', async () => {
        const fp = '29'.repeat(20);
        const r = await callTool(
          'project.bind_repository',
          { slug: shop.slug },
          {
            token: shopWriter,
            headers: { [HEADER]: fp },
            ctx: at(shop.slug),
          },
        );
        expect(r.body['code']).toBe('admin_token_required');
        expect(bindings(fp)).toEqual([]);
        const noHeader = await callTool(
          'project.bind_repository',
          { slug: 'fp-nope' },
          {
            token: shopWriter,
          },
        );
        expect(noHeader.body['code']).toBe('admin_token_required');
      });

      it('refuses without a fingerprint before looking at the project', async () => {
        const missing = await callTool('project.bind_repository', { slug: 'fp-nope' });
        expect(missing.body['code']).toBe('repository_fingerprint_unavailable');
        const unavailable = await callTool(
          'project.bind_repository',
          { slug: shop.slug },
          {
            headers: { [HEADER]: 'unavailable' },
          },
        );
        expect(unavailable.body['code']).toBe('repository_fingerprint_unavailable');
      });

      it('refuses an unknown or archived project before the binding check', async () => {
        const fp = '3a'.repeat(20);
        services.repositoryBindings.bind({
          fingerprint: fp,
          projectId: shop.id,
          createdBy: 'test',
        });
        const unknown = await callTool(
          'project.bind_repository',
          { slug: 'fp-nope' },
          {
            headers: { [HEADER]: fp },
          },
        );
        expect(unknown.body['code']).toBe('project_not_found');
        const gone = await callTool(
          'project.bind_repository',
          { slug: archived.slug },
          {
            headers: { [HEADER]: fp },
          },
        );
        expect(gone.body['code']).toBe('project_archived');
      });

      it('a bound repository is not moved by the tool', async () => {
        const fp = '4b'.repeat(20);
        services.repositoryBindings.bind({
          fingerprint: fp,
          projectId: shop.id,
          createdBy: 'test',
        });
        const r = await callTool(
          'project.bind_repository',
          { slug: sandbox.slug },
          {
            headers: { [HEADER]: fp },
          },
        );
        expect(r.body['code']).toBe('repository_already_bound');
        expect(String(r.body['message'])).toContain(shop.slug);
        expect(String(r.body['message'])).toContain('dashboard');
        expect(bindings(fp)).toEqual([shop.slug]);
      });

      it('the fingerprint cannot come from the model', async () => {
        const fp = '5c'.repeat(20);
        const r = await callTool(
          'project.bind_repository',
          { slug: shop.slug, fingerprint: fp },
          {
            headers: { [HEADER]: FP_SHA256 },
          },
        );
        expect(r.isError).toBe(true);
        expect(JSON.stringify(r)).toMatch(/fingerprint/);
        expect(bindings(fp)).toEqual([]);
        expect(bindings(FP_SHA256)).toEqual([]);
      });
    });
  });
});

describe('the enforced description cap is published in mcp-api', () => {
  it(`states ${DESCRIPTION_MAX_LENGTH} in the live spec or a pending delta`, () => {
    const openspecDir = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      '..',
      'openspec',
    );
    const changesDir = join(openspecDir, 'changes');
    const candidates = [join(openspecDir, 'specs', 'mcp-api', 'spec.md')];
    for (const entry of readdirSync(changesDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'archive') {
        candidates.push(join(changesDir, entry.name, 'specs', 'mcp-api', 'spec.md'));
      }
    }

    const digits = String(DESCRIPTION_MAX_LENGTH);
    const withSeparator =
      digits.length > 3 ? `${digits.slice(0, -3)},?${digits.slice(-3)}` : digits;
    const pattern = new RegExp(`DESCRIPTION_MAX_LENGTH[^\\n]*?\\b${withSeparator}\\b`);
    const published = candidates
      .filter((p) => existsSync(p))
      .some((p) => pattern.test(readFileSync(p, 'utf8')));

    expect(
      published,
      `no mcp-api requirement names DESCRIPTION_MAX_LENGTH with the value ${DESCRIPTION_MAX_LENGTH}`,
    ).toBe(true);
  });
});
