import { isAuthorized, OAuthService, ProjectsService, TokensService } from '@rembric/core';
import { createRepositories, type Repositories } from '@rembric/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthError, authenticate, isDomainError } from '../lib/auth';

import { createTestDb, type TestDb } from './db';

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
    tokens = new TokensService(repos, t.handle.db);
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
    const created = tokens.create({ name: 'static', scope: '*' });
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

  it('accepts a lower-case "bearer" prefix, as RFC 7235 requires', async () => {
    const created = tokens.create({ name: 'static', scope: '*' });
    const ctx = await authenticate({
      authorization: `bearer ${created.plaintext}`,
      pathSlug: undefined,
      tokens,
      projects,
      oauth,
    });
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
    expect(ctx.memberProjectIds).toEqual([]);
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
    ).rejects.toThrow(AuthError);
    await expect(
      authenticate({
        authorization: 'Bearer totally-unknown',
        pathSlug: undefined,
        tokens,
        projects,
        oauth,
      }),
    ).rejects.toMatchObject({ code: 'token_invalid', status: 401 });
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
    ).rejects.toMatchObject({ code: 'token_invalid' });
  });

  it('never authenticates a token row with an empty hash (synthetic-token safety)', async () => {
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
    await expect(
      authenticate({
        authorization: 'Bearer anything',
        pathSlug: undefined,
        tokens,
        projects,
        oauth,
      }),
    ).rejects.toMatchObject({ code: 'token_invalid' });
  });

  it('does not retry a revoked static token against OAuth', async () => {
    const created = tokens.create({ name: 'revokeme', scope: '*' });
    tokens.revoke('revokeme');
    await expect(
      authenticate({
        authorization: `Bearer ${created.plaintext}`,
        pathSlug: undefined,
        tokens,
        projects,
        oauth,
      }),
    ).rejects.toMatchObject({ code: 'token_revoked', status: 401 });
  });

  it('reports an expired static token as token_expired, not token_invalid', async () => {
    const created = tokens.create({ name: 'expired', scope: '*', expiresAt: new Date(0) });
    await expect(
      authenticate({
        authorization: `Bearer ${created.plaintext}`,
        pathSlug: undefined,
        tokens,
        projects,
        oauth,
      }),
    ).rejects.toMatchObject({ code: 'token_expired', status: 401 });
  });

  it('refuses a missing, non-bearer or empty Authorization header before any lookup', async () => {
    const missing = await authenticate({
      authorization: undefined,
      pathSlug: undefined,
      tokens,
      projects,
      oauth,
    }).catch((e: AuthError) => e);
    expect(missing).toMatchObject({ code: 'missing_token', status: 401 });

    for (const authorization of ['NotBearer something', 'Bearer ', 'Bearer   ']) {
      await expect(
        authenticate({ authorization, pathSlug: undefined, tokens, projects, oauth }),
      ).rejects.toMatchObject({ code: 'malformed_authorization', status: 401 });
    }
  });

  it('resolves the URL path slug into the project and reports the requested slug', async () => {
    const proj = projects.create({ slug: 'auth-proj' });
    const created = tokens.create({ name: 'static', scope: '*' });
    const ctx = await authenticate({
      authorization: `Bearer ${created.plaintext}`,
      pathSlug: 'auth-proj',
      tokens,
      projects,
      oauth,
    });
    expect(ctx.project?.id).toBe(proj.id);
    expect(ctx.requestedSlug).toBe('auth-proj');
    expect(ctx.mcpSessionId).toBeNull();
  });

  it('leaves project null for a slug that names no project, instead of throwing', async () => {
    const created = tokens.create({ name: 'static', scope: '*' });
    const ctx = await authenticate({
      authorization: `Bearer ${created.plaintext}`,
      pathSlug: 'no-such-project',
      tokens,
      projects,
      oauth,
    });
    expect(ctx.project).toBeNull();
    expect(ctx.requestedSlug).toBe('no-such-project');
  });

  it('refuses an archived project with project_archived (403)', async () => {
    const proj = projects.create({ slug: 'archived-proj' });
    projects.archive(proj.id);
    const created = tokens.create({ name: 'static', scope: '*' });
    await expect(
      authenticate({
        authorization: `Bearer ${created.plaintext}`,
        pathSlug: 'archived-proj',
        tokens,
        projects,
        oauth,
      }),
    ).rejects.toMatchObject({ code: 'project_archived', status: 403 });
  });

  it("carries a project-scoped token's reach into the request context", async () => {
    const proj = projects.create({ slug: 'scoped-proj' });
    const other = projects.create({ slug: 'other-proj' });
    const created = tokens.create({ name: 'scoped', project: proj, access: 'write' });

    const ctx = await authenticate({
      authorization: `Bearer ${created.plaintext}`,
      pathSlug: proj.slug,
      tokens,
      projects,
      oauth,
    });

    expect(ctx.token.projectId).toBe(proj.id);
    expect(isAuthorized(ctx, 'write', { scope: 'project', projectId: proj.id })).toBe(true);
    expect(isAuthorized(ctx, 'write', { scope: 'project', projectId: other.id })).toBe(false);
  });
});

describe('isDomainError — shape discrimination', () => {
  it('accepts a DomainError shaped by name + string code', () => {
    const err = new Error('token not recognized');
    err.name = 'DomainError';
    (err as { code?: string }).code = 'token_invalid';
    expect(isDomainError(err)).toBe(true);
  });

  it('rejects a SqliteError carrying a string code', () => {
    const err = new Error('database is locked');
    err.name = 'SqliteError';
    (err as { code?: string }).code = 'SQLITE_BUSY';
    expect(isDomainError(err)).toBe(false);
  });

  it('rejects an Error with no code and any non-Error throw', () => {
    expect(isDomainError(new Error('boom'))).toBe(false);
    expect(isDomainError('a plain string throw')).toBe(false);
    expect(isDomainError({ name: 'DomainError', code: 'token_invalid' })).toBe(false);
  });
});
