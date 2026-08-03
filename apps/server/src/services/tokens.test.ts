import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { isAuthorized, TokensService, type CreateTokenInput } from './tokens.js';

let db: TestDb;
let tokens: TokensService;

beforeEach(() => {
  db = createTestDb();
  tokens = new TokensService(createRepositories(db.handle.db));
});

afterEach(() => {
  db.cleanup();
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
    // Enforced by `tsc`, not by this assertion: widening `CreateTokenInput.scope`
    // to an arbitrary string makes the directives below unused and reds the build
    // (openspec/specs/auth/spec.md "The project segment cannot be supplied as a slug").
    const rejected: CreateTokenInput[] = [
      // @ts-expect-error `project:<id>` must be composed from a resolved project row, never accepted here
      { name: 'slug-write', scope: 'project:alpha' },
      // @ts-expect-error same for the read arm, `read:project:<id>`
      { name: 'slug-read', scope: 'read:project:alpha' },
    ];
    expect(rejected).toHaveLength(2);
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

describe('isAuthorized', () => {
  it('admin can do anything', () => {
    expect(isAuthorized('*', 'write', { scope: 'global' })).toBe(true);
    expect(isAuthorized('*', 'read', { scope: 'project', projectId: 'p' })).toBe(true);
  });

  it('read:* allows reads but rejects writes', () => {
    expect(isAuthorized('read:*', 'read', { scope: 'global' })).toBe(true);
    expect(isAuthorized('read:*', 'write', { scope: 'global' })).toBe(false);
  });

  it('project:<id> restricts to that project', () => {
    expect(isAuthorized('project:abc', 'write', { scope: 'project', projectId: 'abc' })).toBe(true);
    expect(isAuthorized('project:abc', 'write', { scope: 'project', projectId: 'xyz' })).toBe(
      false,
    );
    expect(isAuthorized('project:abc', 'write', { scope: 'global' })).toBe(false);
    // The premise the include_global widening gate rests on: neither
    // project-pinned form may READ global either.
    expect(isAuthorized('project:abc', 'read', { scope: 'global' })).toBe(false);
    expect(isAuthorized('read:project:abc', 'read', { scope: 'global' })).toBe(false);
  });

  it('read:project:<id> only allows reads of that project', () => {
    expect(isAuthorized('read:project:abc', 'read', { scope: 'project', projectId: 'abc' })).toBe(
      true,
    );
    expect(isAuthorized('read:project:abc', 'write', { scope: 'project', projectId: 'abc' })).toBe(
      false,
    );
  });
});

describe('TokensService.authenticate — verified-credential cache (#266)', () => {
  let repos: Repositories;

  beforeEach(() => {
    repos = createRepositories(db.handle.db);
  });

  it('skips the scrypt scan on a repeat authenticate() call for the same token', async () => {
    // Constructed over the SAME `repos` instance the spy watches — the
    // shared `tokens` from the outer beforeEach wraps its own, separate
    // Repositories object, so a spy on this file's `repos` would never
    // observe calls made through it.
    const scopedTokens = new TokensService(repos);
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
    const clockedTokens = new TokensService(repos, () => new Date(nowMs));
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
    // Small injected bound so this proves the eviction policy without
    // paying for dozens of real scrypt verifies (the whole point of #266).
    const smallCacheTokens = new TokensService(repos, undefined, 2);
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
