import { createRepositories, type Project, type Repositories } from '@rembric/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TestClock } from '../test-support/clock.js';
import { createTestDb, type TestDb } from '../test-support/db.js';

import { ProjectsService } from './projects.js';
import {
  normalizeRemote,
  normalizeRemotes,
  RepositoryBindingsService,
  type RepositoryActor,
} from './repository-bindings.js';

const F = 'f'.repeat(40);
const G = '0'.repeat(64);
const H = '1'.repeat(40);
const DAY = 86_400_000;

let db: TestDb;
let repos: Repositories;
let clock: TestClock;
let service: RepositoryBindingsService;
let shop: Project;
let sandbox: Project;
let secret: Project;

function actor(scope: RepositoryActor['scope'], tokenId = 't-admin', members: string[] = []) {
  return { tokenId, scope, memberProjectIds: members } satisfies RepositoryActor;
}

const ADMIN = actor('*');

function build(opts: { pendingTtlDays?: number; pendingMaxPerToken?: number } = {}) {
  return new RepositoryBindingsService(repos, db.handle.db, { ...opts, now: () => clock.now() });
}

beforeEach(() => {
  db = createTestDb();
  repos = createRepositories(db.handle.db);
  clock = new TestClock(new Date(100 * DAY));
  const projects = new ProjectsService(repos, () => clock.now(), db.handle.db);
  shop = projects.create({ slug: 'shop' });
  sandbox = projects.create({ slug: 'sandbox' });
  secret = projects.create({ slug: 'secret' });
  service = build();
});

afterEach(() => db.cleanup());

function writer(project: Project, tokenId = `t-${project.slug}`) {
  return actor(`project:${project.id}`, tokenId);
}

function pendingRows() {
  return db.handle.raw
    .prepare<[], Record<string, unknown>>('SELECT * FROM repository_pending ORDER BY id')
    .all();
}

function pendingTokens(fingerprint: string, kind: string) {
  return db.handle.raw
    .prepare<[string, string], { token_id: string }>(
      `SELECT t.token_id FROM repository_pending_tokens t
         JOIN repository_pending p ON p.id = t.pending_id
        WHERE p.fingerprint = ? AND p.kind = ? ORDER BY t.token_id`,
    )
    .all(fingerprint, kind)
    .map((r) => r.token_id);
}

function dump(): string {
  const tables = ['project_repositories', 'repository_pending', 'repository_pending_tokens'];
  return JSON.stringify(tables.map((t) => db.handle.raw.prepare(`SELECT * FROM ${t}`).all()));
}

describe('remote normalization', () => {
  it('reduces equivalent remotes to one form', () => {
    for (const raw of [
      'git@github.com:Acme/Shop.git',
      'https://github.com/acme/shop/',
      'ssh://git@github.com:22/acme/shop.git',
    ]) {
      expect(normalizeRemote(raw)).toBe('github.com/acme/shop');
    }
  });

  it('strips credentials, ports, queries and fragments and keeps subgroups', () => {
    expect(normalizeRemote('https://user:secret@git.example.com/acme/shop.git')).toBe(
      'git.example.com/acme/shop',
    );
    expect(normalizeRemote('https://git.example.com:8443/a/b/c.git?token=secret#x')).toBe(
      'git.example.com/a/b/c',
    );
    expect(normalizeRemote('user:secret@host.example:group/sub/repo.git')).toBe(
      'host.example/group/sub/repo',
    );
  });

  it('strips user information up to the last @, even when the password holds a slash', () => {
    for (const raw of [
      'https://user:1234/secret@git.example.com/acme/shop.git',
      'https://secret/token@git.example.com/acme/shop',
      'https://user:p?ss@git.example.com/acme/shop',
      'https://user:pa#ss@git.example.com/acme/shop',
      'https://user:se/cr@et@git.example.com/acme/shop.git',
    ]) {
      expect(normalizeRemote(raw), raw).toBe('git.example.com/acme/shop');
    }
    expect(normalizeRemote('user:se/cr@et@host.example:acme/x.git')).toBe('host.example/acme/x');
  });

  it('keeps hosts without a dot, as the clients do (SSH aliases, intranet names)', () => {
    expect(normalizeRemote('git@github-work:other/store.git')).toBe('github-work/other/store');
    expect(normalizeRemote('github-work/other/store')).toBe('github-work/other/store');
    expect(normalizeRemote('git@gitlab:group/app.git')).toBe('gitlab/group/app');
    expect(normalizeRemote('ssh://git@bitbucket:7999/team/repo.git')).toBe('bitbucket/team/repo');
  });

  it('drops values that are not a host and a path, such as local paths', () => {
    for (const raw of [
      '',
      '/home/alice/code/shop.git',
      'file:///home/alice/shop',
      'C:\\repo',
      '../shop',
      './shop',
    ]) {
      expect(normalizeRemote(raw)).toBeNull();
    }
    expect(normalizeRemote('github.com/acme/shop')).toBe('github.com/acme/shop');
    expect(
      normalizeRemotes([
        '/home/alice/x',
        'https://github.com/acme/shop',
        'git@github.com:acme/shop',
      ]),
    ).toEqual(['github.com/acme/shop']);
  });
});

describe('resolving a fingerprint within the token reach', () => {
  it('one fingerprint, two projects, two teams', () => {
    service.bind({ fingerprint: F, projectId: shop.id, createdBy: 'dashboard:t-admin' });
    service.bind({ fingerprint: F, projectId: sandbox.id, createdBy: 'dashboard:t-admin' });
    expect(service.resolve(writer(shop), { fingerprint: F, remotes: [] })).toEqual({
      outcome: 'bound',
      slug: 'shop',
    });
    expect(service.resolve(writer(sandbox), { fingerprint: F, remotes: [] })).toEqual({
      outcome: 'bound',
      slug: 'sandbox',
    });
  });

  it('a token that sees both bindings gets an ambiguity, not a guess', () => {
    service.bind({ fingerprint: F, projectId: shop.id, createdBy: 'dashboard:t-admin' });
    service.bind({ fingerprint: F, projectId: sandbox.id, createdBy: 'dashboard:t-admin' });
    const both = actor('projects', 't-both', [shop.id, sandbox.id]);
    expect(service.resolve(both, { fingerprint: F, remotes: [] })).toEqual({
      outcome: 'ambiguous',
      slugs: ['sandbox', 'shop'],
    });
    expect(pendingRows()).toEqual([]);
  });

  it('a binding the token cannot see is indistinguishable from none', () => {
    service.bind({ fingerprint: F, projectId: secret.id, createdBy: 'dashboard:t-admin' });
    const token = writer(shop);
    const invisible = service.resolve(token, { fingerprint: F, remotes: ['github.com/a/b'] });
    const none = service.resolve(token, { fingerprint: G, remotes: ['github.com/a/b'] });
    expect(invisible).toEqual(none);
    expect(invisible).toEqual({ outcome: 'unbound', reason: 'not_bound' });
  });

  it('a teammate resolves an admin binding with a read grant and records nothing', () => {
    service.bind({ fingerprint: F, projectId: shop.id, createdBy: 'dashboard:t-admin' });
    const reader = actor(`read:project:${shop.id}`, 't-reader');
    expect(service.resolve(reader, { fingerprint: F, remotes: [] })).toEqual({
      outcome: 'bound',
      slug: 'shop',
    });
  });

  it('a repository with no fingerprint resolves to no_fingerprint and records nothing', () => {
    expect(
      service.resolve(writer(shop), { fingerprint: null, remotes: ['github.com/a/b'] }),
    ).toEqual({ outcome: 'unbound', reason: 'no_fingerprint' });
    expect(pendingRows()).toEqual([]);
  });
});

describe('the unknown-remote check', () => {
  beforeEach(() => {
    service.bind({ fingerprint: F, projectId: shop.id, createdBy: 'dashboard:t-admin' });
    repos.repositoryBindings.updateRemotes(F, shop.id, ['github.com/acme/shop']);
  });

  it('holds back a project cloned from a shared boilerplate', () => {
    expect(
      service.resolve(writer(shop), { fingerprint: F, remotes: ['github.com/other/store'] }),
    ).toEqual({ outcome: 'unbound', reason: 'unknown_remote' });
    const row = repos.pendingRepositories.findByIdentity(F, 'unknown_remote', shop.id);
    expect(row?.remotes).toEqual(['github.com/other/store']);
    expect(repos.repositoryBindings.listForFingerprint(F, [shop.id])[0]?.remotes).toEqual([
      'github.com/acme/shop',
    ]);
  });

  it('holds back a remote on a host without a dot instead of ignoring it', () => {
    for (const remote of ['github-work/other/store', 'gitlab/other/store']) {
      expect(service.resolve(writer(shop), { fingerprint: F, remotes: [remote] }), remote).toEqual({
        outcome: 'unbound',
        reason: 'unknown_remote',
      });
    }
    expect(repos.pendingRepositories.findByIdentity(F, 'unknown_remote', shop.id)?.remotes).toEqual(
      ['github-work/other/store', 'gitlab/other/store'],
    );
  });

  it('resolves a fork with the original as upstream and learns the fork', () => {
    expect(
      service.resolve(writer(shop), {
        fingerprint: F,
        remotes: ['https://github.com/dev/shop.git', 'git@github.com:acme/shop.git'],
      }),
    ).toEqual({ outcome: 'bound', slug: 'shop' });
    expect(repos.repositoryBindings.listForFingerprint(F, [shop.id])[0]?.remotes).toEqual([
      'github.com/acme/shop',
      'github.com/dev/shop',
    ]);
    expect(pendingRows()).toEqual([]);
  });

  it('resolves without the check when the client sent no remote', () => {
    expect(service.resolve(writer(shop), { fingerprint: F, remotes: [] })).toEqual({
      outcome: 'bound',
      slug: 'shop',
    });
  });

  it('records the sent remotes when the binding knows none yet', () => {
    service.bind({ fingerprint: H, projectId: shop.id, createdBy: 'dashboard:t-admin' });
    expect(
      service.resolve(writer(shop), { fingerprint: H, remotes: ['github.com/acme/tools'] }),
    ).toEqual({ outcome: 'bound', slug: 'shop' });
    expect(repos.repositoryBindings.listForFingerprint(H, [shop.id])[0]?.remotes).toEqual([
      'github.com/acme/tools',
    ]);
  });
});

describe('explicit selections', () => {
  it('a .rembric overriding a binding is echoed with its conflict and leaves the binding', () => {
    service.bind({ fingerprint: F, projectId: shop.id, createdBy: 'dashboard:t-admin' });
    const both = actor('projects', 't-both', [shop.id, sandbox.id]);
    expect(
      service.resolve(both, {
        fingerprint: F,
        remotes: [],
        explicit: { slug: 'sandbox', source: 'rembric-root' },
      }),
    ).toEqual({ outcome: 'explicit', slug: 'sandbox', conflict: { boundSlugs: ['shop'] } });
    expect(repos.pendingRepositories.findByIdentity(F, 'suggestion', sandbox.id)).toBeDefined();
    expect(repos.repositoryBindings.unsafeListAllForFingerprint(F).map((b) => b.slug)).toEqual([
      'shop',
    ]);
  });

  it('does not report a conflict with a binding the token cannot see', () => {
    service.bind({ fingerprint: F, projectId: secret.id, createdBy: 'dashboard:t-admin' });
    expect(
      service.resolve(writer(shop), {
        fingerprint: F,
        remotes: [],
        explicit: { slug: 'shop', source: 'env' },
      }),
    ).toEqual({ outcome: 'explicit', slug: 'shop', conflict: null });
  });

  it('records a suggestion only for a root .rembric naming a project the token may write', () => {
    const token = writer(shop);
    service.resolve(token, {
      fingerprint: F,
      remotes: [],
      explicit: { slug: 'shop', source: 'env' },
    });
    service.resolve(token, {
      fingerprint: F,
      remotes: [],
      explicit: { slug: 'shop', source: 'rembric-nested' },
    });
    service.resolve(token, {
      fingerprint: F,
      remotes: [],
      explicit: { slug: 'sandbox', source: 'rembric-root' },
    });
    service.resolve(token, {
      fingerprint: F,
      remotes: [],
      explicit: { slug: 'nope', source: 'rembric-root' },
    });
    expect(pendingRows()).toEqual([]);
    service.resolve(token, {
      fingerprint: F,
      remotes: [],
      explicit: { slug: 'shop', source: 'rembric-root' },
    });
    expect(pendingRows()).toHaveLength(1);
    expect(repos.repositoryBindings.unsafeListAllForFingerprint(F)).toEqual([]);
  });
});

describe('pending repositories', () => {
  it('five teammates, one request', () => {
    for (let i = 0; i < 5; i++) {
      service.resolve(writer(shop, `t-mate-${i}`), {
        fingerprint: F,
        remotes: [],
        explicit: { slug: 'shop', source: 'rembric-root' },
      });
    }
    expect(pendingRows()).toHaveLength(1);
    expect(pendingTokens(F, 'suggestion')).toEqual([
      't-mate-0',
      't-mate-1',
      't-mate-2',
      't-mate-3',
      't-mate-4',
    ]);
  });

  it('records an unbound sighting with its remotes and refreshes it on a second sighting', () => {
    service.resolve(writer(shop), { fingerprint: G, remotes: ['github.com/acme/tools'] });
    clock.advance(DAY);
    service.resolve(writer(sandbox), {
      fingerprint: G,
      remotes: ['https://gitlab.com/acme/tools.git'],
    });
    const row = repos.pendingRepositories.findByIdentity(G, 'unbound', null);
    expect(row?.remotes).toEqual(['github.com/acme/tools', 'gitlab.com/acme/tools']);
    expect(row?.lastSeenAt.getTime()).toBe(101 * DAY);
    expect(row?.firstSeenAt.getTime()).toBe(100 * DAY);
    expect(pendingTokens(G, 'unbound')).toEqual(['t-sandbox', 't-shop']);
  });

  it('a read-only token creates and refreshes no pending row', () => {
    const reader = actor(`read:project:${shop.id}`, 't-reader');
    const readAll = actor('read:*', 't-read-all');
    const readSet = actor('read:projects', 't-read-set', [shop.id]);
    for (const token of [reader, readAll, readSet]) {
      expect(service.resolve(token, { fingerprint: G, remotes: ['github.com/a/b'] })).toEqual({
        outcome: 'unbound',
        reason: 'not_bound',
      });
      service.resolve(token, {
        fingerprint: G,
        remotes: [],
        explicit: { slug: 'shop', source: 'rembric-root' },
      });
    }
    expect(pendingRows()).toEqual([]);
    service.resolve(writer(shop), { fingerprint: G, remotes: [] });
    const before = dump();
    clock.advance(DAY);
    service.resolve(reader, { fingerprint: G, remotes: ['github.com/new/remote'] });
    expect(dump()).toBe(before);
  });

  it('a discarded repository stays discarded and keeps its sightings', () => {
    service.resolve(writer(shop), { fingerprint: G, remotes: [] });
    const row = repos.pendingRepositories.findByIdentity(G, 'unbound', null)!;
    service.discard(row.id);
    clock.advance(30 * DAY);
    service.resolve(writer(shop), { fingerprint: G, remotes: [] });
    const cutoff = new Date(clock.now().getTime() - 14 * DAY);
    expect(repos.pendingRepositories.adminListLive(cutoff)).toEqual([]);
    const discarded = repos.pendingRepositories.adminListDiscarded();
    expect(discarded.map((r) => r.id)).toEqual([row.id]);
    expect(discarded[0]?.lastSeenAt.getTime()).toBe(130 * DAY);
    service.restore(row.id);
    expect(repos.pendingRepositories.adminListLive(cutoff).map((r) => r.id)).toEqual([row.id]);
  });

  it('the per-token limit stops new rows only', () => {
    const limited = build({ pendingMaxPerToken: 2 });
    const token = writer(shop);
    limited.resolve(token, { fingerprint: F, remotes: [] });
    limited.resolve(token, { fingerprint: G, remotes: [] });
    clock.advance(DAY);
    limited.resolve(token, { fingerprint: H, remotes: [] });
    limited.resolve(token, { fingerprint: F, remotes: ['github.com/acme/f'] });
    expect(repos.pendingRepositories.findByIdentity(H, 'unbound', null)).toBeUndefined();
    const refreshed = repos.pendingRepositories.findByIdentity(F, 'unbound', null);
    expect(refreshed?.lastSeenAt.getTime()).toBe(101 * DAY);
    expect(refreshed?.remotes).toEqual(['github.com/acme/f']);
    limited.resolve(writer(sandbox), { fingerprint: H, remotes: [] });
    expect(repos.pendingRepositories.findByIdentity(H, 'unbound', null)).toBeDefined();
  });

  it('an expired row neither lists nor counts toward the limit', () => {
    const limited = build({ pendingMaxPerToken: 1, pendingTtlDays: 14 });
    const token = writer(shop);
    limited.resolve(token, { fingerprint: F, remotes: [] });
    clock.advance(15 * DAY);
    limited.resolve(token, { fingerprint: G, remotes: [] });
    const cutoff = new Date(clock.now().getTime() - 14 * DAY);
    expect(repos.pendingRepositories.adminListLive(cutoff).map((r) => r.fingerprint)).toEqual([G]);
    limited.resolve(token, { fingerprint: F, remotes: [] });
    expect(repos.pendingRepositories.adminListLive(cutoff).map((r) => r.fingerprint)).toEqual([G]);
  });

  it('no local path is stored, only the root basename and only without a remote', () => {
    service.resolve(writer(shop), {
      fingerprint: G,
      remotes: ['/home/alice/code/shop.git'],
      rootName: 'shop',
    });
    const row = repos.pendingRepositories.findByIdentity(G, 'unbound', null);
    expect(row?.rootName).toBe('shop');
    expect(dump()).not.toContain('/home/alice');
    service.resolve(writer(shop), {
      fingerprint: G,
      remotes: ['git@github.com:acme/shop.git'],
      rootName: 'shop',
    });
    expect(repos.pendingRepositories.findByIdentity(G, 'unbound', null)?.rootName).toBeNull();
  });

  it('never persists a credential sent in an unnormalized remote', () => {
    service.resolve(writer(shop), {
      fingerprint: G,
      remotes: ['https://user:secret@git.example.com/acme/shop.git'],
    });
    expect(repos.pendingRepositories.findByIdentity(G, 'unbound', null)?.remotes).toEqual([
      'git.example.com/acme/shop',
    ]);
    expect(dump()).not.toContain('secret');
  });

  it('a checkout that used the default project becomes pending', () => {
    expect(service.resolve(writer(shop), { fingerprint: H, remotes: [] })).toEqual({
      outcome: 'unbound',
      reason: 'not_bound',
    });
    expect(repos.pendingRepositories.findByIdentity(H, 'unbound', null)).toBeDefined();
  });
});

describe('binding', () => {
  it('bindUnbound creates the binding, copies pending remotes and clears the unbound row', () => {
    service.resolve(writer(shop), { fingerprint: F, remotes: ['github.com/acme/shop'] });
    expect(
      service.bindUnbound({ fingerprint: F, slug: 'shop', createdBy: 'token:t-admin' }),
    ).toEqual({ slug: 'shop', fingerprint: F });
    expect(repos.repositoryBindings.unsafeListAllForFingerprint(F)).toEqual([
      expect.objectContaining({
        slug: 'shop',
        remotes: ['github.com/acme/shop'],
        createdBy: 'token:t-admin',
      }),
    ]);
    expect(repos.pendingRepositories.findByIdentity(F, 'unbound', null)).toBeUndefined();
    expect(service.resolve(writer(shop), { fingerprint: F, remotes: [] })).toEqual({
      outcome: 'bound',
      slug: 'shop',
    });
  });

  it('bindUnbound refuses a fingerprint that has any binding, naming every bound project', () => {
    service.bind({ fingerprint: F, projectId: secret.id, createdBy: 'dashboard:t-admin' });
    expect(() =>
      service.bindUnbound({ fingerprint: F, slug: 'store', createdBy: 'token:t-admin' }),
    ).toThrow(/project_not_found|does not exist/);
    let caught: unknown;
    try {
      service.bindUnbound({ fingerprint: F, slug: 'shop', createdBy: 'token:t-admin' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: 'repository_already_bound' });
    expect((caught as Error).message).toContain("'secret'");
    expect((caught as Error).message).toContain('dashboard');
    expect(repos.repositoryBindings.unsafeListAllForFingerprint(F).map((b) => b.slug)).toEqual([
      'secret',
    ]);
  });

  it('bindUnbound refuses an archived project', () => {
    const projects = new ProjectsService(repos, () => clock.now(), db.handle.db);
    projects.archive(sandbox.id);
    expect(() =>
      service.bindUnbound({ fingerprint: F, slug: 'sandbox', createdBy: 'token:t-admin' }),
    ).toThrow(expect.objectContaining({ code: 'project_archived' }) as Error);
    expect(repos.repositoryBindings.unsafeListAllForFingerprint(F)).toEqual([]);
  });

  it('a binding moved mid-session applies to the next resolution', () => {
    service.bind({ fingerprint: F, projectId: shop.id, createdBy: 'dashboard:t-admin' });
    expect(service.resolve(ADMIN, { fingerprint: F, remotes: [] })).toEqual({
      outcome: 'bound',
      slug: 'shop',
    });
    service.move({
      fingerprint: F,
      fromProjectId: shop.id,
      toProjectId: sandbox.id,
      createdBy: 'dashboard:t-admin',
    });
    expect(service.resolve(ADMIN, { fingerprint: F, remotes: [] })).toEqual({
      outcome: 'bound',
      slug: 'sandbox',
    });
    service.remove({ fingerprint: F, projectId: sandbox.id });
    expect(service.resolve(ADMIN, { fingerprint: F, remotes: [] })).toEqual({
      outcome: 'unbound',
      reason: 'not_bound',
    });
  });

  it('bind refuses the same pair twice', () => {
    service.bind({ fingerprint: F, projectId: shop.id, createdBy: 'dashboard:t-admin' });
    expect(() =>
      service.bind({ fingerprint: F, projectId: shop.id, createdBy: 'dashboard:t-admin' }),
    ).toThrow(expect.objectContaining({ code: 'repository_already_bound' }) as Error);
  });

  it('acceptRemotes adds an unknown remote to its binding and clears the row', () => {
    service.bind({ fingerprint: F, projectId: shop.id, createdBy: 'dashboard:t-admin' });
    repos.repositoryBindings.updateRemotes(F, shop.id, ['github.com/acme/shop']);
    service.resolve(writer(shop), { fingerprint: F, remotes: ['github.com/acme/renamed'] });
    const row = repos.pendingRepositories.findByIdentity(F, 'unknown_remote', shop.id)!;
    service.acceptRemotes(row.id);
    expect(repos.repositoryBindings.listForFingerprint(F, [shop.id])[0]?.remotes).toEqual([
      'github.com/acme/renamed',
      'github.com/acme/shop',
    ]);
    expect(repos.pendingRepositories.findById(row.id)).toBeUndefined();
  });
});
