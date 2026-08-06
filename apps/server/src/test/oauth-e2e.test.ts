import { createHash, randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type BootstrappedServer, createServer } from '../server/index.js';

import { createTestDb } from './db.js';
import { FakeEmbedder } from './embedder.js';

import { findFreePort } from './index.js';

/**
 * Local OAuth 2.1 end-to-end against a live server (no ChatGPT, no Docker,
 * no browser). Boots the real HTTP surface with OAuth enabled on a loopback
 * issuer and drives the full dance over `fetch`:
 *
 *   register → authorize → dashboard login → consent approve → token
 *   → use the minted access token on /mcp
 *
 * Plus: the static-token path still authenticates /mcp, and an
 * unauthenticated /mcp 401 advertises the protected-resource metadata.
 */

const ADMIN_TOKEN = 'oauth-e2e-admin-token-with-enough-entropy-xyz';
const REDIRECT = 'https://chatgpt.example/callback';

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

describe('OAuth local E2E (live server)', () => {
  let server: BootstrappedServer;
  let base: string;

  beforeAll(async () => {
    const tmp = createTestDb();
    tmp.cleanup();
    const port = await findFreePort();
    base = `http://127.0.0.1:${port}`;
    server = await createServer(
      {
        REMBRIC_HOST: '127.0.0.1',
        REMBRIC_PORT: String(port),
        REMBRIC_DATA_DIR: tmp.dataDir,
        REMBRIC_ADMIN_TOKEN: ADMIN_TOKEN,
        REMBRIC_PUBLIC_URL: base,
        REMBRIC_UPDATE_CHECK: 'off',
      },
      { embedder: new FakeEmbedder() },
    );
  }, 30_000);

  afterAll(async () => {
    await server.shutdown();
  });

  async function mcpStatus(token?: string): Promise<Response> {
    return fetch(`${base}/mcp`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'e2e', version: '0' },
        },
      }),
    });
  }

  it('unauthenticated /mcp returns 401 advertising the protected-resource metadata', async () => {
    const res = await mcpStatus();
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(
      `resource_metadata="${base}/.well-known/oauth-protected-resource"`,
    );
  });

  it('static admin token still authenticates /mcp (not 401)', async () => {
    const res = await mcpStatus(ADMIN_TOKEN);
    expect(res.status).not.toBe(401);
  });

  it('drives the full OAuth dance and the minted access token authenticates /mcp', async () => {
    // 1. Discovery.
    const meta = await fetch(`${base}/.well-known/oauth-authorization-server`);
    expect(meta.status).toBe(200);

    // 2. Dynamic Client Registration.
    const reg = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
    });
    expect(reg.status).toBe(201);
    const { client_id: clientId } = (await reg.json()) as { client_id: string };

    // 3. Authorize → redirect to the dashboard consent screen.
    const { verifier, challenge } = pkce();
    const authUrl =
      `${base}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}` +
      `&code_challenge_method=S256&scope=mcp&state=xyz`;
    const authRes = await fetch(authUrl, { method: 'GET', redirect: 'manual' });
    expect(authRes.status).toBe(302);
    const consentUrl = new URL(authRes.headers.get('location') ?? '');
    expect(consentUrl.pathname).toBe('/dashboard/oauth/consent');
    const areq = consentUrl.searchParams.get('areq')!;
    expect(areq).toBeTruthy();

    // 4. Operator login (dashboard session cookie).
    const login = await fetch(`${base}/dashboard/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: ADMIN_TOKEN }).toString(),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(cookie).toContain('rembric_session=');

    // 5. Load the consent screen, extract the CSRF token.
    const consentPage = await fetch(
      `${base}/dashboard/oauth/consent?areq=${encodeURIComponent(areq)}`,
      {
        headers: { cookie },
      },
    );
    expect(consentPage.status).toBe(200);
    const html = await consentPage.text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
    expect(csrf).toBeTruthy();

    // 6. Approve consent → redirect to the client with an authorization code.
    const approve = await fetch(`${base}/dashboard/oauth/consent`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ areq, decision: 'approve', csrf: csrf! }).toString(),
    });
    expect(approve.status).toBe(302);
    const back = new URL(approve.headers.get('location') ?? '');
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('xyz');
    const code = back.searchParams.get('code')!;
    expect(code).toBeTruthy();

    // 7. Exchange the code for tokens (SDK validates PKCE).
    const tokenRes = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: clientId,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string };
    expect(tokens.access_token).toBeTruthy();

    // 8. The minted access token authenticates /mcp (not 401)...
    const mcp = await mcpStatus(tokens.access_token);
    expect(mcp.status).not.toBe(401);

    // ...and /healthz too — auth is unified across bearer surfaces, not /mcp-only.
    const health = await fetch(`${base}/healthz`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(health.status).toBe(200);

    // 9. Refresh rotates to a new access token.
    const refresh = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: clientId,
      }).toString(),
    });
    expect(refresh.status).toBe(200);
    const rotated = (await refresh.json()) as { access_token: string };
    expect(rotated.access_token).not.toBe(tokens.access_token);
  }, 20_000);
});
