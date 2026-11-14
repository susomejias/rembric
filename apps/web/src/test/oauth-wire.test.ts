import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  deriveOAuthAreqKey,
  deriveSessionKey,
  SessionsService,
  TokensService,
  verifyAuthRequest,
} from '@rembric/core';
import { createDb, createRepositories, type DashboardSession, type DbHandle } from '@rembric/db';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';

import {
  DELETE as routeDelete,
  GET as routeGet,
  OPTIONS as routeOptions,
  POST as routePost,
} from '../app/(oauth)/[...path]/route';
import { POST as consentPost } from '../app/dashboard/oauth/consent/route';
import { getServices } from '../lib/services';

const ADMIN_TOKEN = 'web-oauth-wire-admin-token-long-enough-for-keys';
const ISSUER = 'http://127.0.0.1:3100';
const CONSENT_PATH = '/dashboard/oauth/consent';
const REDIRECT = 'https://client.example/callback';
const CONSENT_FORM = 'oauth.consent';
const VERIFIER = 'wire-characterization-pkce-verifier-0123456789abcdef';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

const KEPT_HEADERS = [
  'content-type',
  'cache-control',
  'allow',
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'location',
  'www-authenticate',
  'retry-after',
  'ratelimit-policy',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
] as const;

const VOLATILE_HEADERS = new Set(['retry-after', 'ratelimit-reset']);
const VOLATILE_KEYS = new Set([
  'client_id',
  'client_id_issued_at',
  'access_token',
  'refresh_token',
]);
const VOLATILE_PARAMS = ['code', 'areq', 'client_id'];

interface Fixture {
  dataDir: string;
  handle: DbHandle;
  sessions: SessionsService;
  admin: { cookie: string; session: DashboardSession };
}

let fixture: Fixture;

beforeAll(() => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rembric-web-oauth-wire-'));
  const handle = createDb({ dataDir, onMigrationProgress: () => {}, onStartupLog: () => {} });
  const repos = createRepositories(handle.db);
  new TokensService(repos, handle.db).bootstrapAdmin(ADMIN_TOKEN);
  const adminRow = repos.tokens.findByName('admin');
  if (adminRow === undefined) throw new Error('fixture: admin token was not bootstrapped');
  const sessions = new SessionsService(
    { dashboardSessions: repos.dashboardSessions },
    deriveSessionKey(ADMIN_TOKEN),
  );
  const admin = sessions.create(adminRow.id);
  fixture = { dataDir, handle, sessions, admin: { cookie: admin.cookie, session: admin.session } };

  process.env['REMBRIC_DATA_DIR'] = dataDir;
  process.env['REMBRIC_ADMIN_TOKEN'] = ADMIN_TOKEN;
  delete process.env['REMBRIC_SESSION_SECRET'];
  process.env['REMBRIC_PUBLIC_URL'] = ISSUER;
});

afterAll(() => {
  try {
    fixture.handle.close();
  } catch {}
  rmSync(fixture.dataDir, { recursive: true, force: true });
  delete process.env['REMBRIC_DATA_DIR'];
  delete process.env['REMBRIC_ADMIN_TOKEN'];
  delete process.env['REMBRIC_PUBLIC_URL'];
});

interface Wire {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

function maskString(value: string): string {
  return value.replace(/oauthc_[0-9A-HJKMNP-TV-Z]{26}/g, '<client_id>');
}

function maskLocation(value: string): string {
  let masked = maskString(value);
  for (const name of VOLATILE_PARAMS) {
    masked = masked.replace(new RegExp(`([?&]${name}=)[^&#]*`, 'g'), `$1<${name}>`);
  }
  return masked;
}

function maskJson(value: unknown): unknown {
  if (typeof value === 'string') return maskString(value);
  if (Array.isArray(value)) return value.map(maskJson);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        VOLATILE_KEYS.has(key) ? `<${key}>` : maskJson(item),
      ]),
    );
  }
  return value;
}

async function wire(response: Response): Promise<Wire> {
  const headers: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const value = response.headers.get(name);
    if (value === null) continue;
    if (VOLATILE_HEADERS.has(name)) headers[name] = '<seconds>';
    else if (name === 'location') headers[name] = maskLocation(value);
    else headers[name] = value;
  }
  const text = await response.text();
  let body: unknown = maskString(text);
  try {
    body = maskJson(JSON.parse(text));
  } catch {}
  return { status: response.status, headers, body };
}

type RouteContext = { params: Promise<{ path?: string[] }> };

function context(pathname: string): RouteContext {
  const path = pathname.split('?')[0]?.split('/').filter(Boolean) ?? [];
  return { params: Promise.resolve({ path }) };
}

type Headers = Record<string, string>;

function request(method: string, path: string, headers: Headers = {}, body?: string): Request {
  return new Request(`${ISSUER}${path}`, { method, headers, body });
}

function jsonPost(path: string, payload: unknown, headers: Headers = {}): Request {
  return request(
    'POST',
    path,
    { 'content-type': 'application/json', ...headers },
    JSON.stringify(payload),
  );
}

function formPost(path: string, fields: Record<string, string>, headers: Headers = {}): Request {
  return request(
    'POST',
    path,
    { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    new URLSearchParams(fields).toString(),
  );
}

async function get(path: string, headers: Headers = {}): Promise<Response> {
  return routeGet(request('GET', path, headers), context(path));
}

async function post(req: Request): Promise<Response> {
  return routePost(req, context(new URL(req.url).pathname));
}

async function preflight(path: string): Promise<Response> {
  return routeOptions(
    request('OPTIONS', path, {
      origin: 'https://client.example',
      'access-control-request-method': path.startsWith('/.well-known') ? 'GET' : 'POST',
      'access-control-request-headers': 'content-type',
    }),
    context(path),
  );
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
}

async function register(headers: Headers = {}): Promise<Response> {
  return post(
    jsonPost(
      '/register',
      { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', client_name: 'Wire' },
      headers,
    ),
  );
}

async function newClient(): Promise<string> {
  const response = await register();
  if (response.status !== 201) throw new Error(`fixture: register answered ${response.status}`);
  return ((await response.json()) as { client_id: string }).client_id;
}

let primary: string | null = null;

async function clientId(): Promise<string> {
  primary ??= await newClient();
  return primary;
}

function authorizeQuery(id: string, overrides: Record<string, string> = {}): string {
  return new URLSearchParams({
    client_id: id,
    redirect_uri: REDIRECT,
    response_type: 'code',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    scope: 'mcp',
    state: 'state-abc',
    ...overrides,
  }).toString();
}

async function areqFor(id: string): Promise<string> {
  const response = await get(`/authorize?${authorizeQuery(id)}`);
  const location = response.headers.get('location');
  if (location === null) throw new Error('fixture: /authorize did not redirect');
  const blob = new URL(location, ISSUER).searchParams.get('areq');
  if (blob === null) throw new Error('fixture: no areq in the consent URL');
  return blob;
}

function consent(fields: Record<string, string>): Promise<Response> {
  return consentPost(
    new NextRequest(`${ISSUER}${CONSENT_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `${SessionsService.cookieName()}=${fixture.admin.cookie}`,
      },
      body: new URLSearchParams(fields),
    }),
  );
}

function csrf(): string {
  return fixture.sessions.csrfToken(fixture.admin.session, CONSENT_FORM);
}

async function codeFor(id: string): Promise<string> {
  const response = await consent({ csrf: csrf(), areq: await areqFor(id), decision: 'approve' });
  const location = response.headers.get('location');
  const code = location === null ? null : new URL(location).searchParams.get('code');
  if (code === null) throw new Error('fixture: consent issued no code');
  return code;
}

function token(fields: Record<string, string>, headers: Headers = {}): Promise<Response> {
  return post(formPost('/token', fields, headers));
}

function exchangeCode(id: string, code: string): Promise<Response> {
  return token({
    grant_type: 'authorization_code',
    code,
    code_verifier: VERIFIER,
    redirect_uri: REDIRECT,
    client_id: id,
  });
}

async function tokensFor(id: string): Promise<TokenResponse> {
  const response = await exchangeCode(id, await codeFor(id));
  if (response.status !== 200) throw new Error(`fixture: /token answered ${response.status}`);
  return (await response.json()) as TokenResponse;
}

function refresh(id: string, refreshToken: string): Promise<Response> {
  return token({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: id });
}

function revoke(fields: Record<string, string>, headers: Headers = {}): Promise<Response> {
  return post(formPost('/revoke', fields, headers));
}

function accessTokenAlive(accessToken: string): boolean {
  return getServices().oauth?.authenticateAccessToken(accessToken) != null;
}

describe('metadata and CORS', () => {
  it('GET authorization-server metadata', async () => {
    expect(await wire(await get('/.well-known/oauth-authorization-server'))).toMatchInlineSnapshot(`
        {
          "body": {
            "authorization_endpoint": "http://127.0.0.1:3100/authorize",
            "code_challenge_methods_supported": [
              "S256",
            ],
            "grant_types_supported": [
              "authorization_code",
              "refresh_token",
            ],
            "issuer": "http://127.0.0.1:3100/",
            "registration_endpoint": "http://127.0.0.1:3100/register",
            "response_types_supported": [
              "code",
            ],
            "revocation_endpoint": "http://127.0.0.1:3100/revoke",
            "revocation_endpoint_auth_methods_supported": [
              "client_secret_post",
            ],
            "scopes_supported": [
              "mcp",
              "read",
            ],
            "token_endpoint": "http://127.0.0.1:3100/token",
            "token_endpoint_auth_methods_supported": [
              "client_secret_post",
              "none",
            ],
          },
          "headers": {
            "access-control-allow-origin": "*",
            "content-type": "application/json; charset=utf-8",
          },
          "status": 200,
        }
      `);
  });

  it('GET protected-resource metadata', async () => {
    expect(await wire(await get('/.well-known/oauth-protected-resource'))).toMatchInlineSnapshot(`
      {
        "body": {
          "authorization_servers": [
            "http://127.0.0.1:3100/",
          ],
          "resource": "http://127.0.0.1:3100/",
          "resource_name": "Rembric",
          "scopes_supported": [
            "mcp",
            "read",
          ],
        },
        "headers": {
          "access-control-allow-origin": "*",
          "content-type": "application/json; charset=utf-8",
        },
        "status": 200,
      }
    `);
  });

  it('OPTIONS preflight on /token', async () => {
    expect(await wire(await preflight('/token'))).toMatchInlineSnapshot(`
      {
        "body": "",
        "headers": {
          "access-control-allow-headers": "content-type",
          "access-control-allow-methods": "GET,HEAD,PUT,PATCH,POST,DELETE",
          "access-control-allow-origin": "*",
        },
        "status": 204,
      }
    `);
  });

  it('OPTIONS preflight on /register', async () => {
    expect(await wire(await preflight('/register'))).toMatchInlineSnapshot(`
      {
        "body": "",
        "headers": {
          "access-control-allow-headers": "content-type",
          "access-control-allow-methods": "GET,HEAD,PUT,PATCH,POST,DELETE",
          "access-control-allow-origin": "*",
        },
        "status": 204,
      }
    `);
  });

  it('OPTIONS preflight on /revoke', async () => {
    expect(await wire(await preflight('/revoke'))).toMatchInlineSnapshot(`
      {
        "body": "",
        "headers": {
          "access-control-allow-headers": "content-type",
          "access-control-allow-methods": "GET,HEAD,PUT,PATCH,POST,DELETE",
          "access-control-allow-origin": "*",
        },
        "status": 204,
      }
    `);
  });

  it('OPTIONS preflight on authorization-server metadata', async () => {
    expect(await wire(await preflight('/.well-known/oauth-authorization-server')))
      .toMatchInlineSnapshot(`
      {
        "body": "",
        "headers": {
          "access-control-allow-headers": "content-type",
          "access-control-allow-methods": "GET,HEAD,PUT,PATCH,POST,DELETE",
          "access-control-allow-origin": "*",
        },
        "status": 204,
      }
    `);
  });
});

describe('POST /register', () => {
  it('registers a valid public client', async () => {
    expect(await wire(await register())).toMatchInlineSnapshot(`
      {
        "body": {
          "client_id": "<client_id>",
          "client_name": "Wire",
          "grant_types": [
            "authorization_code",
            "refresh_token",
          ],
          "redirect_uris": [
            "https://client.example/callback",
          ],
          "response_types": [
            "code",
          ],
          "token_endpoint_auth_method": "none",
        },
        "headers": {
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
          "ratelimit-limit": "20",
          "ratelimit-policy": "20;w=3600",
          "ratelimit-remaining": "19",
          "ratelimit-reset": "<seconds>",
        },
        "status": 201,
      }
    `);
  });

  it('refuses metadata without redirect_uris', async () => {
    expect(await wire(await post(jsonPost('/register', { token_endpoint_auth_method: 'none' }))))
      .toMatchInlineSnapshot(`
      {
        "body": {
          "error": "invalid_client_metadata",
          "error_description": "[
        {
          "expected": "array",
          "code": "invalid_type",
          "path": [
            "redirect_uris"
          ],
          "message": "Invalid input: expected array, received undefined"
        }
      ]",
        },
        "headers": {
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
          "ratelimit-limit": "20",
          "ratelimit-policy": "20;w=3600",
          "ratelimit-remaining": "18",
          "ratelimit-reset": "<seconds>",
        },
        "status": 400,
      }
    `);
  });

  it('refuses a redirect_uri that is not a URL', async () => {
    expect(
      await wire(
        await post(
          jsonPost('/register', {
            redirect_uris: ['not a url'],
            token_endpoint_auth_method: 'none',
          }),
        ),
      ),
    ).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "invalid_client_metadata",
          "error_description": "[
        {
          "code": "invalid_format",
          "format": "url",
          "path": [
            "redirect_uris",
            0
          ],
          "message": "Invalid URL"
        },
        {
          "code": "custom",
          "message": "URL must be parseable",
          "fatal": true,
          "path": [
            "redirect_uris",
            0
          ]
        }
      ]",
        },
        "headers": {
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
          "ratelimit-limit": "20",
          "ratelimit-policy": "20;w=3600",
          "ratelimit-remaining": "17",
          "ratelimit-reset": "<seconds>",
        },
        "status": 400,
      }
    `);
  });

  it('refuses a malformed JSON body', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => quiet.mockRestore());
    expect(
      await wire(
        await post(request('POST', '/register', { 'content-type': 'application/json' }, '{nope')),
      ),
    ).toMatchInlineSnapshot(`
      {
        "body": {
          "code": "internal_error",
          "ok": false,
        },
        "headers": {
          "content-type": "application/json",
        },
        "status": 500,
      }
    `);
  });
});

describe('/authorize', () => {
  it('GET with a valid request redirects to consent', async () => {
    const id = await clientId();
    const response = await get(`/authorize?${authorizeQuery(id)}`);
    const location = response.headers.get('location') ?? '';
    const blob = new URL(location, ISSUER).searchParams.get('areq') ?? '';
    const areq = verifyAuthRequest(blob, deriveOAuthAreqKey(ADMIN_TOKEN), Date.now());

    expect(await wire(response)).toMatchInlineSnapshot(`
      {
        "body": "",
        "headers": {
          "cache-control": "no-store",
          "location": "http://127.0.0.1:3100/dashboard/oauth/consent?areq=<areq>",
          "ratelimit-limit": "100",
          "ratelimit-policy": "100;w=900",
          "ratelimit-remaining": "99",
          "ratelimit-reset": "<seconds>",
        },
        "status": 302,
      }
    `);
    expect({ ...areq, clientId: '<client_id>', exp: '<exp>' }).toMatchInlineSnapshot(`
      {
        "clientId": "<client_id>",
        "codeChallenge": "ddbz_-7qTcXPhfPidcU0wQ7hm8RFVA7TWQIeEhrXpUM",
        "exp": "<exp>",
        "projectId": null,
        "redirectUri": "https://client.example/callback",
        "scope": "mcp",
        "state": "state-abc",
      }
    `);
  });

  it('GET with an unknown client', async () => {
    expect(await wire(await get(`/authorize?${authorizeQuery('oauthc_not-registered')}`)))
      .toMatchInlineSnapshot(`
      {
        "body": {
          "error": "invalid_client",
          "error_description": "Invalid client_id",
        },
        "headers": {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
          "ratelimit-limit": "100",
          "ratelimit-policy": "100;w=900",
          "ratelimit-remaining": "98",
          "ratelimit-reset": "<seconds>",
        },
        "status": 400,
      }
    `);
  });

  it('GET with a redirect_uri that is not registered', async () => {
    const id = await clientId();
    expect(
      await wire(
        await get(
          `/authorize?${authorizeQuery(id, { redirect_uri: 'https://evil.example/callback' })}`,
        ),
      ),
    ).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "invalid_request",
          "error_description": "Unregistered redirect_uri",
        },
        "headers": {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
          "ratelimit-limit": "100",
          "ratelimit-policy": "100;w=900",
          "ratelimit-remaining": "97",
          "ratelimit-reset": "<seconds>",
        },
        "status": 400,
      }
    `);
  });

  it('GET without code_challenge', async () => {
    const id = await clientId();
    const query = new URLSearchParams(authorizeQuery(id));
    query.delete('code_challenge');
    expect(await wire(await get(`/authorize?${query.toString()}`))).toMatchInlineSnapshot(`
      {
        "body": "",
        "headers": {
          "cache-control": "no-store",
          "location": "https://client.example/callback?error=invalid_request&error_description=%5B%0A++%7B%0A++++%22expected%22%3A+%22string%22%2C%0A++++%22code%22%3A+%22invalid_type%22%2C%0A++++%22path%22%3A+%5B%0A++++++%22code_challenge%22%0A++++%5D%2C%0A++++%22message%22%3A+%22Invalid+input%3A+expected+string%2C+received+undefined%22%0A++%7D%0A%5D",
          "ratelimit-limit": "100",
          "ratelimit-policy": "100;w=900",
          "ratelimit-remaining": "96",
          "ratelimit-reset": "<seconds>",
        },
        "status": 302,
      }
    `);
  });

  it('GET with code_challenge_method=plain', async () => {
    const id = await clientId();
    expect(
      await wire(await get(`/authorize?${authorizeQuery(id, { code_challenge_method: 'plain' })}`)),
    ).toMatchInlineSnapshot(`
      {
        "body": "",
        "headers": {
          "cache-control": "no-store",
          "location": "https://client.example/callback?error=invalid_request&error_description=%5B%0A++%7B%0A++++%22code%22%3A+%22invalid_value%22%2C%0A++++%22values%22%3A+%5B%0A++++++%22S256%22%0A++++%5D%2C%0A++++%22path%22%3A+%5B%0A++++++%22code_challenge_method%22%0A++++%5D%2C%0A++++%22message%22%3A+%22Invalid+input%3A+expected+%5C%22S256%5C%22%22%0A++%7D%0A%5D",
          "ratelimit-limit": "100",
          "ratelimit-policy": "100;w=900",
          "ratelimit-remaining": "95",
          "ratelimit-reset": "<seconds>",
        },
        "status": 302,
      }
    `);
  });

  it('GET with an unsupported response_type', async () => {
    const id = await clientId();
    expect(await wire(await get(`/authorize?${authorizeQuery(id, { response_type: 'token' })}`)))
      .toMatchInlineSnapshot(`
      {
        "body": "",
        "headers": {
          "cache-control": "no-store",
          "location": "https://client.example/callback?error=invalid_request&error_description=%5B%0A++%7B%0A++++%22code%22%3A+%22invalid_value%22%2C%0A++++%22values%22%3A+%5B%0A++++++%22code%22%0A++++%5D%2C%0A++++%22path%22%3A+%5B%0A++++++%22response_type%22%0A++++%5D%2C%0A++++%22message%22%3A+%22Invalid+input%3A+expected+%5C%22code%5C%22%22%0A++%7D%0A%5D",
          "ratelimit-limit": "100",
          "ratelimit-policy": "100;w=900",
          "ratelimit-remaining": "94",
          "ratelimit-reset": "<seconds>",
        },
        "status": 302,
      }
    `);
  });

  it('POST with a valid form redirects to consent', async () => {
    const id = await clientId();
    const fields = Object.fromEntries(new URLSearchParams(authorizeQuery(id)));
    expect(await wire(await post(formPost('/authorize', fields)))).toMatchInlineSnapshot(`
      {
        "body": "",
        "headers": {
          "cache-control": "no-store",
          "location": "http://127.0.0.1:3100/dashboard/oauth/consent?areq=<areq>",
          "ratelimit-limit": "100",
          "ratelimit-policy": "100;w=900",
          "ratelimit-remaining": "93",
          "ratelimit-reset": "<seconds>",
        },
        "status": 302,
      }
    `);
  });
});

describe('consent', () => {
  it('approve redirects with a code and the state', async () => {
    const id = await clientId();
    const areq = await areqFor(id);
    expect(await wire(await consent({ csrf: csrf(), areq, decision: 'approve' })))
      .toMatchInlineSnapshot(`
      {
        "body": "",
        "headers": {
          "location": "https://client.example/callback?code=<code>&state=state-abc",
        },
        "status": 302,
      }
    `);
  });

  it('deny redirects with access_denied and the state', async () => {
    const id = await clientId();
    const areq = await areqFor(id);
    expect(await wire(await consent({ csrf: csrf(), areq, decision: 'deny' })))
      .toMatchInlineSnapshot(`
      {
        "body": "",
        "headers": {
          "location": "https://client.example/callback?error=access_denied&state=state-abc",
        },
        "status": 302,
      }
    `);
  });
});

describe('POST /token authorization_code', () => {
  it('exchanges a valid code', async () => {
    const id = await clientId();
    expect(await wire(await exchangeCode(id, await codeFor(id)))).toMatchInlineSnapshot(`
      {
        "body": {
          "access_token": "<access_token>",
          "expires_in": 3600,
          "refresh_token": "<refresh_token>",
          "scope": "mcp",
          "token_type": "Bearer",
        },
        "headers": {
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
          "ratelimit-limit": "50",
          "ratelimit-policy": "50;w=900",
          "ratelimit-remaining": "49",
          "ratelimit-reset": "<seconds>",
        },
        "status": 200,
      }
    `);
  });

  it('refuses a reused code', async () => {
    const id = await clientId();
    const code = await codeFor(id);
    expect((await exchangeCode(id, code)).status).toBe(200);
    expect(await wire(await exchangeCode(id, code))).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "invalid_grant",
          "error_description": "authorization code already used",
        },
        "headers": {
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
          "ratelimit-limit": "50",
          "ratelimit-policy": "50;w=900",
          "ratelimit-remaining": "47",
          "ratelimit-reset": "<seconds>",
        },
        "status": 400,
      }
    `);
  });

  it('refuses a wrong verifier', async () => {
    const id = await clientId();
    const code = await codeFor(id);
    expect(
      await wire(
        await token({
          grant_type: 'authorization_code',
          code,
          code_verifier: randomBytes(32).toString('base64url'),
          redirect_uri: REDIRECT,
          client_id: id,
        }),
      ),
    ).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "invalid_grant",
          "error_description": "code_verifier does not match the challenge",
        },
        "headers": {
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
          "ratelimit-limit": "50",
          "ratelimit-policy": "50;w=900",
          "ratelimit-remaining": "46",
          "ratelimit-reset": "<seconds>",
        },
        "status": 400,
      }
    `);
  });

  it('refuses a missing code_verifier', async () => {
    const id = await clientId();
    const code = await codeFor(id);
    expect(
      await wire(
        await token({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT,
          client_id: id,
        }),
      ),
    ).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "invalid_request",
          "error_description": "[
        {
          "expected": "string",
          "code": "invalid_type",
          "path": [
            "code_verifier"
          ],
          "message": "Invalid input: expected string, received undefined"
        }
      ]",
        },
        "headers": {
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
          "ratelimit-limit": "50",
          "ratelimit-policy": "50;w=900",
          "ratelimit-remaining": "45",
          "ratelimit-reset": "<seconds>",
        },
        "status": 400,
      }
    `);
  });

  it('refuses an unsupported grant_type', async () => {
    const id = await clientId();
    expect(
      await wire(
        await token({ grant_type: 'password', username: 'u', password: 'p', client_id: id }),
      ),
    ).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "unsupported_grant_type",
          "error_description": "The grant type is not supported by this authorization server.",
        },
        "headers": {
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
          "ratelimit-limit": "50",
          "ratelimit-policy": "50;w=900",
          "ratelimit-remaining": "44",
          "ratelimit-reset": "<seconds>",
        },
        "status": 400,
      }
    `);
  });

  it('refuses an unknown client', async () => {
    expect(
      await wire(
        await token({
          grant_type: 'authorization_code',
          code: 'not-a-code',
          code_verifier: VERIFIER,
          redirect_uri: REDIRECT,
          client_id: 'oauthc_not-registered',
        }),
      ),
    ).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "invalid_client",
          "error_description": "Invalid client_id",
        },
        "headers": {
          "access-control-allow-origin": "*",
          "content-type": "application/json; charset=utf-8",
          "ratelimit-limit": "50",
          "ratelimit-policy": "50;w=900",
          "ratelimit-remaining": "43",
          "ratelimit-reset": "<seconds>",
        },
        "status": 400,
      }
    `);
  });
});

describe('POST /token refresh_token', () => {
  it('rotates a valid refresh token', async () => {
    const id = await clientId();
    const first = await tokensFor(id);
    const response = await refresh(id, first.refresh_token);
    const rotated = (await response.clone().json()) as TokenResponse;

    expect(await wire(response)).toMatchInlineSnapshot(`
      {
        "body": {
          "access_token": "<access_token>",
          "expires_in": 3600,
          "refresh_token": "<refresh_token>",
          "scope": "mcp",
          "token_type": "Bearer",
        },
        "headers": {
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
          "ratelimit-limit": "50",
          "ratelimit-policy": "50;w=900",
          "ratelimit-remaining": "41",
          "ratelimit-reset": "<seconds>",
        },
        "status": 200,
      }
    `);
    expect({
      newRefreshDiffers: rotated.refresh_token !== first.refresh_token,
      oldAccessAlive: accessTokenAlive(first.access_token),
      newAccessAlive: accessTokenAlive(rotated.access_token),
    }).toMatchInlineSnapshot(`
      {
        "newAccessAlive": true,
        "newRefreshDiffers": true,
        "oldAccessAlive": true,
      }
    `);
  });

  it('replays the old refresh token after rotation', async () => {
    const id = await clientId();
    const first = await tokensFor(id);
    const rotated = (await (await refresh(id, first.refresh_token)).json()) as TokenResponse;

    expect(await wire(await refresh(id, first.refresh_token))).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "invalid_grant",
          "error_description": "refresh token reuse detected; token family revoked",
        },
        "headers": {
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
          "ratelimit-limit": "50",
          "ratelimit-policy": "50;w=900",
          "ratelimit-remaining": "38",
          "ratelimit-reset": "<seconds>",
        },
        "status": 400,
      }
    `);
    expect({ newAccessAlive: accessTokenAlive(rotated.access_token) }).toMatchInlineSnapshot(`
      {
        "newAccessAlive": false,
      }
    `);
    expect(await wire(await refresh(id, rotated.refresh_token))).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "invalid_grant",
          "error_description": "refresh token revoked",
        },
        "headers": {
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
          "ratelimit-limit": "50",
          "ratelimit-policy": "50;w=900",
          "ratelimit-remaining": "37",
          "ratelimit-reset": "<seconds>",
        },
        "status": 400,
      }
    `);
  });
});

describe('POST /revoke', () => {
  it('the owner revokes its access token', async () => {
    const id = await clientId();
    const tokens = await tokensFor(id);
    expect(await wire(await revoke({ token: tokens.access_token, client_id: id })))
      .toMatchInlineSnapshot(`
      {
        "body": {},
        "headers": {
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
          "ratelimit-limit": "50",
          "ratelimit-policy": "50;w=900",
          "ratelimit-remaining": "49",
          "ratelimit-reset": "<seconds>",
        },
        "status": 200,
      }
    `);
    expect({
      accessAlive: accessTokenAlive(tokens.access_token),
      refresh: await wire(await refresh(id, tokens.refresh_token)),
    }).toMatchInlineSnapshot(`
      {
        "accessAlive": false,
        "refresh": {
          "body": {
            "error": "invalid_grant",
            "error_description": "refresh token revoked",
          },
          "headers": {
            "access-control-allow-origin": "*",
            "cache-control": "no-store",
            "content-type": "application/json; charset=utf-8",
            "ratelimit-limit": "50",
            "ratelimit-policy": "50;w=900",
            "ratelimit-remaining": "35",
            "ratelimit-reset": "<seconds>",
          },
          "status": 400,
        },
      }
    `);
  });

  it("another registered client revokes someone else's token", async () => {
    const id = await clientId();
    const other = await newClient();
    const tokens = await tokensFor(id);
    expect(await wire(await revoke({ token: tokens.access_token, client_id: other })))
      .toMatchInlineSnapshot(`
      {
        "body": {},
        "headers": {
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
          "ratelimit-limit": "50",
          "ratelimit-policy": "50;w=900",
          "ratelimit-remaining": "48",
          "ratelimit-reset": "<seconds>",
        },
        "status": 200,
      }
    `);
    expect({ accessAlive: accessTokenAlive(tokens.access_token) }).toMatchInlineSnapshot(`
      {
        "accessAlive": true,
      }
    `);
  });

  it('revokes an unknown token', async () => {
    const id = await clientId();
    expect(
      await wire(await revoke({ token: randomBytes(32).toString('base64url'), client_id: id })),
    ).toMatchInlineSnapshot(`
      {
        "body": {},
        "headers": {
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
          "ratelimit-limit": "50",
          "ratelimit-policy": "50;w=900",
          "ratelimit-remaining": "47",
          "ratelimit-reset": "<seconds>",
        },
        "status": 200,
      }
    `);
  });
});

describe('405 for an unsupported method', () => {
  it('DELETE /authorize', async () => {
    expect(await wire(await routeDelete(request('DELETE', '/authorize'), context('/authorize'))))
      .toMatchInlineSnapshot(`
      {
        "body": {
          "error": "method_not_allowed",
          "error_description": "The method DELETE is not allowed for this endpoint",
        },
        "headers": {
          "allow": "GET, POST",
          "content-type": "application/json; charset=utf-8",
        },
        "status": 405,
      }
    `);
  });

  it('GET /token', async () => {
    expect(await wire(await get('/token'))).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "method_not_allowed",
          "error_description": "The method GET is not allowed for this endpoint",
        },
        "headers": {
          "access-control-allow-origin": "*",
          "allow": "POST",
          "content-type": "application/json; charset=utf-8",
        },
        "status": 405,
      }
    `);
  });

  it('GET /register', async () => {
    expect(await wire(await get('/register'))).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "method_not_allowed",
          "error_description": "The method GET is not allowed for this endpoint",
        },
        "headers": {
          "access-control-allow-origin": "*",
          "allow": "POST",
          "content-type": "application/json; charset=utf-8",
        },
        "status": 405,
      }
    `);
  });

  it('GET /revoke', async () => {
    expect(await wire(await get('/revoke'))).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "method_not_allowed",
          "error_description": "The method GET is not allowed for this endpoint",
        },
        "headers": {
          "access-control-allow-origin": "*",
          "allow": "POST",
          "content-type": "application/json; charset=utf-8",
        },
        "status": 405,
      }
    `);
  });

  it('POST authorization-server metadata', async () => {
    expect(await wire(await post(jsonPost('/.well-known/oauth-authorization-server', {}))))
      .toMatchInlineSnapshot(`
      {
        "body": {
          "error": "method_not_allowed",
          "error_description": "The method POST is not allowed for this endpoint",
        },
        "headers": {
          "access-control-allow-origin": "*",
          "allow": "GET, OPTIONS",
          "content-type": "application/json; charset=utf-8",
        },
        "status": 405,
      }
    `);
  });

  it('POST protected-resource metadata', async () => {
    expect(await wire(await post(jsonPost('/.well-known/oauth-protected-resource', {}))))
      .toMatchInlineSnapshot(`
      {
        "body": {
          "error": "method_not_allowed",
          "error_description": "The method POST is not allowed for this endpoint",
        },
        "headers": {
          "access-control-allow-origin": "*",
          "allow": "GET, OPTIONS",
          "content-type": "application/json; charset=utf-8",
        },
        "status": 405,
      }
    `);
  });
});

async function exhaust(
  limit: number,
  send: () => Promise<Response>,
): Promise<{ lastAllowed: Wire; refused: Wire }> {
  let last: Response | null = null;
  for (let sent = 0; sent < limit; sent += 1) {
    if (last !== null) await last.arrayBuffer();
    last = await send();
  }
  if (last === null) throw new Error('fixture: limit must be positive');
  const lastAllowed = await wire(last);
  return { lastAllowed, refused: await wire(await send()) };
}

describe('rate limits', () => {
  it('/register allows 20 per hour', async () => {
    const hop = { 'x-forwarded-for': '198.51.100.11' };
    expect(await exhaust(20, () => register(hop))).toMatchInlineSnapshot(`
      {
        "lastAllowed": {
          "body": {
            "client_id": "<client_id>",
            "client_name": "Wire",
            "grant_types": [
              "authorization_code",
              "refresh_token",
            ],
            "redirect_uris": [
              "https://client.example/callback",
            ],
            "response_types": [
              "code",
            ],
            "token_endpoint_auth_method": "none",
          },
          "headers": {
            "access-control-allow-origin": "*",
            "cache-control": "no-store",
            "content-type": "application/json; charset=utf-8",
            "ratelimit-limit": "20",
            "ratelimit-policy": "20;w=3600",
            "ratelimit-remaining": "0",
            "ratelimit-reset": "<seconds>",
          },
          "status": 201,
        },
        "refused": {
          "body": {
            "error": "too_many_requests",
            "error_description": "You have exceeded the rate limit for client registration requests",
          },
          "headers": {
            "access-control-allow-origin": "*",
            "ratelimit-limit": "20",
            "ratelimit-policy": "20;w=3600",
            "ratelimit-remaining": "0",
            "ratelimit-reset": "<seconds>",
            "retry-after": "<seconds>",
          },
          "status": 429,
        },
      }
    `);
  });

  it('/token allows 50 per 15 minutes', async () => {
    const hop = { 'x-forwarded-for': '198.51.100.12' };
    const junk = {
      grant_type: 'authorization_code',
      code: 'not-a-code',
      code_verifier: VERIFIER,
      client_id: 'oauthc_not-registered',
    };
    expect(await exhaust(50, () => token(junk, hop))).toMatchInlineSnapshot(`
      {
        "lastAllowed": {
          "body": {
            "error": "invalid_client",
            "error_description": "Invalid client_id",
          },
          "headers": {
            "access-control-allow-origin": "*",
            "content-type": "application/json; charset=utf-8",
            "ratelimit-limit": "50",
            "ratelimit-policy": "50;w=900",
            "ratelimit-remaining": "0",
            "ratelimit-reset": "<seconds>",
          },
          "status": 400,
        },
        "refused": {
          "body": {
            "error": "too_many_requests",
            "error_description": "You have exceeded the rate limit for token requests",
          },
          "headers": {
            "access-control-allow-origin": "*",
            "ratelimit-limit": "50",
            "ratelimit-policy": "50;w=900",
            "ratelimit-remaining": "0",
            "ratelimit-reset": "<seconds>",
            "retry-after": "<seconds>",
          },
          "status": 429,
        },
      }
    `);
  });

  it('/revoke allows 50 per 15 minutes', async () => {
    const hop = { 'x-forwarded-for': '198.51.100.13' };
    const junk = { token: 'not-a-token', client_id: 'oauthc_not-registered' };
    expect(await exhaust(50, () => revoke(junk, hop))).toMatchInlineSnapshot(`
      {
        "lastAllowed": {
          "body": {
            "error": "invalid_client",
            "error_description": "Invalid client_id",
          },
          "headers": {
            "access-control-allow-origin": "*",
            "content-type": "application/json; charset=utf-8",
            "ratelimit-limit": "50",
            "ratelimit-policy": "50;w=900",
            "ratelimit-remaining": "0",
            "ratelimit-reset": "<seconds>",
          },
          "status": 400,
        },
        "refused": {
          "body": {
            "error": "too_many_requests",
            "error_description": "You have exceeded the rate limit for token revocation requests",
          },
          "headers": {
            "access-control-allow-origin": "*",
            "ratelimit-limit": "50",
            "ratelimit-policy": "50;w=900",
            "ratelimit-remaining": "0",
            "ratelimit-reset": "<seconds>",
            "retry-after": "<seconds>",
          },
          "status": 429,
        },
      }
    `);
  });

  it('/authorize allows 100 per 15 minutes', async () => {
    const hop = { 'x-forwarded-for': '198.51.100.14' };
    const path = `/authorize?${authorizeQuery('oauthc_not-registered')}`;
    expect(await exhaust(100, () => get(path, hop))).toMatchInlineSnapshot(`
      {
        "lastAllowed": {
          "body": {
            "error": "invalid_client",
            "error_description": "Invalid client_id",
          },
          "headers": {
            "cache-control": "no-store",
            "content-type": "application/json; charset=utf-8",
            "ratelimit-limit": "100",
            "ratelimit-policy": "100;w=900",
            "ratelimit-remaining": "0",
            "ratelimit-reset": "<seconds>",
          },
          "status": 400,
        },
        "refused": {
          "body": {
            "error": "too_many_requests",
            "error_description": "You have exceeded the rate limit for authorization requests",
          },
          "headers": {
            "ratelimit-limit": "100",
            "ratelimit-policy": "100;w=900",
            "ratelimit-remaining": "0",
            "ratelimit-reset": "<seconds>",
            "retry-after": "<seconds>",
          },
          "status": 429,
        },
      }
    `);
  });
});
