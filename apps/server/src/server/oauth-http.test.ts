import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OAuthRepository } from '../db/repositories/oauth-repository.js';
import { OAuthService } from '../services/oauth.js';
import { createTestDb, type TestDb } from '../test/db.js';

import { createOAuthProvider } from './oauth-provider.js';

/**
 * End-to-end of the OAuth dance over real HTTP through the SDK's vetted
 * authorization-server router backed by our provider. Exercises metadata
 * discovery, Dynamic Client Registration, PKCE-validated authorization-code
 * exchange (the SDK validates PKCE itself), and refresh rotation. The consent
 * screen is injected here via `oauth.issueCode` (it is unit-tested on its own
 * and needs a logged-in dashboard session, out of scope for this HTTP smoke).
 */

const TTL = { accessTtlMs: 3_600_000, refreshTtlMs: 30 * 86_400_000 };
const REDIRECT = 'https://chatgpt.example/callback';

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

describe('OAuth authorization server over HTTP (SDK router + our provider)', () => {
  let t: TestDb;
  let oauth: OAuthService;
  let server: ReturnType<express.Express['listen']>;
  let base: string;

  beforeEach(async () => {
    t = createTestDb();
    oauth = new OAuthService({ oauth: new OAuthRepository(t.handle.db) }, TTL);
    const provider = createOAuthProvider({
      oauth,
      issuer: 'http://localhost',
      areqKey: randomBytes(32),
    });
    const app = express();
    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl: new URL('http://localhost'),
        scopesSupported: ['mcp', 'read'],
        resourceName: 'Rembric',
      }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    t.cleanup();
  });

  async function form(path: string, fields: Record<string, string>) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('publishes authorization-server metadata advertising S256 only', async () => {
    const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const md = (await res.json()) as Record<string, unknown>;
    expect(md.code_challenge_methods_supported).toEqual(['S256']);
    expect(md.grant_types_supported).toContain('authorization_code');
    expect(md.grant_types_supported).toContain('refresh_token');
  });

  it('registers a client, exchanges a PKCE code, and rotates the refresh token', async () => {
    const regRes = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
    });
    expect(regRes.status).toBe(201);
    const client = (await regRes.json()) as { client_id: string };
    expect(client.client_id).toMatch(/^oauthc_/);

    // Simulate consent approval: mint a code for the registered client.
    const { verifier, challenge } = pkce();
    const code = oauth.issueCode({
      clientId: client.client_id,
      redirectUri: REDIRECT,
      codeChallenge: challenge,
      scope: '*',
      subject: 'operator',
    });

    const tok = await form('/token', {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: client.client_id,
    });
    expect(tok.status).toBe(200);
    expect(tok.body.access_token).toBeTruthy();
    expect(tok.body.token_type).toBe('Bearer');
    const refreshToken = tok.body.refresh_token as string;
    expect(refreshToken).toBeTruthy();

    // Resolve the minted access token through the service (same path /mcp uses).
    expect(oauth.authenticateAccessToken(tok.body.access_token as string)?.scope).toBe('*');

    const refreshed = await form('/token', {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client.client_id,
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.access_token).toBeTruthy();
    expect(refreshed.body.access_token).not.toBe(tok.body.access_token);
  });

  it('rejects a token exchange with a wrong PKCE verifier (SDK validates PKCE)', async () => {
    const regRes = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
    });
    const client = (await regRes.json()) as { client_id: string };
    const { challenge } = pkce();
    const code = oauth.issueCode({
      clientId: client.client_id,
      redirectUri: REDIRECT,
      codeChallenge: challenge,
      scope: '*',
      subject: 'operator',
    });
    const tok = await form('/token', {
      grant_type: 'authorization_code',
      code,
      code_verifier: 'wrong-verifier-entirely',
      redirect_uri: REDIRECT,
      client_id: client.client_id,
    });
    expect(tok.status).toBe(400);
    expect(tok.body.error).toBe('invalid_grant');
  });
});
