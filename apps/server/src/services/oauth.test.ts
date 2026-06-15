import { createHash, randomBytes } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OAuthRepository } from '../db/repositories/oauth-repository.js';
import { createTestDb, type TestDb } from '../test/db.js';

import { OAuthError, OAuthService, resolveGrantedScope } from './oauth.js';

const TTL = { accessTtlMs: 3_600_000, refreshTtlMs: 30 * 86_400_000 };

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

describe('OAuthService', () => {
  let t: TestDb;
  let repo: OAuthRepository;
  let clock: { now: Date };
  let svc: OAuthService;

  beforeEach(() => {
    t = createTestDb();
    repo = new OAuthRepository(t.handle.db);
    clock = { now: new Date(1_000_000) };
    svc = new OAuthService({ oauth: repo }, TTL, () => clock.now);
  });

  afterEach(() => t.cleanup());

  function register(redirectUris = ['https://chatgpt.example/callback']) {
    return svc.registerClient({ clientName: 'ChatGPT', redirectUris });
  }

  function authorize(overrides: Partial<{ challenge: string; scope: '*' | 'read:*' }> = {}) {
    const client = register();
    const { verifier, challenge } = pkcePair();
    const code = svc.issueCode({
      clientId: client.clientId,
      redirectUri: 'https://chatgpt.example/callback',
      codeChallenge: overrides.challenge ?? challenge,
      scope: overrides.scope ?? '*',
      subject: 'operator',
    });
    return { client, code, verifier };
  }

  describe('registerClient', () => {
    it('creates a public client with no secret', () => {
      const client = register();
      expect(client.clientId).toMatch(/^oauthc_/);
      expect(client.tokenEndpointAuthMethod).toBe('none');
      expect(svc.redirectUrisFor(client)).toEqual(['https://chatgpt.example/callback']);
    });

    it('rejects empty redirect_uris', () => {
      expect(() => svc.registerClient({ redirectUris: [] })).toThrow(OAuthError);
    });

    it('rejects a confidential client', () => {
      expect(() =>
        svc.registerClient({
          redirectUris: ['https://x/cb'],
          tokenEndpointAuthMethod: 'client_secret_post',
        }),
      ).toThrow(OAuthError);
    });

    it('rejects a non-loopback http redirect_uri (open-redirect surface)', () => {
      expect(() => svc.registerClient({ redirectUris: ['http://evil.example/cb'] })).toThrow(
        OAuthError,
      );
    });

    it('allows http loopback redirect_uris', () => {
      const client = svc.registerClient({ redirectUris: ['http://127.0.0.1:8080/cb'] });
      expect(svc.redirectUrisFor(client)).toEqual(['http://127.0.0.1:8080/cb']);
    });
  });

  describe('authorization code redemption', () => {
    it('redeems a valid code for a token pair (PKCE verified upstream by the SDK)', () => {
      const { client, code } = authorize();
      const pair = svc.redeemCode({
        code,
        clientId: client.clientId,
        redirectUri: 'https://chatgpt.example/callback',
      });
      expect(pair.accessToken).toBeTruthy();
      expect(pair.refreshToken).toBeTruthy();
      expect(pair.scope).toBe('*');
      expect(pair.expiresInSeconds).toBe(3600);

      const resolved = svc.authenticateAccessToken(pair.accessToken);
      expect(resolved?.scope).toBe('*');
      expect(resolved?.clientId).toBe(client.clientId);
    });

    it('exposes the stored code_challenge for the SDK token handler to verify', () => {
      const { code } = authorize();
      expect(svc.challengeForCode(code)).toBeTruthy();
    });

    it('challengeForCode throws on an unknown code', () => {
      expect(() => svc.challengeForCode('nope')).toThrow(/not recognized/);
    });

    it('rejects a reused (single-use) code', () => {
      const { client, code } = authorize();
      const args = {
        code,
        clientId: client.clientId,
        redirectUri: 'https://chatgpt.example/callback',
      };
      svc.redeemCode(args);
      expect(() => svc.redeemCode(args)).toThrow(/already used/);
    });

    it('rejects an expired code', () => {
      const { client, code } = authorize();
      clock.now = new Date(clock.now.getTime() + 121_000);
      expect(() =>
        svc.redeemCode({
          code,
          clientId: client.clientId,
          redirectUri: 'https://chatgpt.example/callback',
        }),
      ).toThrow(/expired/);
    });

    it('rejects a mismatched redirect_uri', () => {
      const { client, code } = authorize();
      expect(() =>
        svc.redeemCode({
          code,
          clientId: client.clientId,
          redirectUri: 'https://evil.example/cb',
        }),
      ).toThrow(/redirect_uri/);
    });

    it('rejects a mismatched client_id', () => {
      const { code } = authorize();
      expect(() =>
        svc.redeemCode({
          code,
          clientId: 'oauthc_other',
          redirectUri: 'https://chatgpt.example/callback',
        }),
      ).toThrow(/client_id/);
    });

    it('rejects an unknown code', () => {
      expect(() =>
        svc.redeemCode({
          code: 'nope',
          clientId: 'oauthc_x',
          redirectUri: 'https://chatgpt.example/callback',
        }),
      ).toThrow(/not recognized/);
    });
  });

  describe('refresh rotation', () => {
    function mint() {
      const { client, code } = authorize();
      const pair = svc.redeemCode({
        code,
        clientId: client.clientId,
        redirectUri: 'https://chatgpt.example/callback',
      });
      return { client, pair };
    }

    it('issues a rotated pair and invalidates the old refresh token', () => {
      const { client, pair } = mint();
      const next = svc.refresh({ refreshToken: pair.refreshToken, clientId: client.clientId });
      expect(next.accessToken).not.toBe(pair.accessToken);
      expect(next.refreshToken).not.toBe(pair.refreshToken);
      // Old refresh now rejected.
      expect(() =>
        svc.refresh({ refreshToken: pair.refreshToken, clientId: client.clientId }),
      ).toThrow(/reuse detected/);
    });

    it('revokes the whole family on refresh reuse', () => {
      const { client, pair } = mint();
      const next = svc.refresh({ refreshToken: pair.refreshToken, clientId: client.clientId });
      // Reuse the consumed (original) refresh token → family revoke.
      expect(() =>
        svc.refresh({ refreshToken: pair.refreshToken, clientId: client.clientId }),
      ).toThrow(/family revoked/);
      // The access token minted by the legitimate rotation is now revoked too.
      expect(svc.authenticateAccessToken(next.accessToken)).toBeNull();
    });

    it('rejects an expired refresh token', () => {
      const { client, pair } = mint();
      clock.now = new Date(clock.now.getTime() + TTL.refreshTtlMs + 1000);
      expect(() =>
        svc.refresh({ refreshToken: pair.refreshToken, clientId: client.clientId }),
      ).toThrow(/expired/);
    });

    it('rejects a refresh token with a mismatched client_id', () => {
      const { pair } = mint();
      expect(() =>
        svc.refresh({ refreshToken: pair.refreshToken, clientId: 'oauthc_other' }),
      ).toThrow(/client_id/);
    });
  });

  describe('access token resolution', () => {
    it('returns null for an expired access token', () => {
      const { client, code } = authorize();
      const pair = svc.redeemCode({
        code,
        clientId: client.clientId,
        redirectUri: 'https://chatgpt.example/callback',
      });
      clock.now = new Date(clock.now.getTime() + TTL.accessTtlMs + 1000);
      expect(svc.authenticateAccessToken(pair.accessToken)).toBeNull();
    });

    it('returns null for an unknown token', () => {
      expect(svc.authenticateAccessToken('not-a-token')).toBeNull();
    });

    it('does not resolve a refresh token as an access token', () => {
      const { client, code } = authorize();
      const pair = svc.redeemCode({
        code,
        clientId: client.clientId,
        redirectUri: 'https://chatgpt.example/callback',
      });
      expect(svc.authenticateAccessToken(pair.refreshToken)).toBeNull();
    });
  });
});

describe('resolveGrantedScope', () => {
  it('fails closed to least privilege for unknown/empty scope', () => {
    expect(resolveGrantedScope(undefined)).toBe('read:*');
    expect(resolveGrantedScope('')).toBe('read:*');
    expect(resolveGrantedScope('garbage-scope')).toBe('read:*');
  });

  it('grants write only when explicitly requested', () => {
    expect(resolveGrantedScope('mcp')).toBe('*');
    expect(resolveGrantedScope('mcp:write')).toBe('*');
    expect(resolveGrantedScope('*')).toBe('*');
  });

  it('maps read-only requests to read:*', () => {
    expect(resolveGrantedScope('read')).toBe('read:*');
    expect(resolveGrantedScope('mcp:read')).toBe('read:*');
  });

  it('grants write when both read and write are requested', () => {
    expect(resolveGrantedScope('read mcp')).toBe('*');
  });
});
