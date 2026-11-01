import { createRepositories, type Repositories } from '@rembric/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DomainError,
  isAuthorized,
  SessionsService,
  ProjectsService,
  pinnedProjectId,
  TokensService,
  type CreateTokenInput,
  type TokenReach,
  type TokenScope,
} from '@rembric/core';

import { createTestDb, type TestDb } from '../test-support/index.js';

let db: TestDb;
let tokens: TokensService;

beforeEach(() => {
  db = createTestDb();
  tokens = new TokensService(createRepositories(db.handle.db), db.handle.db);
});

afterEach(() => {
  db.cleanup();
});

describe('TokensService.deleteRevoked', () => {
  it('hides only the target, retains names and counts, and rejects warm and cold bearer access', async () => {
    const target = tokens.create({ name: 'removed', scope: '*' });
    const other = tokens.create({ name: 'kept', scope: '*' });
    await tokens.authenticate(target.plaintext);
    tokens.revoke(target.token.name);
    tokens.deleteRevoked(target.token.id);
    expect(tokens.list().map((row) => row.id)).toEqual([other.token.id]);
    expect(tokens.findById(target.token.id)?.deletedAt).toBeInstanceOf(Date);
    expect(tokens.findByName('removed')?.id).toBe(target.token.id);
    expect(tokens.count()).toBe(2);
    expect(() => tokens.create({ name: 'removed', scope: '*' })).toThrow(/already exists/);
    await expect(tokens.authenticate(target.plaintext)).rejects.toMatchObject({
      code: 'token_revoked',
    });
    const cold = new TokensService(createRepositories(db.handle.db), db.handle.db);
    await expect(cold.authenticate(target.plaintext)).rejects.toMatchObject({
      code: 'token_revoked',
    });
    await expect(tokens.authenticate(other.plaintext)).resolves.toMatchObject({
      token: { id: other.token.id },
    });
  });

  it('does not bootstrap after the last visible token is deleted', () => {
    const target = tokens.create({ name: 'last', scope: '*' });
    tokens.revoke('last');
    tokens.deleteRevoked(target.token.id);
    expect(tokens.list()).toEqual([]);
    tokens.bootstrapAdmin('replacement-bootstrap-token');
    expect(tokens.count()).toBe(1);
    expect(tokens.findByName('admin')).toBeUndefined();
  });

  it('refuses empty, missing, and already deleted IDs', () => {
    expect(() => tokens.deleteRevoked('   ')).toThrow(
      new DomainError('invalid_input', 'tokens.delete: id must be non-empty'),
    );
    expect(() => tokens.deleteRevoked('missing')).toThrow(
      new DomainError('token_not_found', 'tokens.delete: token not found or already deleted'),
    );
    const target = tokens.create({ name: 'repeat', scope: '*' });
    tokens.revoke('repeat');
    tokens.deleteRevoked(target.token.id);
    const deletedAt = tokens.findById(target.token.id)?.deletedAt;
    expect(() => tokens.deleteRevoked(target.token.id)).toThrow(
      new DomainError('token_not_found', 'tokens.delete: token not found or already deleted'),
    );
    expect(tokens.findById(target.token.id)?.deletedAt).toEqual(deletedAt);
  });

  it.each([null, new Date(0)])('refuses unrevoked tokens regardless of expiry %s', (expiresAt) => {
    const target = tokens.create({ name: 'unrevoked', scope: '*', expiresAt });
    expect(() => tokens.deleteRevoked(target.token.id)).toThrow(
      new DomainError('invalid_input', 'tokens.delete: revoke the token before deleting it'),
    );
    expect(tokens.list().map((row) => row.id)).toContain(target.token.id);
    expect(tokens.findById(target.token.id)?.deletedAt).toBeNull();
  });

  it('conditionally updates only revoked, undeleted repository rows', () => {
    const repo = createRepositories(db.handle.db).tokens;
    const target = tokens.create({ name: 'conditional', scope: '*' });
    const other = tokens.create({ name: 'conditional-control', scope: '*' });
    tokens.revoke(other.token.name);
    expect(repo.deleteRevoked(target.token.id, new Date())).toBe(0);
    expect(repo.deleteRevoked('missing', new Date())).toBe(0);
    tokens.revoke('conditional');
    expect(repo.deleteRevoked(target.token.id, new Date(1000))).toBe(1);
    expect(repo.deleteRevoked(target.token.id, new Date(2000))).toBe(0);
    expect(tokens.findById(target.token.id)?.deletedAt).toEqual(new Date(1000));
    expect(tokens.findById(other.token.id)?.deletedAt).toBeNull();
  });

  it('retains project memberships and agent session provenance', () => {
    const repos = createRepositories(db.handle.db);
    const projects = new ProjectsService(repos);
    const first = projects.create({ slug: 'history-first' });
    const second = projects.create({ slug: 'history-second' });
    const target = tokens.create({ name: 'history', projects: [first, second], access: 'write' });
    const session = repos.agentSessions.insert({
      id: 'history-session',
      tokenId: target.token.id,
      projectId: first.id,
      agent: 'test',
      startedAt: new Date(),
      summary: 'retained summary',
      status: 'ended',
    });
    expect(session).toBeDefined();
    const memberships = repos.tokens.listProjectIds(target.token.id);
    expect(memberships).toHaveLength(2);
    tokens.revoke('history');
    tokens.deleteRevoked(target.token.id);
    expect(repos.tokens.listProjectIds(target.token.id)).toEqual(memberships);
    expect(repos.agentSessions.getById('history-session')).toEqual(session);
    expect(tokens.findById(target.token.id)?.name).toBe('history');
  });

  it('invalidates every linked dashboard cookie while retaining unrelated access', () => {
    const repos = createRepositories(db.handle.db);
    const target = tokens.create({ name: 'cookie-target', scope: '*' });
    const other = tokens.create({ name: 'cookie-other', scope: '*' });
    const sessions = new SessionsService(repos, Buffer.alloc(32, 1));
    const first = sessions.create(target.token.id);
    const second = sessions.create(target.token.id);
    const control = sessions.create(other.token.id);
    expect(sessions.resolve(first.cookie)?.tokenId).toBe(target.token.id);
    expect(sessions.resolve(second.cookie)?.tokenId).toBe(target.token.id);
    tokens.revoke(target.token.name);
    tokens.deleteRevoked(target.token.id);
    expect(sessions.resolve(first.cookie)).toBeNull();
    expect(sessions.resolve(second.cookie)).toBeNull();
    expect(sessions.resolve(control.cookie)?.tokenId).toBe(other.token.id);
    expect(tokens.findById(target.token.id)?.hash).toBe(target.token.hash);
  });
});

describe('TokensService.create', () => {
  it('returns the plaintext exactly once and never persists it', () => {
    const { plaintext, token } = tokens.create({ name: 't1', scope: '*' });
    expect(plaintext.length).toBeGreaterThan(20);
    expect(token.hash).not.toContain(plaintext);
    expect(token.name).toBe('t1');
  });

  it('rejects empty names', () => {
    expect(() => tokens.create({ name: '   ', scope: '*' })).toThrow(/non-empty/);
  });

  it('rejects duplicate names', () => {
    tokens.create({ name: 'dup', scope: '*' });
    expect(() => tokens.create({ name: 'dup', scope: '*' })).toThrow(/already exists/);
  });

  it('does not admit a project scope string as caller-supplied input', () => {
    const rejected: CreateTokenInput[] = [
      // @ts-expect-error `project:<id>` must be composed from a resolved project row, never accepted here
      { name: 'slug-write', scope: 'project:alpha' },
      // @ts-expect-error same for the read arm, `read:project:<id>`
      { name: 'slug-read', scope: 'read:project:alpha' },
      // @ts-expect-error the set arm takes resolved project ROWS; a bare slug would re-admit the same defect
      { name: 'slug-set', projects: ['alpha'], access: 'write' },
      // @ts-expect-error and it is non-empty: a credential over no project would authorize nothing at all
      { name: 'empty-set', projects: [], access: 'write' },
    ];
    expect(rejected).toHaveLength(4);
  });
});

describe('TokensService.authenticate', () => {
  it('matches the token via constant-time hash compare', async () => {
    const { plaintext, token } = tokens.create({ name: 't', scope: '*' });
    const resolved = await tokens.authenticate(plaintext);
    expect(resolved.token.id).toBe(token.id);
  });

  it('rejects an unknown token', async () => {
    await expect(tokens.authenticate('not-a-real-token')).rejects.toThrow(/not recognized/);
  });

  it('rejects a revoked token', async () => {
    const { plaintext } = tokens.create({ name: 't', scope: '*' });
    tokens.revoke('t');
    await expect(tokens.authenticate(plaintext)).rejects.toThrow(/revoked/);
  });

  it('rejects an expired token', async () => {
    const past = new Date(Date.now() - 1000);
    const { plaintext } = tokens.create({ name: 't', scope: '*', expiresAt: past });
    await expect(tokens.authenticate(plaintext)).rejects.toThrow(/expired/);
  });
});

describe('TokensService.bootstrapAdmin', () => {
  it('seeds the admin token on first run', () => {
    expect(tokens.count()).toBe(0);
    tokens.bootstrapAdmin('a-strong-admin-token-1234567890');
    expect(tokens.count()).toBe(1);
    const found = tokens.findByName('admin');
    expect(found?.scope).toBe('*');
  });

  it('is idempotent across restarts (ignores env after first run)', () => {
    tokens.bootstrapAdmin('first-admin-token-1234567890');
    const firstHash = tokens.findByName('admin')?.hash;
    tokens.bootstrapAdmin('second-admin-token-1234567890');
    const secondHash = tokens.findByName('admin')?.hash;
    expect(secondHash).toBe(firstHash);
  });

  it('refuses to bootstrap without an admin token on first run', () => {
    expect(() => tokens.bootstrapAdmin(null)).toThrow(/MEMORIA_ADMIN_TOKEN|REMBRIC_ADMIN_TOKEN/i);
  });
});

/** The reach of every token shape that predates `token_projects`: no members. */
const unbound = (scope: TokenScope): TokenReach => ({ scope, memberProjectIds: [] });

describe('isAuthorized', () => {
  it('admin can do anything', () => {
    expect(isAuthorized(unbound('*'), 'write', { scope: 'global' })).toBe(true);
    expect(isAuthorized(unbound('*'), 'read', { scope: 'project', projectId: 'p' })).toBe(true);
  });

  it('read:* allows reads but rejects writes', () => {
    expect(isAuthorized(unbound('read:*'), 'read', { scope: 'global' })).toBe(true);
    expect(isAuthorized(unbound('read:*'), 'write', { scope: 'global' })).toBe(false);
  });

  it('project:<id> restricts to that project', () => {
    expect(
      isAuthorized(unbound('project:abc'), 'write', { scope: 'project', projectId: 'abc' }),
    ).toBe(true);
    expect(
      isAuthorized(unbound('project:abc'), 'write', { scope: 'project', projectId: 'xyz' }),
    ).toBe(false);
    expect(isAuthorized(unbound('project:abc'), 'write', { scope: 'global' })).toBe(false);
    expect(isAuthorized(unbound('project:abc'), 'read', { scope: 'global' })).toBe(false);
    expect(isAuthorized(unbound('read:project:abc'), 'read', { scope: 'global' })).toBe(false);
  });

  it('read:project:<id> only allows reads of that project', () => {
    expect(
      isAuthorized(unbound('read:project:abc'), 'read', { scope: 'project', projectId: 'abc' }),
    ).toBe(true);
    expect(
      isAuthorized(unbound('read:project:abc'), 'write', { scope: 'project', projectId: 'abc' }),
    ).toBe(false);
  });

  it('the two set literals authorize nothing by string alone', () => {
    expect('projects'.startsWith('project:')).toBe(false);
    expect('read:projects'.startsWith('read:project:')).toBe(false);
    for (const scope of ['projects', 'read:projects'] as const) {
      for (const action of ['read', 'write'] as const) {
        for (const target of [
          { scope: 'global' } as const,
          { scope: 'project', projectId: 'abc' } as const,
          { scope: 'project', projectId: null } as const,
        ]) {
          expect(isAuthorized(unbound(scope), action, target), `${scope}/${action}`).toBe(false);
        }
      }
    }
  });

  it('membership adds reach to the set arms, and to nothing else', () => {
    const set = (scope: TokenScope): TokenReach => ({ scope, memberProjectIds: ['abc', 'def'] });
    expect(isAuthorized(set('projects'), 'write', { scope: 'project', projectId: 'abc' })).toBe(
      true,
    );
    expect(isAuthorized(set('projects'), 'read', { scope: 'project', projectId: 'def' })).toBe(
      true,
    );
    expect(isAuthorized(set('projects'), 'write', { scope: 'project', projectId: 'xyz' })).toBe(
      false,
    );
    expect(isAuthorized(set('projects'), 'write', { scope: 'global' })).toBe(false);

    // The verb is not widened by membership.
    expect(isAuthorized(set('read:projects'), 'read', { scope: 'project', projectId: 'abc' })).toBe(
      true,
    );
    expect(
      isAuthorized(set('read:projects'), 'write', { scope: 'project', projectId: 'abc' }),
    ).toBe(false);

    expect(isAuthorized(set('read:*'), 'write', { scope: 'project', projectId: 'abc' })).toBe(
      false,
    );
    expect(isAuthorized(set('project:abc'), 'write', { scope: 'project', projectId: 'def' })).toBe(
      false,
    );
  });

  it('the set arms are pinned to no project', () => {
    expect(pinnedProjectId('projects')).toBeNull();
    expect(pinnedProjectId('read:projects')).toBeNull();
  });
});

describe('TokensService.authenticate — verified-credential cache (#266)', () => {
  let repos: Repositories;

  beforeEach(() => {
    repos = createRepositories(db.handle.db);
  });

  it('skips the scrypt scan on a repeat authenticate() call for the same token', async () => {
    const scopedTokens = new TokensService(repos, db.handle.db);
    const { plaintext } = scopedTokens.create({ name: 'cached', scope: '*' });
    const listAllSpy = vi.spyOn(repos.tokens, 'listAll');

    await scopedTokens.authenticate(plaintext);
    expect(listAllSpy).toHaveBeenCalledTimes(1); // cold: full scrypt-verify scan

    await scopedTokens.authenticate(plaintext);
    expect(listAllSpy).toHaveBeenCalledTimes(1); // warm: cache hit, no re-scan
  });

  it('revocation takes effect on the very next request despite a warm cache', async () => {
    const { plaintext } = tokens.create({ name: 'revoke-me', scope: '*' });
    await tokens.authenticate(plaintext); // warm the cache

    tokens.revoke('revoke-me');

    await expect(tokens.authenticate(plaintext)).rejects.toMatchObject({ code: 'token_revoked' });
  });

  it('expiry takes effect on the very next request despite a warm cache', async () => {
    let nowMs = 1_000;
    const clockedTokens = new TokensService(repos, db.handle.db, () => new Date(nowMs));
    const { plaintext } = clockedTokens.create({
      name: 'expiring',
      scope: '*',
      expiresAt: new Date(nowMs + 500),
    });
    await clockedTokens.authenticate(plaintext); // warm the cache, before expiry

    nowMs += 1_000; // advance past expiresAt

    await expect(clockedTokens.authenticate(plaintext)).rejects.toMatchObject({
      code: 'token_expired',
    });
  });

  it('a cache hit still resolves the correct token id and scope', async () => {
    const { plaintext, token } = tokens.create({ name: 'resolve-me', scope: 'read:*' });
    await tokens.authenticate(plaintext); // cold
    const resolved = await tokens.authenticate(plaintext); // warm
    expect(resolved.token.id).toBe(token.id);
    expect(resolved.scope).toBe('read:*');
  });

  it('evicts the oldest entry once the cache exceeds its bound', async () => {
    const smallCacheTokens = new TokensService(repos, db.handle.db, undefined, 2);
    const p1 = smallCacheTokens.create({ name: 'evict-1', scope: '*' }).plaintext;
    const p2 = smallCacheTokens.create({ name: 'evict-2', scope: '*' }).plaintext;
    const p3 = smallCacheTokens.create({ name: 'evict-3', scope: '*' }).plaintext;

    await smallCacheTokens.authenticate(p1);
    await smallCacheTokens.authenticate(p2);
    await smallCacheTokens.authenticate(p3); // pushes the cache past its bound of 2, evicting p1

    const listAllSpy = vi.spyOn(repos.tokens, 'listAll');
    await smallCacheTokens.authenticate(p1); // evicted — falls through to the slow path
    expect(listAllSpy).toHaveBeenCalledTimes(1);

    listAllSpy.mockClear();
    await smallCacheTokens.authenticate(p3); // still warm
    expect(listAllSpy).not.toHaveBeenCalled();
  });
});
