import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { isAuthorized, TokensService } from './tokens.js';

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
