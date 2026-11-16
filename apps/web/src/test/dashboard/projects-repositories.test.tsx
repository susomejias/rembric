import {
  ProjectsService,
  RepositoryBindingsService,
  TokensService,
  type RepositoryActor,
} from '@rembric/core';
import { createRepositories, type Project, type Repositories } from '@rembric/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../db';

import { buildDashboardServices, installViewMocks, renderToHtml, servicesRef } from './harness';

installViewMocks('/dashboard/projects');

let t: TestDb;
let repos: Repositories;
let bindings: RepositoryBindingsService;
let shop: Project;
let writer: RepositoryActor;

const F = 'a'.repeat(40);
const G = 'b'.repeat(40);
const H = 'c'.repeat(64);
const K = 'd'.repeat(40);

beforeEach(async () => {
  t = createTestDb();
  servicesRef.current = buildDashboardServices(t.handle);
  repos = createRepositories(t.handle.db);
  const projects = new ProjectsService(repos, undefined, t.handle.db);
  shop = projects.create({ slug: 'shop' });
  projects.create({ slug: 'sandbox' });
  bindings = new RepositoryBindingsService(repos, t.handle.db);
  const tokens = new TokensService(repos, t.handle.db);
  const created = tokens.createForSlugs(
    { name: 'laptop', slugs: ['shop', 'sandbox'], access: 'write' },
    projects,
  );
  const reach = await tokens.authenticate(created.plaintext);
  writer = { ...reach, tokenId: reach.token.id };
});

afterEach(() => t.cleanup());

async function renderProjects(): Promise<string> {
  const page = (await import('../../app/dashboard/projects/page')).default;
  return renderToHtml(await page({ searchParams: Promise.resolve({}) }));
}

async function renderPending(view?: string): Promise<string> {
  const page = (await import('../../app/dashboard/projects/repositories/page')).default;
  return renderToHtml(await page({ searchParams: Promise.resolve(view ? { view } : {}) }));
}

function pendingCount(html: string): string | undefined {
  return /data-pending-repositories="(\d+)"/.exec(html)?.[1];
}

function card(html: string, kind: string): string {
  const chunk = html.split('<li').find((c) => c.includes(`data-pending-kind="${kind}"`));
  if (chunk === undefined) throw new Error(`no ${kind} card`);
  return chunk.split('</li>')[0]!.replaceAll('<!-- -->', '');
}

function hasSubmit(html: string, name: string, value: string): boolean {
  return [...html.matchAll(/<button[^>]*>/g)].some(
    ([tag]) =>
      tag.includes('type="submit"') &&
      tag.includes(`name="${name}"`) &&
      tag.includes(`value="${value}"`),
  );
}

function seedThreeLiveOneDiscarded(): string {
  bindings.resolve(writer, { fingerprint: F, remotes: ['https://github.com/acme/shop'] });
  bindings.resolve(writer, {
    fingerprint: G,
    remotes: [],
    rootName: 'store',
    explicit: { slug: 'shop', source: 'rembric-root' },
  });
  bindings.resolve(writer, { fingerprint: H, remotes: ['github.com/acme/tools'] });
  bindings.resolve(writer, { fingerprint: K, remotes: ['github.com/acme/old'] });
  const discarded = repos.pendingRepositories.findByIdentity(K, 'unbound', null)!;
  bindings.discard(discarded.id);
  return discarded.id;
}

describe('the projects list counts pending repositories', () => {
  it('counts live pending rows only', async () => {
    seedThreeLiveOneDiscarded();
    const html = await renderProjects();
    expect(pendingCount(html)).toBe('3');
    expect(html).toContain('href="/dashboard/projects/repositories"');
  });

  it('counts a restored row again', async () => {
    const discardedId = seedThreeLiveOneDiscarded();
    bindings.restore(discardedId);
    expect(pendingCount(await renderProjects())).toBe('4');
  });

  it('reads 0 with nothing pending', async () => {
    expect(pendingCount(await renderProjects())).toBe('0');
  });
});

describe('the pending view', () => {
  it('lists each kind with its remotes, fingerprint prefix, tokens and times', async () => {
    bindings.bind({ fingerprint: H, projectId: shop.id, createdBy: 'dashboard:seed' });
    repos.repositoryBindings.updateRemotes(H, shop.id, ['github.com/acme/tools']);
    bindings.resolve(writer, {
      fingerprint: F,
      remotes: ['https://user:secret@github.com/acme/web'],
    });
    bindings.resolve(writer, {
      fingerprint: G,
      remotes: [],
      rootName: 'store',
      explicit: { slug: 'sandbox', source: 'rembric-root' },
    });
    bindings.resolve(writer, { fingerprint: H, remotes: ['github.com/other/store'] });

    const html = await renderPending();

    const unbound = card(html, 'unbound');
    expect(unbound).toContain('</span>unbound</span>');
    expect(unbound).toContain('github.com/acme/web');
    expect(unbound).not.toContain('secret');
    expect(unbound).toContain(`fingerprint ${F.slice(0, 12)}`);
    expect(unbound).toContain('Sighted by laptop');
    expect((unbound.match(/data-rembric-ts/g) ?? []).length).toBe(2);
    expect(unbound).toContain('Choose a project…');

    const suggestion = card(html, 'suggestion');
    expect(suggestion).toContain('</span>suggestion</span>');
    expect(suggestion).toContain('>store</span>');
    expect(suggestion).toContain(`fingerprint ${G.slice(0, 12)}`);
    expect(suggestion).toContain('A root .rembric selects sandbox.');
    expect(suggestion).toContain('Bind to sandbox');

    const unknown = card(html, 'unknown_remote');
    expect(unknown).toContain('</span>unknown remote</span>');
    expect(unknown).toContain('Bound to shop, which has never seen github.com/other/store.');
    expect(unknown).toContain('Accept remote into shop');
    expect(unknown).toContain('Another project…');

    for (const kind of ['unbound', 'suggestion', 'unknown_remote']) {
      expect(card(html, kind)).toContain('>Discard</button>');
    }
  });

  it('shows a conflicting suggestion with both projects and the move-or-add choice', async () => {
    bindings.bind({ fingerprint: F, projectId: shop.id, createdBy: 'dashboard:seed' });
    bindings.resolve(writer, {
      fingerprint: F,
      remotes: [],
      explicit: { slug: 'sandbox', source: 'rembric-root' },
    });

    const conflict = card(await renderPending(), 'suggestion');

    expect(conflict).toContain('</span>conflict</span>');
    expect(conflict).toContain('Bound to shop; a root .rembric selects sandbox.');
    expect(hasSubmit(conflict, 'moveFrom', shop.id)).toBe(true);
    expect(conflict).toContain('Move from shop');
    expect(hasSubmit(conflict, 'choice', 'add')).toBe(true);
    expect(conflict).toContain('ambiguity');
    expect(conflict).not.toContain('Bind to sandbox');
  });

  it('keeps discarded rows out of the pending view and offers restore in the discarded view', async () => {
    seedThreeLiveOneDiscarded();
    const pending = await renderPending();
    expect(pending).not.toContain('github.com/acme/old');
    expect(pending).not.toContain('>Restore</button>');

    const discarded = await renderPending('discarded');
    expect(discarded).toContain('github.com/acme/old');
    expect(discarded).toContain('>Restore</button>');
    expect(discarded).not.toContain('>Discard</button>');
    expect(discarded).toContain('discarded <time');
  });
});
