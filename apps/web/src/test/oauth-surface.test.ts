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

/**
 * The OAuth 2.1 authorization-server surface this app now serves: Dynamic
 * Client Registration, the `/authorize` hand-off to the consent screen, the
 * consent decision itself, the PKCE code exchange, refresh rotation and
 * revocation — driven through the route handler, i.e. through the Express
 * router adapter in `lib/oauth.ts`, not around it.
 *
 * The only thing simulated is the browser: the consent step is the real
 * `app/dashboard/oauth/consent/route.ts` POST with a real session cookie and a
 * real CSRF token, exactly as `dashboard-mutations.test.ts` drives it. So the
 * blob the router signs is verified by the same code that verifies it in
 * production, and the code the consent screen mints is the code the token
 * endpoint redeems.
 */

const ADMIN_TOKEN = 'web-oauth-surface-admin-token-long-enough';
/** Loopback http is the RFC 8414 exemption the MCP SDK applies; https is required elsewhere. */
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
      } catch {
        // ignore double-close
      }
      rmSync(dataDir, { recursive: true, force: true });
    },
  };

  // The two variables the app resolves before it may build anything: the data
  // directory its own connection opens, and the session secret `areqKey()`
  // falls through to (deleted so an inherited one cannot derive a different
  // key than this fixture signs with).
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

/** The `/token` success body: this issuer always returns both tokens. */
interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  scope: string;
  expires_in: number;
}

/** PKCE, the way an MCP client generates it. */
function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/**
 * One registered client for the whole file. Registration is the strictest rate
 * limited endpoint (20/hour) and the router's limiter is process-wide, so the
 * cases share one client rather than spending the budget on setup.
 */
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

/** The `/authorize` leg, returning the consent URL the router redirected to. */
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

/** Approve an authorization request through the real consent handler. */
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
    // The issuer is the URL form of REMBRIC_PUBLIC_URL — `new URL(issuer).href`
    // normalises the trailing slash, which is what `apps/server` publishes too.
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

    // 204 is set by `cors` on the response object directly, so a shim that
    // reported its own default status would answer 200 here.
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('rate limit identity', () => {
  // The library validates whatever key it is handed as a real address, and its
  // validation runs once per limiter instance — measured: a second request with
  // a malformed key is accepted silently. So the value is asserted where it is
  // computed rather than through the log it would produce once.
  function requestWithHop(hop: string): Request {
    return get('/token', { headers: { 'x-forwarded-for': hop } });
  }

  it('adopts a well-formed forwarded hop, and only a well-formed one', () => {
    expect(rateLimitIdentity(requestWithHop('203.0.113.7'))).toBe('203.0.113.7');
    expect(rateLimitIdentity(requestWithHop('203.0.113.7, 10.0.0.1'))).toBe('203.0.113.7');
    expect(rateLimitIdentity(requestWithHop('::1'))).toBe('::1');

    // The control for the three above: the same header, unparseable, falls into
    // the shared bucket instead of becoming its own.
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

    // 1. /authorize validates the client and redirect_uri, then hands the
    //    already-validated request to the consent screen as a signed blob.
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

    // The blob the consent page will verify — signed with the key this app
    // derives, and carrying the parameters the router validated.
    const areq = verifyAuthRequest(blob, deriveOAuthAreqKey(ADMIN_TOKEN), Date.now());
    expect(areq).toMatchObject({
      clientId: id,
      redirectUri: REDIRECT,
      codeChallenge: challenge,
      scope: 'mcp',
      state: 'state-abc',
    });
    // Unconsented requests expire rather than being replayable forever.
    expect(areq?.exp ?? 0).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // 2. The human step: the real consent POST mints the code and redirects to
    //    the client with the state it was given.
    const granted = await approve(blob);
    expect(`${granted.origin}${granted.pathname}`).toBe(REDIRECT);
    expect(granted.searchParams.get('state')).toBe('state-abc');
    const code = granted.searchParams.get('code');
    if (code === null) throw new Error('fixture: consent issued no code');

    // 3. /token redeems it, PKCE verified by the SDK against the challenge the
    //    provider stored with the code.
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
    // The OAuth vocabulary is echoed; the internal authz scope is derived.
    expect(tokens.scope).toBe('mcp');
    expect(tokens.refresh_token).toBeTruthy();

    // 4. The provider the router serves with accepts the token it issued.
    //    `AuthInfo.scopes` carries the INTERNAL authz scope the grant derives to
    //    (`apps/server`'s provider reports the same), not the OAuth vocabulary
    //    the token endpoint echoes back to the client.
    const info = await getOAuthProvider()?.verifyAccessToken(tokens.access_token);
    expect(info).toMatchObject({ token: tokens.access_token, clientId: id, scopes: ['*'] });
    expect(info?.expiresAt ?? 0).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(getServices().oauth?.authenticateAccessToken(tokens.access_token)?.scope).toBe('*');

    // 5. The token endpoint is the code's only consumer: a second redemption of
    //    the same code is a refusal, not a second grant.
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

    // `/mcp/<slug>` in the resource indicator is the only place project scope
    // can come from: no tool argument names a project.
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
    // The OAuth vocabulary above, the enforced binding below. A global grant
    // would read `read:*` here, which is what makes this assertion the proof.
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
    // The catch-all route must not become the app's fallback handler: a path
    // that is not one of the five endpoint families reaches Next's 404
    // (`notFound()`), not the router's answer. The thrown signal is Next's own
    // 404 control-flow error (its digest carries the code; the message reads
    // `NEXT_HTTP_ERROR_FALLBACK;404` on this version, `NEXT_NOT_FOUND` on
    // others), so the assertion is on the code it names.
    await expect(
      routeGet(get('/dashboard/not-a-page'), context('dashboard', 'not-a-page')),
    ).rejects.toThrow('404');
  });

  it('serves the not-found body when the authorization server is disabled', async () => {
    const publicUrl = process.env['REMBRIC_PUBLIC_URL'];
    // The memoized provider and router are cached on `globalThis` (see
    // `lib/oauth.ts`), so stubbing them away is the only way to observe the
    // disabled gate from a test — and `unstubAllGlobals` is what puts back the
    // pair this file has been using.
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
