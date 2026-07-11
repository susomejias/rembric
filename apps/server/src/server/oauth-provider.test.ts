import { createHash, randomBytes } from 'node:crypto';

import type { Response } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { OAuthRepository } from '../db/repositories/oauth-repository.js';
import { OAuthService } from '../services/oauth.js';
import { ProjectsService } from '../services/projects.js';
import { createTestDb, type TestDb } from '../test/db.js';

import { createOAuthProvider } from './oauth-provider.js';

const TTL = { accessTtlMs: 3_600_000, refreshTtlMs: 30 * 86_400_000 };
const REDIRECT = 'https://chatgpt.example/callback';

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

interface RedirectCapture {
  redirected?: { status: number; url: string };
}

/** Minimal express Response stub capturing redirects (the SDK only calls redirect). */
function resStub(): Response & RedirectCapture {
  const capture: RedirectCapture = {};
  const stub = {
    redirect(status: number, url: string) {
      capture.redirected = { status, url };
    },
    get redirected() {
      return capture.redirected;
    },
    // Test stub: the provider only ever calls res.redirect, so a partial
    // Response is sufficient; the cast documents that narrowing.
  } as unknown as Response & RedirectCapture;
  return stub;
}

describe('createOAuthProvider', () => {
  let t: TestDb;
  let oauth: OAuthService;
  let provider: ReturnType<typeof createOAuthProvider>;

  beforeEach(() => {
    t = createTestDb();
    oauth = new OAuthService({ oauth: new OAuthRepository(t.handle.db) }, TTL);
    provider = createOAuthProvider({
      oauth,
      projects: new ProjectsService(createRepositories(t.handle.db)),
      issuer: 'https://rembric.example.com',
      areqKey: randomBytes(32),
    });
  });

  afterEach(() => t.cleanup());

  it('registers a public client and reads it back', async () => {
    const created = await provider.clientsStore.registerClient?.({
      redirect_uris: [REDIRECT],
      client_name: 'ChatGPT',
    });
    expect(created?.client_id).toMatch(/^oauthc_/);
    expect(created?.token_endpoint_auth_method).toBe('none');
    const fetched = await provider.clientsStore.getClient(created!.client_id);
    expect(fetched?.redirect_uris).toEqual([REDIRECT]);
  });

  it('authorize() redirects to the dashboard consent screen with a signed areq', async () => {
    const res = resStub();
    await provider.authorize(
      { client_id: 'oauthc_x', redirect_uris: [REDIRECT] },
      { redirectUri: REDIRECT, codeChallenge: 'ch', scopes: ['mcp'], state: 's1' },
      res,
    );
    expect(res.redirected?.status).toBe(302);
    expect(res.redirected?.url).toContain(
      'https://rembric.example.com/dashboard/oauth/consent?areq=',
    );
  });

  it('exchanges a code (PKCE validated upstream) into OAuthTokens and verifies the access token', async () => {
    const client = oauth.registerClient({ redirectUris: [REDIRECT] });
    const { challenge } = pkce();
    const code = oauth.issueCode({
      clientId: client.clientId,
      redirectUri: REDIRECT,
      codeChallenge: challenge,
      scope: '*',
      subject: 'operator',
    });
    const tokens = await provider.exchangeAuthorizationCode(
      { client_id: client.clientId, redirect_uris: [REDIRECT] },
      code,
      undefined,
      REDIRECT,
    );
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();

    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info.clientId).toBe(client.clientId);
    expect(info.scopes).toEqual(['*']);

    const refreshed = await provider.exchangeRefreshToken(
      { client_id: client.clientId, redirect_uris: [REDIRECT] },
      tokens.refresh_token!,
    );
    expect(refreshed.access_token).not.toBe(tokens.access_token);
  });

  it('maps a service invalid_grant to a 400-class OAuth error (not a 500)', async () => {
    await expect(
      provider.exchangeAuthorizationCode(
        { client_id: 'oauthc_x', redirect_uris: [REDIRECT] },
        'unknown-code',
        undefined,
        REDIRECT,
      ),
    ).rejects.toMatchObject({ errorCode: 'invalid_grant' });
  });

  it('rejects an unknown access token in verifyAccessToken', async () => {
    await expect(provider.verifyAccessToken('nope')).rejects.toMatchObject({
      errorCode: 'invalid_token',
    });
  });
});
