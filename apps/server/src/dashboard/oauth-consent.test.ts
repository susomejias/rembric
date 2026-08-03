import { randomBytes } from 'node:crypto';

import { Hono, type Context, type Next } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { OAuthRepository } from '../db/repositories/oauth-repository.js';
import { signAuthRequest, type AuthRequest } from '../services/oauth-areq.js';
import { OAuthService, resolveGrantedScope } from '../services/oauth.js';
import { SessionsService } from '../services/sessions.js';
import { TokensService } from '../services/tokens.js';
import { createTestDb, type TestDb } from '../test/db.js';

import { createOAuthConsentRouter } from './oauth-consent.js';
import type { ResolvedSession } from './types.js';

const TTL = { accessTtlMs: 3_600_000, refreshTtlMs: 30 * 86_400_000 };
const REDIRECT = 'https://chatgpt.example/callback';
const KEY = randomBytes(32);

describe('OAuth consent route', () => {
  let t: TestDb;
  let oauth: OAuthService;
  let sessions: SessionsService;
  let app: Hono;
  let session: ResolvedSession;
  let clientId: string;

  beforeEach(() => {
    t = createTestDb();
    const repos = createRepositories(t.handle.db);
    oauth = new OAuthService({ oauth: new OAuthRepository(t.handle.db) }, TTL);
    sessions = new SessionsService(repos, randomBytes(32));
    const tokens = new TokensService(repos);
    const admin = tokens.create({ name: 'admin', scope: '*' });
    const created = sessions.create(admin.token.id);
    session = { session: created.session, sessions, tokenId: admin.token.id };
    clientId = oauth.registerClient({ redirectUris: [REDIRECT], clientName: 'ChatGPT' }).clientId;

    app = new Hono();
    app.use('*', (c: Context, next: Next) => {
      c.set('session' as never, session as never);
      return next();
    });
    app.route('/', createOAuthConsentRouter({ oauth, areqKey: KEY, sessions }));
  });

  afterEach(() => t.cleanup());

  function areq(overrides: Partial<AuthRequest> = {}): string {
    return signAuthRequest(
      {
        clientId,
        redirectUri: REDIRECT,
        codeChallenge: 'challenge-value',
        scope: 'mcp',
        state: 'st-9',
        exp: Math.floor(Date.now() / 1000) + 300,
        ...overrides,
      },
      KEY,
    );
  }

  function csrf(): string {
    return sessions.csrfToken(session.session, 'oauth.consent');
  }

  async function post(fields: Record<string, string>) {
    return app.request('/consent', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
  }

  it('GET renders the consent screen for a valid areq', async () => {
    const res = await app.request(`/consent?areq=${encodeURIComponent(areq())}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('AUTHORIZE');
    expect(body).toContain('ChatGPT');
  });

  it('GET rejects an invalid/expired areq with 400', async () => {
    const expired = areq({ exp: Math.floor(Date.now() / 1000) - 1 });
    const res = await app.request(`/consent?areq=${encodeURIComponent(expired)}`);
    expect(res.status).toBe(400);
  });

  it('POST approve issues a code and redirects to the client redirect_uri', async () => {
    const res = await post({ areq: areq(), decision: 'approve', csrf: csrf() });
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') ?? '';
    expect(loc.startsWith(`${REDIRECT}?`)).toBe(true);
    const url = new URL(loc);
    expect(url.searchParams.get('code')).toBeTruthy();
    expect(url.searchParams.get('state')).toBe('st-9');
    // The issued code redeems to the granted OAuth scope ("mcp"), which
    // derives to the write-capable authz TokenScope.
    const code = url.searchParams.get('code')!;
    const pair = oauth.redeemCode({ code, clientId, redirectUri: REDIRECT });
    expect(pair.scope).toBe('mcp');
    expect(resolveGrantedScope(pair.scope)).toBe('*');
  });

  it('POST deny redirects with access_denied and issues no code', async () => {
    const res = await post({ areq: areq(), decision: 'deny', csrf: csrf() });
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get('location') ?? '');
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('code')).toBeNull();
  });

  it('POST without a valid CSRF token is rejected', async () => {
    const res = await post({ areq: areq(), decision: 'approve', csrf: 'wrong' });
    expect(res.status).toBe(403);
  });

  it('POST with a tampered areq is rejected with 400', async () => {
    const blob = areq();
    const tampered = `${blob}x`;
    const res = await post({ areq: tampered, decision: 'approve', csrf: csrf() });
    expect(res.status).toBe(400);
  });
});
