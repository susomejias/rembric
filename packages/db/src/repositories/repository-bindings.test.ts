import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories, type Repositories } from '../index.js';
import { createTestDb, type TestDb } from '../test-support/db.js';

const F = 'a'.repeat(40);
const G = 'b'.repeat(40);
const DAY = 86_400_000;

let db: TestDb;
let repos: Repositories;
let shop: string;
let sandbox: string;

beforeEach(() => {
  db = createTestDb();
  repos = createRepositories(db.handle.db);
  shop = repos.projects.insert({ id: 'p-shop', slug: 'shop', createdAt: new Date(0) })!.id;
  sandbox = repos.projects.insert({ id: 'p-sandbox', slug: 'sandbox', createdAt: new Date(0) })!.id;
});

afterEach(() => db.cleanup());

function bind(fingerprint: string, projectId: string, remotes: string[] = []) {
  return repos.repositoryBindings.insert({
    fingerprint,
    projectId,
    remotes,
    createdAt: new Date(1),
    createdBy: 'token:t1',
  });
}

function pending(
  fingerprint: string,
  kind: 'unbound' | 'suggestion' | 'unknown_remote',
  projectId: string | null,
  lastSeenAt: number,
  id = `${fingerprint.slice(0, 4)}-${kind}-${projectId ?? 'none'}`,
) {
  return repos.pendingRepositories.insert({
    id,
    fingerprint,
    kind,
    projectId,
    remotes: [],
    rootName: null,
    firstSeenAt: new Date(lastSeenAt),
    lastSeenAt: new Date(lastSeenAt),
  });
}

describe('repository bindings', () => {
  it('are unique per (fingerprint, project) but a fingerprint may bind several projects', () => {
    expect(bind(F, shop)).toBeDefined();
    expect(bind(F, shop)).toBeUndefined();
    expect(bind(F, sandbox)).toBeDefined();
    expect(repos.repositoryBindings.unsafeListAllForFingerprint(F).map((b) => b.slug)).toEqual([
      'sandbox',
      'shop',
    ]);
  });

  it('lists only the bindings whose project is in the given readable set', () => {
    bind(F, shop, ['github.com/acme/shop']);
    bind(F, sandbox);
    const visible = repos.repositoryBindings.listForFingerprint(F, [shop]);
    expect(visible).toEqual([
      expect.objectContaining({ slug: 'shop', projectId: shop, remotes: ['github.com/acme/shop'] }),
    ]);
    expect(repos.repositoryBindings.listForFingerprint(F, [])).toEqual([]);
    expect(repos.repositoryBindings.listForFingerprint(G, [shop, sandbox])).toEqual([]);
  });

  it('updates remotes and deletes a single pair', () => {
    bind(F, shop);
    bind(F, sandbox);
    repos.repositoryBindings.updateRemotes(F, shop, ['github.com/acme/shop']);
    expect(repos.repositoryBindings.listForFingerprint(F, [shop])[0]?.remotes).toEqual([
      'github.com/acme/shop',
    ]);
    expect(repos.repositoryBindings.delete(F, shop)).toBe(true);
    expect(repos.repositoryBindings.delete(F, shop)).toBe(false);
    expect(repos.repositoryBindings.unsafeListAllForFingerprint(F).map((b) => b.slug)).toEqual([
      'sandbox',
    ]);
  });
});

describe('pending repositories', () => {
  it('deduplicates on (fingerprint, kind, project) with an absent project as one key', () => {
    pending(F, 'unbound', null, 10, 'one');
    expect(() => pending(F, 'unbound', null, 10, 'two')).toThrow(/UNIQUE/);
    expect(pending(F, 'suggestion', shop, 10, 'three')).toBeDefined();
    expect(() => pending(F, 'suggestion', shop, 10, 'four')).toThrow(/UNIQUE/);
    expect(pending(F, 'suggestion', sandbox, 10, 'five')).toBeDefined();
    expect(repos.pendingRepositories.findByIdentity(F, 'unbound', null)?.id).toBe('one');
    expect(repos.pendingRepositories.findByIdentity(F, 'suggestion', shop)?.id).toBe('three');
    expect(repos.pendingRepositories.findByIdentity(F, 'suggestion', null)).toBeUndefined();
  });

  it('refuses a kind outside the closed set', () => {
    expect(() =>
      db.handle.raw
        .prepare(
          `INSERT INTO repository_pending (id, fingerprint, kind, remotes, first_seen_at, last_seen_at)
           VALUES ('x', ?, 'other', '[]', 0, 0)`,
        )
        .run(F),
    ).toThrow(/CHECK/);
  });

  it('counts only live, undiscarded rows a token appears in', () => {
    const now = 100 * DAY;
    const cutoff = new Date(now - 14 * DAY);
    const live = pending(F, 'unbound', null, now - DAY, 'live');
    const expired = pending(G, 'unbound', null, now - 15 * DAY, 'expired');
    const discarded = pending(F, 'suggestion', shop, now - DAY, 'discarded');
    const other = pending(G, 'suggestion', shop, now - DAY, 'other');
    for (const row of [live, expired, discarded]) {
      repos.pendingRepositories.linkToken(row.id, 't1');
      repos.pendingRepositories.linkToken(row.id, 't1');
    }
    repos.pendingRepositories.linkToken(other.id, 't2');
    repos.pendingRepositories.setDiscardedAt(discarded.id, new Date(now));

    expect(repos.pendingRepositories.countLiveForToken('t1', cutoff)).toBe(1);
    expect(repos.pendingRepositories.countLiveForToken('t2', cutoff)).toBe(1);
    expect(repos.pendingRepositories.countLiveForToken('t3', cutoff)).toBe(0);
  });

  it('lists live rows apart from expired and discarded ones', () => {
    const now = 100 * DAY;
    const cutoff = new Date(now - 14 * DAY);
    pending(F, 'unbound', null, now - DAY, 'live');
    pending(G, 'unbound', null, now - 15 * DAY, 'expired');
    pending(F, 'suggestion', shop, now - 30 * DAY, 'discarded');
    repos.pendingRepositories.setDiscardedAt('discarded', new Date(now));

    expect(repos.pendingRepositories.adminListLive(cutoff).map((r) => r.id)).toEqual(['live']);
    expect(repos.pendingRepositories.adminListDiscarded().map((r) => r.id)).toEqual(['discarded']);
    repos.pendingRepositories.setDiscardedAt('discarded', null);
    expect(repos.pendingRepositories.adminListLive(cutoff).map((r) => r.id)).toEqual(['live']);
  });

  it('deletes a row together with its token links', () => {
    const row = pending(F, 'unbound', null, 10);
    repos.pendingRepositories.linkToken(row.id, 't1');
    expect(repos.pendingRepositories.delete(row.id)).toBe(true);
    expect(repos.pendingRepositories.findById(row.id)).toBeUndefined();
    expect(repos.pendingRepositories.adminListTokens([row.id])).toEqual([]);
    expect(repos.pendingRepositories.delete(row.id)).toBe(false);
  });

  it('names the tokens of a row, falling back to the id for a token with no row', () => {
    const row = pending(F, 'unbound', null, 10);
    repos.pendingRepositories.linkToken(row.id, 'oauth:client-1');
    expect(repos.pendingRepositories.adminListTokens([row.id])).toEqual([
      { pendingId: row.id, tokenId: 'oauth:client-1', tokenName: null },
    ]);
  });
});
