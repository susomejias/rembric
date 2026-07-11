import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { OAuthService } from '../services/oauth.js';
import { ProjectsService } from '../services/projects.js';
import { TokensService } from '../services/tokens.js';
import { createTestDb, type TestDb } from '../test/db.js';

import { AuthError, authenticate } from './auth.js';

const TTL = { accessTtlMs: 3_600_000, refreshTtlMs: 30 * 86_400_000 };

describe('authenticate — static + OAuth coexistence', () => {
  let t: TestDb;
  let repos: Repositories;
  let tokens: TokensService;
  let projects: ProjectsService;
  let oauth: OAuthService;

  beforeEach(() => {
    t = createTestDb();
    repos = createRepositories(t.handle.db);
    tokens = new TokensService(repos);
    projects = new ProjectsService(repos);
    oauth = new OAuthService({ oauth: repos.oauth }, TTL);
  });

  afterEach(() => t.cleanup());

  function mintOAuthAccessToken(scope: '*' | 'read:*' = '*'): string {
    const client = oauth.registerClient({ redirectUris: ['https://c/cb'] });
    const code = oauth.issueCode({
      clientId: client.clientId,
      redirectUri: 'https://c/cb',
      codeChallenge: 'challenge-placeholder',
      scope,
      subject: 'operator',
    });
    return oauth.redeemCode({ code, clientId: client.clientId, redirectUri: 'https://c/cb' })
      .accessToken;
  }

  it('authenticates a static token (unchanged behavior)', async () => {
    const created = tokens.create({ name: 'static', scope: '*', projectId: null });
    const ctx = await authenticate({
      authorization: `Bearer ${created.plaintext}`,
      pathSlug: undefined,
      tokens,
      projects,
      oauth,
    });
    expect(ctx.scope).toBe('*');
    expect(ctx.token.id).toBe(created.token.id);
  });

  it('falls back to an OAuth access token when static lookup misses', async () => {
    const access = mintOAuthAccessToken('*');
    const ctx = await authenticate({
      authorization: `Bearer ${access}`,
      pathSlug: undefined,
      tokens,
      projects,
      oauth,
    });
    expect(ctx.scope).toBe('*');
    expect(ctx.token.name).toMatch(/^oauth:/);
  });

  it('preserves OAuth scope (read:*) through resolution', async () => {
    const access = mintOAuthAccessToken('read:*');
    const ctx = await authenticate({
      authorization: `Bearer ${access}`,
      pathSlug: undefined,
      tokens,
      projects,
      oauth,
    });
    expect(ctx.scope).toBe('read:*');
  });

  it('rejects an unknown token with token_invalid', async () => {
    await expect(
      authenticate({
        authorization: 'Bearer totally-unknown',
        pathSlug: undefined,
        tokens,
        projects,
        oauth,
      }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('does not accept OAuth tokens when oauth is disabled', async () => {
    const access = mintOAuthAccessToken('*');
    await expect(
      authenticate({
        authorization: `Bearer ${access}`,
        pathSlug: undefined,
        tokens,
        projects,
        oauth: null,
      }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('never authenticates a token row with an empty hash (synthetic-token safety)', async () => {
    // The OAuth synthetic Token carries hash:'' and is never persisted; this
    // guards the invariant that an empty stored hash can never match.
    repos.tokens.insert({
      id: 'empty-hash',
      name: 'empty-hash',
      hash: '',
      scope: '*',
      projectId: null,
      createdAt: new Date(0),
      expiresAt: null,
      revokedAt: null,
    });
    await expect(tokens.authenticate('')).rejects.toThrow(/not recognized/);
    await expect(tokens.authenticate('anything')).rejects.toThrow(/not recognized/);
  });

  it('does not retry a revoked static token against OAuth', async () => {
    const created = tokens.create({ name: 'revokeme', scope: '*', projectId: null });
    tokens.revoke('revokeme');
    try {
      await authenticate({
        authorization: `Bearer ${created.plaintext}`,
        pathSlug: undefined,
        tokens,
        projects,
        oauth,
      });
      throw new Error('expected AuthError');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).code).toBe('token_revoked');
    }
  });
});
