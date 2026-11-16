import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@/lib/actions/guard', async () => await import('../../lib/actions/guard'));
vi.mock('@/lib/services', async () => await import('../../lib/services'));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import {
  deriveSessionKey,
  ProjectsService,
  RepositoryBindingsService,
  SessionsService,
  TokensService,
  type RepositoryActor,
} from '@rembric/core';
import { createDb, createRepositories, type DbHandle, type Repositories } from '@rembric/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionCookieSource } from '../../lib/session';

const requestCookies = vi.hoisted(() => ({ current: null as SessionCookieSource | null }));
vi.mock('next/headers', () => ({ cookies: () => requestCookies.current }));

const ADMIN_TOKEN = 'repository-actions-test-admin-not-a-real-secret';
const previousDataDir = process.env['REMBRIC_DATA_DIR'];
const previousAdminToken = process.env['REMBRIC_ADMIN_TOKEN'];

let handle: DbHandle;
let dataDir: string;
let repos: Repositories;
let bindings: RepositoryBindingsService;
let projects: ProjectsService;
let sessions: SessionsService;
let admin: ReturnType<SessionsService['create']>;
let limited: ReturnType<SessionsService['create']>;
let writerReach: RepositoryActor;
let shopId: string;
let sandboxId: string;
let sequence = 0;

type Action = (state: { error: string | null }, data: FormData) => Promise<unknown>;

function nextFingerprint(): string {
  sequence += 1;
  return sequence.toString(16).padStart(40, '0');
}

function cookieSource(cookie: string | null): SessionCookieSource {
  return {
    get: (name) =>
      cookie !== null && name === SessionsService.cookieName() ? { value: cookie } : undefined,
  };
}

function form(formName: string, fields: Record<string, string | string[]>): FormData {
  const data = new FormData();
  data.set('csrf', sessions.csrfToken(admin.session, formName));
  for (const [key, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) data.append(key, item);
  }
  return data;
}

async function actions() {
  return await import('../../app/dashboard/projects/actions');
}

async function redirectTarget(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const digest = (error as { digest?: unknown }).digest;
    if (typeof digest === 'string') return decodeURIComponent(digest);
    throw error;
  }
  throw new Error('expected redirect');
}

function boundSlugs(fingerprint: string): string[] {
  return repos.repositoryBindings.unsafeListAllForFingerprint(fingerprint).map((b) => b.slug);
}

function sightUnbound(fingerprint: string, remotes: string[] = []) {
  bindings.resolve(writerReach, { fingerprint, remotes });
  return repos.pendingRepositories.findByIdentity(fingerprint, 'unbound', null)!;
}

function suggest(fingerprint: string, slug: string) {
  bindings.resolve(writerReach, {
    fingerprint,
    remotes: [],
    explicit: { slug, source: 'rembric-root' },
  });
  const project = repos.projects.findBySlug(slug)!;
  return repos.pendingRepositories.findByIdentity(fingerprint, 'suggestion', project.id)!;
}

function snapshot(): string {
  return JSON.stringify([
    handle.raw.prepare('SELECT * FROM project_repositories ORDER BY fingerprint').all(),
    handle.raw.prepare('SELECT * FROM repository_pending ORDER BY id').all(),
    handle.raw.prepare('SELECT id, slug FROM projects ORDER BY id').all(),
  ]);
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'rembric-repository-actions-'));
  handle = createDb({ dataDir, onMigrationProgress: () => {}, onStartupLog: () => {} });
  repos = createRepositories(handle.db);
  const tokens = new TokensService(repos, handle.db);
  projects = new ProjectsService(repos, undefined, handle.db);
  bindings = new RepositoryBindingsService(repos, handle.db);
  shopId = projects.create({ slug: 'shop' }).id;
  sandboxId = projects.create({ slug: 'sandbox' }).id;
  const adminToken = tokens.create({ name: 'admin', scope: '*' });
  const limitedToken = tokens.create({ name: 'limited', scope: 'read:*' });
  const writer = tokens.createForSlugs(
    { name: 'writer', slugs: ['shop', 'sandbox'], access: 'write' },
    projects,
  );
  const reach = await tokens.authenticate(writer.plaintext);
  writerReach = { ...reach, tokenId: reach.token.id };
  sessions = new SessionsService(repos, deriveSessionKey(ADMIN_TOKEN));
  admin = sessions.create(adminToken.token.id);
  limited = sessions.create(limitedToken.token.id);
  process.env['REMBRIC_DATA_DIR'] = dataDir;
  process.env['REMBRIC_ADMIN_TOKEN'] = ADMIN_TOKEN;
});

afterAll(() => {
  handle.close();
  rmSync(dataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env['REMBRIC_DATA_DIR'];
  else process.env['REMBRIC_DATA_DIR'] = previousDataDir;
  if (previousAdminToken === undefined) delete process.env['REMBRIC_ADMIN_TOKEN'];
  else process.env['REMBRIC_ADMIN_TOKEN'] = previousAdminToken;
});

beforeEach(() => {
  requestCookies.current = cookieSource(admin.cookie);
});

describe('binding a repository from the project edit surface', () => {
  it('binds a pending unbound row to the project with its remote and clears the row', async () => {
    const F = nextFingerprint();
    const row = sightUnbound(F, ['https://github.com/acme/shop.git']);
    const { bindRepository } = await actions();

    const result = await bindRepository(
      { error: null },
      form('repository.bind', { pendingId: row.id, projectId: shopId }),
    );

    expect(result).toEqual({ error: null });
    expect(repos.repositoryBindings.unsafeListAllForFingerprint(F)).toEqual([
      expect.objectContaining({
        slug: 'shop',
        remotes: ['github.com/acme/shop'],
        createdBy: `dashboard:${admin.session.tokenId}`,
      }),
    ]);
    expect(repos.pendingRepositories.findById(row.id)).toBeUndefined();
  });

  it('binds a pasted well-formed fingerprint', async () => {
    const F = nextFingerprint();
    const { bindRepository } = await actions();
    expect(
      await bindRepository(
        { error: null },
        form('repository.bind', { fingerprint: F, projectId: shopId }),
      ),
    ).toEqual({ error: null });
    expect(boundSlugs(F)).toEqual(['shop']);
  });

  it.each(['abc123', 'F'.repeat(40), 'g'.repeat(40), '0'.repeat(41), ''])(
    'refuses the malformed fingerprint %j, naming the format, and creates no binding',
    async (fingerprint) => {
      const { bindRepository } = await actions();
      const before = snapshot();
      const result = (await bindRepository(
        { error: null },
        form('repository.bind', { fingerprint, projectId: shopId }),
      )) as { error: string };
      expect(result.error).toContain('40 or 64 lowercase hexadecimal characters');
      expect(snapshot()).toBe(before);
    },
  );
});

describe('a suggestion that conflicts with an existing binding', () => {
  async function conflict() {
    const F = nextFingerprint();
    bindings.bind({ fingerprint: F, projectId: shopId, createdBy: 'dashboard:seed' });
    const row = suggest(F, 'sandbox');
    return { F, row, bindRepository: (await actions()).bindRepository };
  }

  it('asks to choose between moving and adding, changing nothing', async () => {
    const { F, row, bindRepository } = await conflict();
    const before = snapshot();
    const result = await bindRepository(
      { error: null },
      form('repository.bind', { pendingId: row.id, projectId: sandboxId }),
    );
    expect(result).toMatchObject({
      error: expect.stringContaining("'shop'") as string,
      conflict: { bound: [{ id: shopId, slug: 'shop' }] },
    });
    expect(snapshot()).toBe(before);
    expect(boundSlugs(F)).toEqual(['shop']);
  });

  it('moving leaves the fingerprint bound to sandbox only', async () => {
    const { F, row, bindRepository } = await conflict();
    expect(
      await bindRepository(
        { error: null },
        form('repository.bind', { pendingId: row.id, projectId: sandboxId, moveFrom: shopId }),
      ),
    ).toEqual({ error: null });
    expect(boundSlugs(F)).toEqual(['sandbox']);
    expect(repos.pendingRepositories.findById(row.id)).toBeUndefined();
  });

  it('adding keeps both bindings', async () => {
    const { F, row, bindRepository } = await conflict();
    expect(
      await bindRepository(
        { error: null },
        form('repository.bind', { pendingId: row.id, projectId: sandboxId, choice: 'add' }),
      ),
    ).toEqual({ error: null });
    expect(boundSlugs(F)).toEqual(['sandbox', 'shop']);
  });
});

describe('domain errors from another module instance', () => {
  it('are still returned as form errors, as the dev server loads core twice', async () => {
    const foreign = Object.assign(new Error("this repository is already bound to 'shop'"), {
      name: 'DomainError',
      code: 'repository_already_bound',
      details: { boundProjects: [{ id: shopId, slug: 'shop' }] },
    });
    const spy = vi
      .spyOn(RepositoryBindingsService.prototype, 'bindWithChoice')
      .mockImplementation(() => {
        throw foreign;
      });
    try {
      const { bindRepository } = await actions();
      expect(
        await bindRepository(
          { error: null },
          form('repository.bind', { fingerprint: nextFingerprint(), projectId: sandboxId }),
        ),
      ).toEqual({
        error: foreign.message,
        conflict: { bound: [{ id: shopId, slug: 'shop' }] },
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('removing, accepting, discarding and restoring', () => {
  it('removes a binding and reports one that is already gone', async () => {
    const F = nextFingerprint();
    bindings.bind({ fingerprint: F, projectId: shopId, createdBy: 'dashboard:seed' });
    const { removeRepositoryBinding } = await actions();
    const data = () => form('repository.remove', { fingerprint: F, projectId: shopId });
    expect(await removeRepositoryBinding({ error: null }, data())).toEqual({ error: null });
    expect(boundSlugs(F)).toEqual([]);
    expect(await removeRepositoryBinding({ error: null }, data())).toEqual({
      error: 'This binding no longer exists.',
    });
  });

  it('accepts an unknown remote into the binding', async () => {
    const F = nextFingerprint();
    bindings.bind({ fingerprint: F, projectId: shopId, createdBy: 'dashboard:seed' });
    repos.repositoryBindings.updateRemotes(F, shopId, ['github.com/acme/shop']);
    bindings.resolve(writerReach, { fingerprint: F, remotes: ['github.com/other/store'] });
    const row = repos.pendingRepositories.findByIdentity(F, 'unknown_remote', shopId)!;
    const { acceptRepositoryRemotes } = await actions();
    expect(
      await acceptRepositoryRemotes(
        { error: null },
        form('repository.accept-remotes', { pendingId: row.id }),
      ),
    ).toEqual({ error: null });
    expect(repos.repositoryBindings.unsafeListAllForFingerprint(F)[0]?.remotes).toEqual([
      'github.com/acme/shop',
      'github.com/other/store',
    ]);
  });

  it('binds an unknown-remote row to another project and clears the row', async () => {
    const F = nextFingerprint();
    bindings.bind({ fingerprint: F, projectId: shopId, createdBy: 'dashboard:seed' });
    repos.repositoryBindings.updateRemotes(F, shopId, ['github.com/acme/shop']);
    bindings.resolve(writerReach, { fingerprint: F, remotes: ['github.com/other/store'] });
    const row = repos.pendingRepositories.findByIdentity(F, 'unknown_remote', shopId)!;
    const { bindRepository } = await actions();
    expect(
      await bindRepository(
        { error: null },
        form('repository.bind', { pendingId: row.id, projectId: sandboxId, moveFrom: shopId }),
      ),
    ).toEqual({ error: null });
    expect(boundSlugs(F)).toEqual(['sandbox']);
    expect(repos.pendingRepositories.findById(row.id)).toBeUndefined();
  });

  it('discards a row out of the live list and restores it back', async () => {
    const row = sightUnbound(nextFingerprint());
    const live = () =>
      repos.pendingRepositories.adminListLive(new Date(0)).some((r) => r.id === row.id);
    const { discardPendingRepository, restorePendingRepository } = await actions();
    expect(
      await discardPendingRepository(
        { error: null },
        form('repository.discard', { pendingId: row.id }),
      ),
    ).toEqual({ error: null });
    expect(live()).toBe(false);
    expect(
      await restorePendingRepository(
        { error: null },
        form('repository.restore', { pendingId: row.id }),
      ),
    ).toEqual({ error: null });
    expect(live()).toBe(true);
  });
});

describe('creating a project with repositories', () => {
  it('binds the chosen pending row and the pasted fingerprint after creating it', async () => {
    const pendingF = nextFingerprint();
    const typedF = nextFingerprint();
    const row = sightUnbound(pendingF, ['github.com/acme/new']);
    const slug = `created-${sequence}`;
    const { createProject } = await actions();
    const target = await redirectTarget(() =>
      createProject(
        { error: null },
        form('project.create', { slug, pendingId: [row.id], fingerprint: typedF }),
      ),
    );
    expect(target).toContain(`/dashboard/projects?created=${slug}`);
    expect(target).not.toContain('error=');
    expect(boundSlugs(pendingF)).toEqual([slug]);
    expect(boundSlugs(typedF)).toEqual([slug]);
    expect(repos.pendingRepositories.findById(row.id)).toBeUndefined();
  });

  it('refuses a malformed fingerprint before creating the project', async () => {
    const slug = `refused-${sequence++}`;
    const { createProject } = await actions();
    const before = snapshot();
    const result = (await createProject(
      { error: null },
      form('project.create', { slug, fingerprint: 'abc123' }),
    )) as { error: string };
    expect(result.error).toContain('40 or 64 lowercase hexadecimal characters');
    expect(repos.projects.findBySlug(slug)).toBeUndefined();
    expect(snapshot()).toBe(before);
  });

  it('still creates a project without any repository field', async () => {
    const slug = `plain-${sequence++}`;
    const { createProject } = await actions();
    const target = await redirectTarget(() =>
      createProject({ error: null }, form('project.create', { slug, displayName: 'Plain' })),
    );
    expect(target).toContain(`created=${slug}`);
    expect(repos.projects.findBySlug(slug)?.displayName).toBe('Plain');
  });
});

describe('every repository action requires an admin session and its own CSRF token', () => {
  interface Case {
    name: string;
    formName: string;
    pick: (mod: Awaited<ReturnType<typeof actions>>) => Action;
    fields: () => Record<string, string>;
    mutated: (fields: Record<string, string>) => boolean;
  }

  const cases: Case[] = [
    {
      name: 'project.create',
      formName: 'project.create',
      pick: (mod) => mod.createProject,
      fields: () => ({ slug: `guarded-${++sequence}` }),
      mutated: (f) => repos.projects.findBySlug(f['slug']!) !== undefined,
    },
    {
      name: 'repository.bind',
      formName: 'repository.bind',
      pick: (mod) => mod.bindRepository,
      fields: () => ({ fingerprint: nextFingerprint(), projectId: shopId }),
      mutated: (f) => boundSlugs(f['fingerprint']!).length > 0,
    },
    {
      name: 'repository.remove',
      formName: 'repository.remove',
      pick: (mod) => mod.removeRepositoryBinding,
      fields: () => {
        const fingerprint = nextFingerprint();
        bindings.bind({ fingerprint, projectId: shopId, createdBy: 'dashboard:seed' });
        return { fingerprint, projectId: shopId };
      },
      mutated: (f) => boundSlugs(f['fingerprint']!).length === 0,
    },
    {
      name: 'repository.accept-remotes',
      formName: 'repository.accept-remotes',
      pick: (mod) => mod.acceptRepositoryRemotes,
      fields: () => {
        const fingerprint = nextFingerprint();
        bindings.bind({ fingerprint, projectId: shopId, createdBy: 'dashboard:seed' });
        repos.repositoryBindings.updateRemotes(fingerprint, shopId, ['github.com/acme/shop']);
        bindings.resolve(writerReach, { fingerprint, remotes: ['github.com/other/store'] });
        const row = repos.pendingRepositories.findByIdentity(
          fingerprint,
          'unknown_remote',
          shopId,
        )!;
        return { pendingId: row.id };
      },
      mutated: (f) => repos.pendingRepositories.findById(f['pendingId']!) === undefined,
    },
    {
      name: 'repository.discard',
      formName: 'repository.discard',
      pick: (mod) => mod.discardPendingRepository,
      fields: () => ({ pendingId: sightUnbound(nextFingerprint()).id }),
      mutated: (f) => repos.pendingRepositories.findById(f['pendingId']!)?.discardedAt !== null,
    },
    {
      name: 'repository.restore',
      formName: 'repository.restore',
      pick: (mod) => mod.restorePendingRepository,
      fields: () => {
        const row = sightUnbound(nextFingerprint());
        bindings.discard(row.id);
        return { pendingId: row.id };
      },
      mutated: (f) => repos.pendingRepositories.findById(f['pendingId']!)?.discardedAt === null,
    },
  ];

  function build(csrf: string | undefined, fields: Record<string, string>): FormData {
    const data = new FormData();
    if (csrf !== undefined) data.set('csrf', csrf);
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    return data;
  }

  it.each(cases)('$name succeeds for the admin (control)', async (c) => {
    const fields = c.fields();
    const run = c.pick(await actions());
    const csrf = sessions.csrfToken(admin.session, c.formName);
    try {
      await run({ error: null }, build(csrf, fields));
    } catch (error) {
      expect(String((error as { digest?: unknown }).digest)).toContain('/dashboard/projects');
    }
    expect(c.mutated(fields)).toBe(true);
  });

  it.each(cases)('$name refuses a non-admin session with a valid CSRF token', async (c) => {
    const fields = c.fields();
    requestCookies.current = cookieSource(limited.cookie);
    const run = c.pick(await actions());
    const csrf = sessions.csrfToken(limited.session, c.formName);
    const result = (await run({ error: null }, build(csrf, fields))) as { error: string };
    expect(result.error).toContain('admin token');
    expect(c.mutated(fields)).toBe(false);
  });

  it.each(cases)('$name refuses a missing, forged or cross-form CSRF token', async (c) => {
    const run = c.pick(await actions());
    for (const csrf of [undefined, 'forged', sessions.csrfToken(admin.session, 'project.rename')]) {
      const fields = c.fields();
      const result = (await run({ error: null }, build(csrf, fields))) as { error: string };
      expect(result.error).toContain('could not be verified');
      expect(c.mutated(fields)).toBe(false);
    }
  });

  it.each(cases)('$name redirects an anonymous request to the login page', async (c) => {
    const fields = c.fields();
    requestCookies.current = cookieSource(null);
    const run = c.pick(await actions());
    const target = await redirectTarget(() =>
      run({ error: null }, build(sessions.csrfToken(admin.session, c.formName), fields)),
    );
    expect(target).toContain('/dashboard/login');
    expect(c.mutated(fields)).toBe(false);
  });
});
