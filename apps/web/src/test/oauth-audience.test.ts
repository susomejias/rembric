import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/client';
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
  GET as oauthGet,
  OPTIONS as oauthOptions,
  POST as oauthPost,
} from '../app/(oauth)/[...path]/route';
import { POST as consentPost } from '../app/dashboard/oauth/consent/route';
import OAuthConsentPage from '../app/dashboard/oauth-consent/page';
import { DELETE as mcpDelete, GET as mcpGet, POST as mcpPost } from '../app/mcp/[[...path]]/route';
import { verifyMcpBearerToken } from '../lib/mcp-auth';
import { getServices, type Services } from '../lib/services';

import { renderToHtml } from './dashboard/harness';

vi.mock('@/components/dashboard/csrf-field', () => ({ CsrfField: () => null }));

const ADMIN_TOKEN = 'web-oauth-audience-admin-token-long-enough';
const ISSUER = 'http://127.0.0.1:3100';
const CONSENT_PATH = '/dashboard/oauth/consent';
const REDIRECT = 'https://client.example/callback';
const CONSENT_FORM = 'oauth.consent';
const SLUG = 'audience-a';
const OTHER = 'audience-b';

let dataDir: string;
let handle: DbHandle;
let sessions: SessionsService;
let admin: { cookie: string; session: DashboardSession };
let projectA: { id: string };
let projectB: { id: string };

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'rembric-web-oauth-audience-'));
  handle = createDb({ dataDir, onMigrationProgress: () => {}, onStartupLog: () => {} });
  const repos = createRepositories(handle.db);
  new TokensService(repos, handle.db).bootstrapAdmin(ADMIN_TOKEN);
  const adminRow = repos.tokens.findByName('admin');
  if (adminRow === undefined) throw new Error('fixture: admin token was not bootstrapped');
  sessions = new SessionsService(
    { dashboardSessions: repos.dashboardSessions },
    deriveSessionKey(ADMIN_TOKEN),
  );
  const created = sessions.create(adminRow.id);
  admin = { cookie: created.cookie, session: created.session };

  process.env['REMBRIC_DATA_DIR'] = dataDir;
  process.env['REMBRIC_ADMIN_TOKEN'] = ADMIN_TOKEN;
  delete process.env['REMBRIC_SESSION_SECRET'];
  process.env['REMBRIC_PUBLIC_URL'] = ISSUER;

  projectA = getServices().projects.create({ slug: SLUG, displayName: 'Audience Alpha' });
  projectB = getServices().projects.create({ slug: OTHER, displayName: null });
});

afterAll(() => {
  try {
    handle.close();
  } catch {}
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env['REMBRIC_DATA_DIR'];
  delete process.env['REMBRIC_ADMIN_TOKEN'];
  delete process.env['REMBRIC_PUBLIC_URL'];
});

function routeContext(path: string[]): { params: Promise<{ path?: string[] }> } {
  return { params: Promise.resolve(path.length > 0 ? { path } : {}) };
}

function routeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : new Request(input, init);
  const segments = new URL(request.url).pathname.split('/').filter((s) => s.length > 0);
  const method = request.method.toUpperCase();
  if (segments[0] === 'mcp') {
    const handler = method === 'GET' ? mcpGet : method === 'DELETE' ? mcpDelete : mcpPost;
    return handler(request, routeContext(segments.slice(1)));
  }
  const handler = method === 'GET' ? oauthGet : method === 'OPTIONS' ? oauthOptions : oauthPost;
  return handler(request, routeContext(segments));
}

function get(path: string): Promise<Response> {
  return routeFetch(`${ISSUER}${path}`);
}

function consentRequest(fields: Record<string, string>): NextRequest {
  return new NextRequest(`${ISSUER}${CONSENT_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `${SessionsService.cookieName()}=${admin.cookie}`,
    },
    body: new URLSearchParams(fields),
  });
}

async function approve(blob: string): Promise<URL> {
  const response = await consentPost(
    consentRequest({
      csrf: sessions.csrfToken(admin.session, CONSENT_FORM),
      areq: blob,
      decision: 'approve',
    }),
  );
  expect(response.status).toBe(302);
  return new URL(response.headers.get('location') ?? '');
}

type ClientInformation = Parameters<NonNullable<OAuthClientProvider['saveClientInformation']>>[0];
type Tokens = Parameters<OAuthClientProvider['saveTokens']>[0];

class MemoryProvider implements OAuthClientProvider {
  info: ClientInformation | undefined;
  saved: Tokens | undefined;
  verifier = '';
  authorizationUrl: URL | undefined;
  discovery: OAuthDiscoveryState | undefined;

  get redirectUrl(): string {
    return REDIRECT;
  }

  get clientMetadata() {
    return {
      client_name: 'audience-probe',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'mcp',
    };
  }

  clientInformation(): ClientInformation | undefined {
    return this.info;
  }

  saveClientInformation(info: ClientInformation): void {
    this.info = info;
  }

  tokens(): Tokens | undefined {
    return this.saved;
  }

  saveTokens(tokens: Tokens): void {
    this.saved = tokens;
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }

  codeVerifier(): string {
    return this.verifier;
  }
}

function transportFor(path: string, provider: OAuthClientProvider): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(`${ISSUER}${path}`), {
    fetch: routeFetch,
    authProvider: provider,
  });
}

async function connect(path: string, provider: OAuthClientProvider): Promise<Client> {
  const client = new Client({ name: 'audience-probe', version: '0.0.0' });
  await client.connect(transportFor(path, provider));
  return client;
}

async function authorizeWithSdkClient(
  path: string,
): Promise<{ provider: MemoryProvider; resource: string | null; accessToken: string }> {
  const provider = new MemoryProvider();
  const first = transportFor(path, provider);
  await expect(
    new Client({ name: 'audience-probe', version: '0.0.0' }).connect(first),
  ).rejects.toBeInstanceOf(UnauthorizedError);

  const authorizationUrl = provider.authorizationUrl;
  if (authorizationUrl === undefined) throw new Error('fixture: the client never redirected');
  const consent = await routeFetch(authorizationUrl);
  expect(consent.status).toBe(302);
  const consentUrl = new URL(consent.headers.get('location') ?? '');
  const granted = await approve(consentUrl.searchParams.get('areq') ?? '');
  await first.finishAuth(granted.searchParams.get('code') ?? '');

  const accessToken = provider.saved?.access_token;
  if (accessToken === undefined) throw new Error('fixture: the client saved no token');
  return { provider, resource: authorizationUrl.searchParams.get('resource'), accessToken };
}

async function statsText(client: Client): Promise<{ isError: boolean; text: string }> {
  const result = await client.callTool({ name: 'memory.stats', arguments: {} });
  const content = (result.content ?? []) as { type: string; text?: string }[];
  return {
    isError: result.isError === true,
    text: content.map((part) => part.text ?? '').join(''),
  };
}

describe('per-connector protected-resource metadata', () => {
  it('serves a document whose resource is the project connector', async () => {
    const response = await get(`/.well-known/oauth-protected-resource/mcp/${SLUG}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(await response.json()).toEqual({
      resource: `${ISSUER}/mcp/${SLUG}`,
      authorization_servers: [`${ISSUER}/`],
      scopes_supported: ['mcp', 'read'],
      resource_name: 'Rembric',
    });
  });

  it('keeps the root document for the path-less connector', async () => {
    const response = await get('/.well-known/oauth-protected-resource');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resource: `${ISSUER}/` });
  });

  it('answers 404 for a slug that names no project', async () => {
    const response = await get('/.well-known/oauth-protected-resource/mcp/no-such-project');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      ok: false,
      code: 'not_found',
      path: '/.well-known/oauth-protected-resource/mcp/no-such-project',
    });
  });

  it('serves the connector document with a trailing slash', async () => {
    const response = await get(`/.well-known/oauth-protected-resource/mcp/${SLUG}/`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resource: `${ISSUER}/mcp/${SLUG}` });
  });

  it('answers 404 for a project slug outside the /mcp prefix', async () => {
    const response = await get(`/.well-known/oauth-protected-resource/api/${SLUG}`);

    expect(response.status).toBe(404);
  });

  it('answers 404 for a path below a project connector', async () => {
    const response = await get(`/.well-known/oauth-protected-resource/mcp/${SLUG}/extra`);

    expect(response.status).toBe(404);
  });
});

describe('the 401 challenge names the connector document', () => {
  async function challenge(path: string): Promise<string | null> {
    const response = await routeFetch(`${ISSUER}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(response.status).toBe(401);
    return response.headers.get('www-authenticate');
  }

  it('points /mcp/<slug> at its per-connector document', async () => {
    expect(await challenge(`/mcp/${SLUG}`)).toContain(
      `resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp/${SLUG}"`,
    );
  });

  it('points the path-less /mcp at the root document', async () => {
    expect(await challenge('/mcp')).toContain(
      `resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"`,
    );
  });
});

describe('a standard MCP client authorizing against a connector', () => {
  it('obtains a token bound to the project of /mcp/<slug>', async () => {
    const { provider, resource, accessToken } = await authorizeWithSdkClient(`/mcp/${SLUG}`);

    expect(resource).toBe(`${ISSUER}/mcp/${SLUG}`);
    expect(getServices().oauth?.authenticateAccessToken(accessToken)).toMatchObject({
      projectId: projectA.id,
      scope: `project:${projectA.id}`,
    });

    const own = await connect(`/mcp/${SLUG}`, provider);
    expect((await statsText(own)).isError).toBe(false);
    await own.close();

    const foreign = await connect(`/mcp/${OTHER}`, provider);
    const refused = await statsText(foreign);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('forbidden');
    await foreign.close();
  });

  it('obtains an unbound token from the path-less /mcp', async () => {
    const { provider, resource, accessToken } = await authorizeWithSdkClient('/mcp');

    expect(resource).toBe(`${ISSUER}/`);
    expect(getServices().oauth?.authenticateAccessToken(accessToken)).toMatchObject({
      projectId: null,
      scope: '*',
    });

    const elsewhere = await connect(`/mcp/${OTHER}`, provider);
    expect((await statsText(elsewhere)).isError).toBe(false);
    await elsewhere.close();
  });
});

describe('resource validation at /authorize', () => {
  let clientId = '';

  beforeAll(async () => {
    const response = await routeFetch(`${ISSUER}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
    });
    clientId = ((await response.json()) as { client_id: string }).client_id;
  });

  async function authorize(resource: string | undefined): Promise<URL> {
    const verifier = randomBytes(32).toString('base64url');
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      scope: 'mcp',
      state: 'state-xyz',
    });
    if (resource !== undefined) query.set('resource', resource);
    const response = await get(`/authorize?${query.toString()}`);
    expect(response.status).toBe(302);
    return new URL(response.headers.get('location') ?? '');
  }

  function areqProject(consent: URL): string | null | undefined {
    const blob = consent.searchParams.get('areq') ?? '';
    return verifyAuthRequest(blob, deriveOAuthAreqKey(ADMIN_TOKEN), Date.now())?.projectId;
  }

  it.each([
    ['a slug that names no project', `${ISSUER}/mcp/no-such-project`],
    ['another origin', `https://elsewhere.example/mcp/${SLUG}`],
    ['another port of this host', `http://127.0.0.1:3101/mcp/${SLUG}`],
    ['a path outside /mcp', `${ISSUER}/api/${SLUG}/sessions`],
    ['a project slug outside /mcp', `${ISSUER}/api/${SLUG}`],
    ['a path below a connector', `${ISSUER}/mcp/${SLUG}/extra`],
    ['a query string', `${ISSUER}/mcp/${SLUG}?x=1`],
    ['a fragment', `${ISSUER}/mcp/${SLUG}#x`],
    ['a user name', `http://user@127.0.0.1:3100/mcp/${SLUG}`],
    ['a password', `http://:pw@127.0.0.1:3100/mcp/${SLUG}`],
  ])('redirects with invalid_target for %s', async (_label, resource) => {
    const location = await authorize(resource);

    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get('error')).toBe('invalid_target');
    expect(location.searchParams.get('state')).toBe('state-xyz');
    expect(location.searchParams.get('code')).toBeNull();
  });

  it.each([
    ['no resource', undefined, null],
    ['the server root', `${ISSUER}/`, null],
    ['the path-less connector', `${ISSUER}/mcp`, null],
    ['the path-less connector with a trailing slash', `${ISSUER}/mcp/`, null],
    ['a project connector', `${ISSUER}/mcp/${SLUG}`, 'A'],
    ['a project connector with a trailing slash', `${ISSUER}/mcp/${SLUG}/`, 'A'],
  ])('sends %s to consent', async (_label, resource, bound) => {
    const location = await authorize(resource);

    expect(`${location.origin}${location.pathname}`).toBe(`${ISSUER}${CONSENT_PATH}`);
    expect(areqProject(location)).toBe(bound === null ? null : projectA.id);
  });
});

describe('the consent screen names the bound project', () => {
  async function render(projectId: string | null): Promise<string> {
    const services = getServices();
    const client = services.oauth?.registerClient({
      clientName: 'Consent probe',
      redirectUris: [REDIRECT],
    });
    if (client === undefined) throw new Error('fixture: oauth is disabled');
    const areq = signAuthRequest(
      {
        clientId: client.clientId,
        redirectUri: REDIRECT,
        codeChallenge: 'challenge',
        scope: 'mcp',
        state: 'state-abc',
        projectId,
        exp: Math.floor(Date.now() / 1000) + 600,
      },
      deriveOAuthAreqKey(ADMIN_TOKEN),
    );
    return renderToHtml(await OAuthConsentPage({ searchParams: Promise.resolve({ areq }) }));
  }

  it('names the project a /mcp/<slug> grant is bound to', async () => {
    const html = await render(projectA.id);

    expect(html).toContain('Audience Alpha');
    expect(html).toContain(SLUG);
    expect(html).toContain('only this project');
    expect(html).not.toContain('every project');
  });

  it('falls back to the slug for a project without a display name', async () => {
    const html = await render(projectB.id);

    expect(html).toContain(OTHER);
    expect(html).toContain('only this project');
  });

  it('says plainly that a path-less grant is unbound', async () => {
    const html = await render(null);

    expect(html).toContain('every project');
    expect(html).not.toContain('only this project');
  });

  it('refuses a request bound to a project that no longer exists', async () => {
    const html = await render('01NOSUCHPROJECT0000000000');

    expect(html).toContain('no longer exists');
    expect(html).not.toContain('value="approve"');
  });
});

describe('/mcp records failed bearers against the lockout', () => {
  const MAX_FAILURES = 10;

  function attempt(identity: string, authorization: string | null, services?: Services) {
    return verifyMcpBearerToken({
      authorization,
      slug: null,
      identity,
      services: services ?? getServices(),
    });
  }

  it('throttles an identity after repeated invalid bearers, before verifying the next', async () => {
    for (let i = 0; i < MAX_FAILURES; i += 1) {
      const outcome = await attempt('203.0.113.1', 'Bearer not-a-real-token');
      expect(outcome.ok).toBe(false);
    }

    const locked = await attempt('203.0.113.1', `Bearer ${ADMIN_TOKEN}`);
    expect(locked.ok).toBe(false);
    if (locked.ok) return;
    expect(locked.response.status).toBe(429);
    expect(await locked.response.json()).toMatchObject({ ok: false, code: 'rate_limited' });

    expect((await attempt('203.0.113.2', `Bearer ${ADMIN_TOKEN}`)).ok).toBe(true);
  });

  it('counts a malformed Authorization header as a failed attempt', async () => {
    for (let i = 0; i < MAX_FAILURES; i += 1) {
      await attempt('203.0.113.3', 'Basic dXNlcjpwYXNz');
    }

    expect((await attempt('203.0.113.3', `Bearer ${ADMIN_TOKEN}`)).ok).toBe(false);
  });

  it('does not count a request without credentials, the OAuth discovery step', async () => {
    for (let i = 0; i < MAX_FAILURES; i += 1) {
      const outcome = await attempt('203.0.113.4', null);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.response.status).toBe(401);
    }

    expect((await attempt('203.0.113.4', `Bearer ${ADMIN_TOKEN}`)).ok).toBe(true);
  });

  it('does not count a server error while resolving the bearer', async () => {
    const broken = {
      ...getServices(),
      tokens: { authenticate: () => Promise.reject(new Error('database unavailable')) },
    } as unknown as Services; // a partial stub: only tokens.authenticate is reached
    for (let i = 0; i < MAX_FAILURES; i += 1) {
      const outcome = await attempt('203.0.113.5', 'Bearer anything', broken);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.response.status).toBe(500);
    }

    expect((await attempt('203.0.113.5', `Bearer ${ADMIN_TOKEN}`)).ok).toBe(true);
  });

  it('resets the count after a successful bearer', async () => {
    for (let i = 0; i < MAX_FAILURES - 1; i += 1) {
      await attempt('203.0.113.6', 'Bearer not-a-real-token');
    }
    expect((await attempt('203.0.113.6', `Bearer ${ADMIN_TOKEN}`)).ok).toBe(true);
    for (let i = 0; i < MAX_FAILURES - 1; i += 1) {
      await attempt('203.0.113.6', 'Bearer not-a-real-token');
    }

    expect((await attempt('203.0.113.6', `Bearer ${ADMIN_TOKEN}`)).ok).toBe(true);
  });
});
