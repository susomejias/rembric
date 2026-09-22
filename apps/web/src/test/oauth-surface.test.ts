import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  deriveOAuthAreqKey,
  deriveSessionKey,
  SessionsService,
  signAuthRequest,
  TokensService,
  verifyAuthRequest,
} from '@rembric/core';
import { createDb, createRepositories, type DashboardSession, type DbHandle } from '@rembric/db';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  GET as routeGet,
  OPTIONS as routeOptions,
  POST as routePost,
} from '../app/(oauth)/[...path]/route';
import { POST as consentPost } from '../app/dashboard/oauth/consent/route';
import { getOAuthProvider, rateLimitIdentity } from '../lib/oauth';
import { getServices } from '../lib/services';

const ADMIN_TOKEN = 'web-oauth-surface-admin-token-long-enough';
const ISSUER = 'http://127.0.0.1:3100';
const CONSENT_PATH = '/dashboard/oauth/consent';
const REDIRECT = 'https://client.example/callback';
const CONSENT_FORM = 'oauth.consent';

interface Fixture {
  dataDir: string;
  handle: DbHandle;
  sessions: SessionsService;
  admin: { id: string; cookie: string; session: DashboardSession };
  cleanup: () => void;
}

let fixture: Fixture;

beforeAll(() => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rembric-web-oauth-'));
  const handle = createDb({ dataDir, onMigrationProgress: () => {}, onStartupLog: () => {} });
  const repos = createRepositories(handle.db);
  const tokens = new TokensService(repos, handle.db);
  tokens.bootstrapAdmin(ADMIN_TOKEN);
  const adminRow = repos.tokens.findByName('admin');
  if (adminRow === undefined) throw new Error('fixture: admin token was not bootstrapped');
  const sessions = new SessionsService(
    { dashboardSessions: repos.dashboardSessions },
    deriveSessionKey(ADMIN_TOKEN),
  );
  const admin = sessions.create(adminRow.id);

  fixture = {
    dataDir,
    handle,
    sessions,
    admin: { id: adminRow.id, cookie: admin.cookie, session: admin.session },
    cleanup: () => {
      try {
        handle.close();
      } catch {}
      rmSync(dataDir, { recursive: true, force: true });
    },
  };

  process.env['REMBRIC_DATA_DIR'] = dataDir;
  process.env['REMBRIC_ADMIN_TOKEN'] = ADMIN_TOKEN;
  delete process.env['REMBRIC_SESSION_SECRET'];
  process.env['REMBRIC_PUBLIC_URL'] = ISSUER;
});

afterAll(() => {
  fixture.cleanup();
  delete process.env['REMBRIC_DATA_DIR'];
  delete process.env['REMBRIC_ADMIN_TOKEN'];
  delete process.env['REMBRIC_PUBLIC_URL'];
});

type RouteContext = { params: Promise<{ path?: string[] }> };

function context(...path: string[]): RouteContext {
  return { params: Promise.resolve({ path }) };
}

function get(path: string, init?: RequestInit): Request {
  return new Request(`${ISSUER}${path}`, init);
}

function jsonPost(path: string, payload: unknown): Request {
  return new Request(`${ISSUER}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function formPost(path: string, fields: Record<string, string>): Request {
  return new Request(`${ISSUER}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  scope: string;
  expires_in: number;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

let registered: string | null = null;

async function clientId(): Promise<string> {
  if (registered !== null) return registered;
  const response = await routePost(
    jsonPost('/register', { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
    context('register'),
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { client_id: string };
  expect(body.client_id).toMatch(/^oauthc_/);
  registered = body.client_id;
  return registered;
}

async function authorize(query: Record<string, string>): Promise<URL> {
  const response = await routeGet(
    get(`/authorize?${new URLSearchParams(query).toString()}`),
    context('authorize'),
  );
  expect(response.status).toBe(302);
  const location = response.headers.get('location');
  if (location === null) throw new Error('fixture: /authorize did not redirect');
  return new URL(location);
}

function consentRequest(fields: Record<string, string>): NextRequest {
  return new NextRequest(`${ISSUER}${CONSENT_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `${SessionsService.cookieName()}=${fixture.admin.cookie}`,
    },
    body: new URLSearchParams(fields),
  });
}

function consentCsrf(): string {
  return fixture.sessions.csrfToken(fixture.admin.session, CONSENT_FORM);
}

async function approve(blob: string): Promise<URL> {
  const response = await consentPost(
    consentRequest({ csrf: consentCsrf(), areq: blob, decision: 'approve' }),
  );
  expect(response.status).toBe(302);
  const location = response.headers.get('location');
  if (location === null) throw new Error('fixture: consent did not redirect');
  return new URL(location);
}

async function exchange(fields: Record<string, string>): Promise<Response> {
  return routePost(formPost('/token', fields), context('token'));
}

describe('authorization-server metadata', () => {
  it('publishes RFC 8414 metadata for the public issuer, S256 only', async () => {
    const response = await routeGet(
      get('/.well-known/oauth-authorization-server'),
      context('.well-known', 'oauth-authorization-server'),
    );

    expect(response.status).toBe(200);
    const metadata = (await response.json()) as Record<string, unknown>;
    expect(metadata.issuer).toBe(`${ISSUER}/`);
    expect(metadata.authorization_endpoint).toBe(`${ISSUER}/authorize`);
    expect(metadata.token_endpoint).toBe(`${ISSUER}/token`);
    expect(metadata.registration_endpoint).toBe(`${ISSUER}/register`);
    expect(metadata.revocation_endpoint).toBe(`${ISSUER}/revoke`);
    expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
    expect(metadata.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(metadata.scopes_supported).toEqual(['mcp', 'read']);
  });

  it('advertises the protected resource and its authorization server (RFC 9728)', async () => {
    const response = await routeGet(
      get('/.well-known/oauth-protected-resource'),
      context('.well-known', 'oauth-protected-resource'),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      resource: `${ISSUER}/`,
      authorization_servers: [`${ISSUER}/`],
      resource_name: 'Rembric',
    });
  });

  it('answers a CORS preflight for a web-based MCP client with 204', async () => {
    const response = await routeOptions(
      get('/token', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://client.example',
          'access-control-request-method': 'POST',
        },
      }),
      context('token'),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('rate limit identity', () => {
  function requestWithHop(hop: string): Request {
    return get('/token', { headers: { 'x-forwarded-for': hop } });
  }

  it('adopts a well-formed forwarded hop, and only a well-formed one', () => {
    expect(rateLimitIdentity(requestWithHop('203.0.113.7'))).toBe('203.0.113.7');
    expect(rateLimitIdentity(requestWithHop('203.0.113.7, 10.0.0.1'))).toBe('203.0.113.7');
    expect(rateLimitIdentity(requestWithHop('::1'))).toBe('::1');

    expect(rateLimitIdentity(requestWithHop('not-an-address'))).toBe('0.0.0.0');
    expect(rateLimitIdentity(get('/token'))).toBe('0.0.0.0');
  });

  it('serves a request carrying an unparseable hop instead of failing on it', async () => {
    const response = await routePost(
      new Request(`${ISSUER}/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-forwarded-for': 'not-an-address',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'not-a-code',
          code_verifier: 'verifier',
          client_id: 'oauthc_missing',
        }).toString(),
      }),
      context('token'),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_client' });
  });
});

describe('client registration and the consent dance', () => {
  it('registers, authorizes, consents, exchanges the code and verifies the token', async () => {
    const id = await clientId();
    const { verifier, challenge } = pkce();

    const consentUrl = await authorize({
      client_id: id,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'mcp',
      state: 'state-abc',
    });

    expect(`${consentUrl.origin}${consentUrl.pathname}`).toBe(`${ISSUER}${CONSENT_PATH}`);
    const blob = consentUrl.searchParams.get('areq');
    if (blob === null) throw new Error('fixture: no areq in the consent URL');

    const areq = verifyAuthRequest(blob, deriveOAuthAreqKey(ADMIN_TOKEN), Date.now());
    expect(areq).toMatchObject({
      clientId: id,
      redirectUri: REDIRECT,
      codeChallenge: challenge,
      scope: 'mcp',
      state: 'state-abc',
    });
    expect(areq?.exp ?? 0).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const granted = await approve(blob);
    expect(`${granted.origin}${granted.pathname}`).toBe(REDIRECT);
    expect(granted.searchParams.get('state')).toBe('state-abc');
    const code = granted.searchParams.get('code');
    if (code === null) throw new Error('fixture: consent issued no code');

    const response = await exchange({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: id,
    });
    expect(response.status).toBe(200);
    const tokens = (await response.json()) as TokenResponse;
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.scope).toBe('mcp');
    expect(tokens.refresh_token).toBeTruthy();

    const info = await getOAuthProvider()?.verifyAccessToken(tokens.access_token);
    expect(info).toMatchObject({ token: tokens.access_token, clientId: id, scopes: ['*'] });
    expect(info?.expiresAt ?? 0).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(getServices().oauth?.authenticateAccessToken(tokens.access_token)?.scope).toBe('*');

    const replay = await exchange({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: id,
    });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('binds the grant to the project the RFC 8707 resource names', async () => {
    const id = await clientId();
    const project = getServices().projects.create({ slug: 'oauth-resource', displayName: null });
    const { verifier, challenge } = pkce();

    const consentUrl = await authorize({
      client_id: id,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'read',
      resource: `${ISSUER}/mcp/oauth-resource`,
    });
    const blob = consentUrl.searchParams.get('areq') ?? '';
    expect(verifyAuthRequest(blob, deriveOAuthAreqKey(ADMIN_TOKEN), Date.now())?.projectId).toBe(
      project.id,
    );

    const granted = await approve(blob);
    const code = granted.searchParams.get('code') ?? '';
    const tokens = (await (
      await exchange({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: id,
      })
    ).json()) as TokenResponse;

    expect(tokens.scope).toBe('read');
    expect(getServices().oauth?.authenticateAccessToken(tokens.access_token)).toMatchObject({
      clientId: id,
      projectId: project.id,
      scope: `read:project:${project.id}`,
    });
  });

  it('rotates the refresh token into a new access token', async () => {
    const id = await clientId();
    const { verifier, challenge } = pkce();
    const consentUrl = await authorize({
      client_id: id,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const blob = consentUrl.searchParams.get('areq') ?? '';
    const granted = await approve(blob);
    const code = granted.searchParams.get('code') ?? '';

    const first = (await (
      await exchange({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: id,
      })
    ).json()) as TokenResponse;

    const refreshed = await exchange({
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: id,
    });
    expect(refreshed.status).toBe(200);
    const rotated = (await refreshed.json()) as TokenResponse;
    expect(rotated.access_token).toBeTruthy();
    expect(rotated.access_token).not.toBe(first.access_token);
    expect(getServices().oauth?.authenticateAccessToken(rotated.access_token)?.clientId).toBe(id);
  });

  it('revokes the token family, after which the access token is refused', async () => {
    const id = await clientId();
    const { verifier, challenge } = pkce();
    const consentUrl = await authorize({
      client_id: id,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const granted = await approve(consentUrl.searchParams.get('areq') ?? '');
    const code = granted.searchParams.get('code') ?? '';

    const tokens = (await (
      await exchange({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: id,
      })
    ).json()) as TokenResponse;

    const revoke = await routePost(
      formPost('/revoke', { token: tokens.access_token, client_id: id }),
      context('revoke'),
    );
    expect(revoke.status).toBe(200);
    expect(await revoke.json()).toEqual({});
    expect(getServices().oauth?.authenticateAccessToken(tokens.access_token)).toBeNull();
  });
});

describe('error branches', () => {
  it('refuses an unregistered client at /authorize without redirecting', async () => {
    const response = await routeGet(
      get(
        `/authorize?${new URLSearchParams({
          client_id: 'oauthc_not-registered',
          redirect_uri: REDIRECT,
          response_type: 'code',
          code_challenge: 'challenge',
          code_challenge_method: 'S256',
        }).toString()}`,
      ),
      context('authorize'),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_client' });
  });

  it('refuses an unregistered client at /token', async () => {
    const response = await exchange({
      grant_type: 'authorization_code',
      code: 'not-a-code',
      code_verifier: 'verifier',
      redirect_uri: REDIRECT,
      client_id: 'oauthc_not-registered',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_client' });
  });

  it('refuses a mismatched PKCE verifier', async () => {
    const id = await clientId();
    const { challenge } = pkce();
    const consentUrl = await authorize({
      client_id: id,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const granted = await approve(consentUrl.searchParams.get('areq') ?? '');
    const code = granted.searchParams.get('code') ?? '';

    const response = await exchange({
      grant_type: 'authorization_code',
      code,
      code_verifier: randomBytes(32).toString('base64url'),
      redirect_uri: REDIRECT,
      client_id: id,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('answers 405 with Allow for a method the endpoint does not support', async () => {
    const response = await routeGet(get('/token'), context('token'));

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('refuses an expired authorization request at the consent step', async () => {
    const stale = signAuthRequest(
      {
        clientId: 'oauthc_whatever',
        redirectUri: REDIRECT,
        codeChallenge: 'challenge',
        scope: 'mcp',
        state: 'state-abc',
        exp: Math.floor(Date.now() / 1000) - 60,
      },
      deriveOAuthAreqKey(ADMIN_TOKEN),
    );

    const response = await consentPost(
      consentRequest({ csrf: consentCsrf(), areq: stale, decision: 'approve' }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, code: 'invalid_request' });
  });
});

describe('mount scope', () => {
  it('leaves every path outside the authorization-server surface to the app 404', async () => {
    await expect(
      routeGet(get('/dashboard/not-a-page'), context('dashboard', 'not-a-page')),
    ).rejects.toThrow('404');
  });

  it('serves the not-found body when the authorization server is disabled', async () => {
    const publicUrl = process.env['REMBRIC_PUBLIC_URL'];
    vi.stubGlobal('__rembricOAuthProvider', undefined);
    vi.stubGlobal('__rembricOAuthRouter', undefined);
    delete process.env['REMBRIC_PUBLIC_URL'];

    try {
      const response = await routeGet(get('/token'), context('token'));
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ ok: false, code: 'not_found', path: '/token' });
    } finally {
      process.env['REMBRIC_PUBLIC_URL'] = publicUrl;
      vi.unstubAllGlobals();
    }
  });
});
