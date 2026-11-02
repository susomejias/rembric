import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TokensService, type TokenPair } from '@rembric/core';
import { createRepositories } from '@rembric/db';
import { DESCRIPTION_MAX_LENGTH } from '@rembric/mcp';
import { NextRequest } from 'next/server';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { POST as oauthPost } from '../app/(oauth)/[...path]/route';
import { POST as loginPost } from '../app/dashboard/login/verify/route';
import { DELETE, POST } from '../app/mcp/[[...path]]/route';
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
  __rembricSessionRouter?: unknown;
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
  delete globalForApp.__rembricSessionRouter;
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

  const ctx = { params: Promise.resolve({}) };

  it('refuses an unknown mcp-session-id with 404/-32001 before constructing anything', async () => {
    const res = await POST(
      mcpRequest(
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { 'mcp-session-id': 'no-such-session-id' },
      ),
      ctx,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: number } };
    expect(body.error?.code).toBe(-32001);
  });

  it('control: a live mcp-session-id from a real initialize is unaffected', async () => {
    const init = await POST(
      mcpRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'c', version: '0' },
        },
      }),
      ctx,
    );
    expect(init.status).toBe(200);
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    const list = await POST(
      mcpRequest(
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { 'mcp-session-id': sessionId ?? '' },
      ),
      ctx,
    );
    expect(list.status).toBe(200);
  });

  it('tears a live session down on DELETE, after which the session id is unknown', async () => {
    const init = await POST(
      mcpRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'c', version: '0' },
        },
      }),
      ctx,
    );
    const sessionId = init.headers.get('mcp-session-id');
    if (sessionId === null) throw new Error('fixture: initialize did not establish a session');

    const deleted = await DELETE(
      mcpRequest(undefined, { 'mcp-session-id': sessionId }, 'DELETE'),
      ctx,
    );
    expect(deleted.status).toBeLessThan(300);

    const after = await POST(
      mcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-session-id': sessionId }),
      ctx,
    );
    expect(after.status).toBe(404);
    expect(((await after.json()) as { error?: { code?: number } }).error?.code).toBe(-32001);
  });

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

  describe('body cap and DNS-rebinding gates', () => {
    for (const key of [
      'MAX_BODY_BYTES',
      'REMBRIC_MCP_ALLOWED_HOSTS',
      'REMBRIC_MCP_ALLOWED_ORIGINS',
    ]) {
      afterEach(() => delete process.env[key]);
    }

    it('refuses a body over MAX_BODY_BYTES with 413, in the server’s exact shape', async () => {
      process.env['MAX_BODY_BYTES'] = '1024';
      const res = await POST(mcpRequest({ ...initializeBody, pad: 'x'.repeat(4096) }), ctx);
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({
        ok: false,
        code: 'payload_too_large',
        message: 'request body exceeds the 1024-byte limit',
      });
    });

    it('control: a body under the same cap still reaches the transport', async () => {
      process.env['MAX_BODY_BYTES'] = '1024';
      const res = await POST(mcpRequest(initializeBody), ctx);
      expect(res.status).toBe(200);
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
        error: { code: -32000, message: 'Invalid Origin header: https://evil.example' },
        id: null,
      });

      const allowed = await POST(
        mcpRequest(initializeBody, { origin: 'https://allowed.example' }),
        ctx,
      );
      expect(allowed.status).toBe(200);
    });

    it('refuses a rebinding Host with the SDK’s 403 body, and passes an allowed one', async () => {
      process.env['REMBRIC_MCP_ALLOWED_HOSTS'] = 'rembric.example.com:443';

      const denied = await POST(mcpRequest(initializeBody, { host: '127.0.0.1:8787' }), ctx);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Invalid Host header: 127.0.0.1:8787' },
        id: null,
      });

      process.env['REMBRIC_MCP_ALLOWED_HOSTS'] = '127.0.0.1:8787';
      const allowed = await POST(mcpRequest(initializeBody, { host: '127.0.0.1:8787' }), ctx);
      expect(allowed.status).toBe(200);
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
      const sessionId = init.headers.get('mcp-session-id');
      if (!sessionId) throw new Error('fixture: missing MCP session');
      const headers = { 'mcp-session-id': sessionId, 'mcp-protocol-version': protocolVersion };
      const selected = services.projects.create({ slug: `promotion-selected-${protocolVersion}` });
      const pinned = await result(
        await POST(
          mcpRequestForToken(
            target.plaintext,
            {
              jsonrpc: '2.0',
              id: 3,
              method: 'tools/call',
              params: {
                name: 'project.use',
                arguments: { slug: selected.slug, confirmSwitch: true },
              },
            },
            headers,
          ),
          ctx,
        ),
      );
      expect(pinned.result.isError).not.toBe(true);
      expect(JSON.parse(pinned.result.content[0]?.text ?? '')).toMatchObject({
        projectId: selected.id,
      });
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
          ctx,
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
          ctx,
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
      const sessionId = init.headers.get('mcp-session-id');
      if (!sessionId) throw new Error('fixture: missing MCP session');
      const headers = { 'mcp-session-id': sessionId, 'mcp-protocol-version': protocolVersion };
      const selected = services.projects.create({ slug: `rotation-selected-${protocolVersion}` });
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
          ctx,
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
      expect(
        await tool(target.plaintext, 'project.use', { slug: selected.slug, confirmSwitch: true }),
      ).toMatchObject({ projectId: selected.id });
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
            ctx,
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
