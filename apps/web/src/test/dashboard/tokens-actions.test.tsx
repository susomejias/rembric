import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@/lib/actions/guard', async () => await import('../../lib/actions/guard'));
vi.mock('@/lib/services', async () => await import('../../lib/services'));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { deriveSessionKey, isAuthorized, SessionsService, TokensService } from '@rembric/core';
import { createDb, createRepositories, type DbHandle } from '@rembric/db';
import { Children, isValidElement, type ComponentProps, type ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { TokensTable } from '../../components/dashboard/tokens-table';
import type { SessionCookieSource } from '../../lib/session';

const requestCookies = vi.hoisted(() => ({ current: null as SessionCookieSource | null }));
vi.mock('next/headers', () => ({ cookies: () => requestCookies.current }));

const ADMIN_TOKEN = 'tokens-action-test-admin-not-a-real-secret';
let handle: DbHandle;
let dataDir: string;
let tokens: TokensService;
let sessions: SessionsService;
let admin: ReturnType<SessionsService['create']>;
let limited: ReturnType<SessionsService['create']>;
let sequence = 0;
const previousDataDir = process.env['REMBRIC_DATA_DIR'];
const previousAdminToken = process.env['REMBRIC_ADMIN_TOKEN'];

function cookieSource(cookie: string | null): SessionCookieSource {
  return {
    get: (name) =>
      cookie !== null && name === SessionsService.cookieName() ? { value: cookie } : undefined,
  };
}

function form(id: string, csrf?: string): FormData {
  const data = new FormData();
  data.set('id', id);
  if (csrf !== undefined) data.set('csrf', csrf);
  return data;
}

function target(): string {
  const name = `target-${sequence++}`;
  const result = tokens.create({ name, scope: '*' });
  tokens.revoke(name);
  return result.token.id;
}

async function action() {
  const mod = await import('../../app/dashboard/tokens/page');
  if (!('deleteToken' in mod) || typeof mod.deleteToken !== 'function') {
    throw new Error('tokens page must export deleteToken');
  }
  return mod.deleteToken;
}

async function redirectTarget(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const digest = (error as { digest?: unknown }).digest;
    if (typeof digest === 'string') return digest;
    throw error;
  }
  throw new Error('expected redirect');
}

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'rembric-token-actions-'));
  handle = createDb({ dataDir, onMigrationProgress: () => {}, onStartupLog: () => {} });
  const repos = createRepositories(handle.db);
  tokens = new TokensService(repos, handle.db);
  const adminToken = tokens.create({ name: 'admin', scope: '*' });
  const limitedToken = tokens.create({ name: 'limited', scope: 'read:*' });
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

function createForm(): FormData {
  const data = new FormData();
  data.set('name', `created-${sequence++}`);
  data.set('tokenType', 'projects');
  data.set('access', 'write');
  data.set('project', 'alpha');
  data.set('csrf', sessions.csrfToken(admin.session, 'token.create'));
  return data;
}

async function createAction() {
  const mod = await import('../../app/dashboard/tokens/page');
  if (!('createToken' in mod) || typeof mod.createToken !== 'function') {
    throw new Error('tokens page must export createToken');
  }
  return mod.createToken;
}

describe('token.create action', () => {
  it.each([
    ['admin', 'write', [], '*'],
    ['projects', 'read', [], 'read:*'],
    ['projects', 'write', ['alpha'], 'project:'],
    ['projects', 'read', ['alpha'], 'read:project:'],
    ['projects', 'write', ['alpha', 'gamma'], 'projects'],
    ['projects', 'read', ['alpha', 'gamma'], 'read:projects'],
  ] as const)(
    'mints %s / %s / %j with the exact persisted grant',
    async (type, access, slugs, scope) => {
      const data = createForm();
      data.set('tokenType', type);
      data.set('access', access);
      data.delete('project');
      for (const slug of slugs) data.append('project', slug);
      data.set('expires', '2099-01-01T00:00:00Z');
      const run = await createAction();
      const digest = await redirectTarget(() => run({ error: null }, data));
      expect(digest).toContain('/dashboard/tokens?');
      const plaintext = digest.match(/created=([^&;]+)/)?.[1];
      expect(plaintext).toBeTruthy();
      const reach = await tokens.authenticate(decodeURIComponent(plaintext ?? ''));
      const repos = createRepositories(handle.db);
      const ids = slugs.map((slug) => repos.projects.findBySlug(slug)?.id);
      expect(ids).not.toContain(undefined);
      expect(reach.token.name).toBe(data.get('name'));
      expect(reach.scope).toBe(slugs.length === 1 ? `${scope}${ids[0]}` : scope);
      expect(reach.token.projectId).toBe(slugs.length === 1 ? ids[0] : null);
      expect([...reach.memberProjectIds].sort()).toEqual(slugs.length > 1 ? ids.sort() : []);
      expect(reach.token.expiresAt).toEqual(new Date('2099-01-01T00:00:00Z'));
      expect(isAuthorized(reach, 'read', { scope: 'project', projectId: ids[0] ?? 'other' })).toBe(
        true,
      );
      expect(isAuthorized(reach, 'write', { scope: 'project', projectId: ids[0] ?? 'other' })).toBe(
        access === 'write',
      );
      expect(isAuthorized(reach, 'read', { scope: 'project', projectId: 'never-selected' })).toBe(
        slugs.length === 0,
      );
      expect(reach.scope === '*').toBe(type === 'admin');
    },
  );

  it.each([undefined, '', 'administrator'])(
    'refuses missing or invalid tokenType %s without minting',
    async (type) => {
      const data = createForm();
      if (type === undefined) data.delete('tokenType');
      else data.set('tokenType', type);
      const run = await createAction();
      const before = tokens.count();
      expect((await run({ error: null }, data)).error).toContain('Token type');
      expect(tokens.count()).toBe(before);
    },
  );

  it.each(['projects', 'admin'])('refuses invalid access for %s', async (type) => {
    const run = await createAction();
    for (const access of [undefined, '', 'owner']) {
      const data = createForm();
      data.set('tokenType', type);
      data.delete('project');
      if (access === undefined) data.delete('access');
      else data.set('access', access);
      const before = tokens.count();
      expect((await run({ error: null }, data)).error).toContain('Access');
      expect(tokens.count()).toBe(before);
    }
  });

  it('refuses project-write without projects instead of granting admin', async () => {
    const data = createForm();
    data.delete('project');
    const run = await createAction();
    const before = tokens.count();
    expect((await run({ error: null }, data)).error).toContain('at least one project');
    expect(tokens.count()).toBe(before);
  });

  it('refuses admin read without projects', async () => {
    const data = createForm();
    data.set('tokenType', 'admin');
    data.set('access', 'read');
    data.delete('project');
    const run = await createAction();
    const before = tokens.count();
    expect((await run({ error: null }, data)).error).toContain('Administrator');
    expect(tokens.count()).toBe(before);
  });

  it.each(['new-admin-project', '', 'BAD SLUG'])(
    'refuses admin with submitted project %j before project creation',
    async (slug) => {
      const data = createForm();
      data.set('tokenType', 'admin');
      data.set('project', slug);
      const run = await createAction();
      const before = tokens.count();
      const repos = createRepositories(handle.db);
      const projectsBefore = repos.projects.listOrdered(true);
      expect((await run({ error: null }, data)).error).toContain('Administrator');
      expect(tokens.count()).toBe(before);
      expect(repos.projects.listOrdered(true)).toEqual(projectsBefore);
    },
  );

  it.each([
    ['scope', '*', 'access'],
    ['name', '', 'Name'],
    ['expires', 'not-a-date', 'expires'],
    ['project', 'BAD SLUG', 'slug'],
  ])('preserves %s validation', async (field, value, message) => {
    const data = createForm();
    data.set(field, value);
    if (field === 'project') data.append('project', 'valid-before-invalid');
    const run = await createAction();
    const before = tokens.count();
    const repos = createRepositories(handle.db);
    const projectsBefore = repos.projects.listOrdered(true);
    expect((await run({ error: null }, data)).error).toContain(message);
    expect(tokens.count()).toBe(before);
    expect(repos.projects.listOrdered(true)).toEqual(projectsBefore);
  });

  it('refuses duplicate names without mutation', async () => {
    const data = createForm();
    data.set('name', 'admin');
    const run = await createAction();
    const before = tokens.list();
    expect((await run({ error: null }, data)).error).toContain('already exists');
    expect(tokens.list()).toEqual(before);
  });

  it.each([undefined, 'token.delete'])(
    'refuses missing or cross-form create CSRF %s',
    async (formName) => {
      const data = createForm();
      data.delete('csrf');
      if (formName !== undefined) data.set('csrf', sessions.csrfToken(admin.session, formName));
      const run = await createAction();
      const before = tokens.count();
      expect((await run({ error: null }, data)).error).toContain('could not be verified');
      expect(tokens.count()).toBe(before);
    },
  );

  it('refuses non-admin creation even with valid CSRF', async () => {
    const data = createForm();
    requestCookies.current = cookieSource(limited.cookie);
    data.set('csrf', sessions.csrfToken(limited.session, 'token.create'));
    const run = await createAction();
    const before = tokens.count();
    expect((await run({ error: null }, data)).error).toContain('admin token');
    expect(tokens.count()).toBe(before);
  });

  it('redirects anonymous creation without mutation', async () => {
    const data = createForm();
    requestCookies.current = cookieSource(null);
    const run = await createAction();
    const before = tokens.count();
    expect(await redirectTarget(() => run({ error: null }, data))).toContain('/dashboard/login');
    expect(tokens.count()).toBe(before);
  });
});

describe('token.promote-admin action', () => {
  async function promotionAction() {
    const mod = await import('../../app/dashboard/tokens/page');
    if (!('promoteTokenToAdmin' in mod) || typeof mod.promoteTokenToAdmin !== 'function') {
      throw new Error('tokens page must export promoteTokenToAdmin');
    }
    return mod.promoteTokenToAdmin;
  }

  function promotionTarget() {
    return tokens.create({ name: `promote-${sequence++}`, scope: 'read:*' });
  }

  it('promotes only the immutable ID with admin CSRF, redirects without a secret and revalidates', async () => {
    const target = promotionTarget();
    const control = promotionTarget();
    const run = await promotionAction();
    const data = form(target.token.id, sessions.csrfToken(admin.session, 'token.promote-admin'));
    data.set('name', control.token.name);
    const digest = await redirectTarget(() => run({ error: null }, data));
    expect(digest).toContain('/dashboard/tokens;');
    expect(digest).not.toContain(target.plaintext);
    expect(digest).not.toContain('?');
    expect(tokens.findById(target.token.id)).toEqual({ ...target.token, scope: '*' });
    expect(tokens.findById(control.token.id)).toEqual(control.token);
    const { revalidatePath } = await import('next/cache');
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/tokens');
  });

  it.each([undefined, 'forged', 'token.create', 'token.revoke'])(
    'refuses invalid promotion CSRF %s',
    async (formName) => {
      const target = promotionTarget();
      const run = await promotionAction();
      const csrf =
        formName === undefined
          ? undefined
          : formName === 'forged'
            ? 'forged'
            : sessions.csrfToken(admin.session, formName);
      expect((await run({ error: null }, form(target.token.id, csrf))).error).toContain(
        'could not be verified',
      );
      expect(tokens.findById(target.token.id)).toEqual(target.token);
    },
  );

  it('refuses a nonadmin even with valid promotion CSRF', async () => {
    const target = promotionTarget();
    requestCookies.current = cookieSource(limited.cookie);
    const run = await promotionAction();
    expect(
      (
        await run(
          { error: null },
          form(target.token.id, sessions.csrfToken(limited.session, 'token.promote-admin')),
        )
      ).error,
    ).toContain('admin token');
    expect(tokens.findById(target.token.id)).toEqual(target.token);
  });

  it('redirects anonymous promotion without mutation', async () => {
    const target = promotionTarget();
    requestCookies.current = cookieSource(null);
    const run = await promotionAction();
    expect(await redirectTarget(() => run({ error: null }, form(target.token.id)))).toContain(
      '/dashboard/login',
    );
    expect(tokens.findById(target.token.id)).toEqual(target.token);
  });

  it.each(['deleted', 'revoked', 'expired', 'at-now'])(
    'refuses a stale eligibility read when the conditional UPDATE sees %s',
    async (kind) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const now = new Date();
      vi.setSystemTime(now);
      const target = promotionTarget();
      if (kind === 'deleted')
        handle.raw
          .prepare('UPDATE tokens SET deleted_at = ? WHERE id = ?')
          .run(now.getTime(), target.token.id);
      if (kind === 'revoked') tokens.revoke(target.token.name);
      if (kind === 'expired' || kind === 'at-now')
        handle.raw
          .prepare('UPDATE tokens SET expires_at = ? WHERE id = ?')
          .run(now.getTime() - (kind === 'expired' ? 1 : 0), target.token.id);
      const repo = createRepositories(handle.db).tokens;
      const before = repo.findById(target.token.id);
      const stale = vi.spyOn(TokensService.prototype, 'findById').mockReturnValue(target.token);
      try {
        const run = await promotionAction();
        expect(
          (
            await run(
              { error: null },
              form(target.token.id, sessions.csrfToken(admin.session, 'token.promote-admin')),
            )
          ).error,
        ).toContain('no longer active');
        expect(repo.findById(target.token.id)).toEqual(before);
      } finally {
        stale.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    'blank',
    'missing',
    'revoked',
    'deleted',
    'expired',
    'inert',
    'read-inert',
    'empty-set',
    'read-empty-set',
  ])('returns domain errors for forged or stale %s targets', async (kind) => {
    const target = tokens.create({
      name: `stale-${sequence++}`,
      scope: 'read:*',
      expiresAt: kind === 'expired' ? new Date(0) : null,
    });
    if (kind === 'revoked' || kind === 'deleted') tokens.revoke(target.token.name);
    if (kind === 'deleted') tokens.deleteRevoked(target.token.id);
    if (kind.includes('inert') || kind.includes('empty-set')) {
      const scope =
        kind === 'inert'
          ? 'project:missing'
          : kind === 'read-inert'
            ? 'read:project:missing'
            : kind === 'empty-set'
              ? 'projects'
              : 'read:projects';
      handle.raw.prepare('UPDATE tokens SET scope = ? WHERE id = ?').run(scope, target.token.id);
    }
    const before = tokens.findById(target.token.id);
    const run = await promotionAction();
    const id = kind === 'blank' ? '' : kind === 'missing' ? 'missing' : target.token.id;
    const message =
      kind === 'blank'
        ? 'id must be non-empty'
        : kind === 'missing' || kind === 'deleted'
          ? 'token not found or deleted'
          : kind.includes('inert')
            ? 'unresolved project binding'
            : kind.includes('empty-set')
              ? 'token has no projects'
              : 'token must be active';
    expect(
      (
        await run(
          { error: null },
          form(id, sessions.csrfToken(admin.session, 'token.promote-admin')),
        )
      ).error,
    ).toContain(message);
    expect(tokens.findById(target.token.id)).toEqual(before);
  });
});

describe('promotion page wiring', () => {
  function tableProps(node: ReactNode): ComponentProps<typeof TokensTable> | undefined {
    for (const child of Children.toArray(node)) {
      if (!isValidElement<{ children?: ReactNode }>(child)) continue;
      if (child.type === TokensTable && isValidElement<ComponentProps<typeof TokensTable>>(child))
        return child.props;
      const nested = tableProps(child.props.children);
      if (nested) return nested;
    }
    return undefined;
  }

  it('passes the real promotion action and dedicated CSRF, marks null-bound project tokens inert and omits deleted rows', async () => {
    const {
      default: page,
      promoteTokenToAdmin,
      rotateToken,
    } = await import('../../app/dashboard/tokens/page');
    const project = createRepositories(handle.db).projects.findBySlug('alpha');
    if (!project) throw new Error('fixture: missing alpha project');
    const inert = tokens.create({ name: `null-binding-${sequence++}`, scope: 'read:*' });
    handle.raw
      .prepare('UPDATE tokens SET scope = ? WHERE id = ?')
      .run(`project:${project.id}`, inert.token.id);
    const removedId = target();
    tokens.deleteRevoked(removedId);
    const props = tableProps(await page({ searchParams: Promise.resolve({}) }));
    expect(props).toBeDefined();
    expect(props?.actions.promote).toBe(promoteTokenToAdmin);
    expect(props?.actions.rotate).toBe(rotateToken);
    expect(props?.csrf.rotate).toBe(sessions.csrfToken(admin.session, 'token.rotate'));
    expect(props?.csrf.promote).toBe(sessions.csrfToken(admin.session, 'token.promote-admin'));
    expect(props?.rows.find((row) => row.id === inert.token.id)?.state).toBe('inert');
    expect(props?.rows.some((row) => row.id === removedId)).toBe(false);
  });
});

describe('token.rotate action', () => {
  async function rotationAction() {
    const mod = await import('../../app/dashboard/tokens/page');
    if (!('rotateToken' in mod) || typeof mod.rotateToken !== 'function')
      throw new Error('tokens page must export rotateToken');
    return mod.rotateToken;
  }

  it('returns only a fresh secret and self-session flag without redirecting or revalidating', async () => {
    const target = tokens.create({ name: `rotate-${sequence++}`, scope: '*' });
    const control = tokens.create({ name: `rotate-control-${sequence++}`, scope: 'read:*' });
    const { revalidatePath } = await import('next/cache');
    vi.mocked(revalidatePath).mockClear();
    const run = await rotationAction();
    const data = form(target.token.id, sessions.csrfToken(admin.session, 'token.rotate'));
    data.set('name', control.token.name);
    const result = await run({ error: null }, data);
    expect(Object.keys(result).sort()).toEqual(['error', 'plaintext', 'reauthenticate']);
    expect(result.error).toBeNull();
    expect(result.plaintext).not.toBe(target.plaintext);
    expect((await tokens.authenticate(result.plaintext ?? '')).token.id).toBe(target.token.id);
    await expect(tokens.authenticate(target.plaintext)).rejects.toThrow();
    expect(tokens.findById(control.token.id)).toEqual(control.token);
    expect(result.reauthenticate).toBe(false);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('delivers self-rotation success even though the initiating session is invalidated', async () => {
    const target = tokens.create({ name: `self-rotate-${sequence++}`, scope: '*' });
    const own = sessions.create(target.token.id);
    requestCookies.current = cookieSource(own.cookie);
    const run = await rotationAction();
    const result = await run(
      { error: null },
      form(target.token.id, sessions.csrfToken(own.session, 'token.rotate')),
    );
    expect(result.error).toBeNull();
    expect(result.plaintext).toBeTruthy();
    expect(result.reauthenticate).toBe(true);
    expect(sessions.resolve(own.cookie)).toBeNull();
  });

  it.each([undefined, 'forged', 'token.create', 'token.promote-admin'])(
    'refuses invalid rotation CSRF %s without mutation',
    async (formName) => {
      const target = tokens.create({ name: `rotate-csrf-${sequence++}`, scope: '*' });
      const run = await rotationAction();
      const csrf =
        formName === undefined
          ? undefined
          : formName === 'forged'
            ? 'forged'
            : sessions.csrfToken(admin.session, formName);
      const result = await run({ error: null }, form(target.token.id, csrf));
      expect(result.error).toContain('could not be verified');
      expect(result).not.toHaveProperty('plaintext');
      expect(tokens.findById(target.token.id)).toEqual(target.token);
    },
  );

  it('refuses nonadmins and anonymous callers', async () => {
    const id = target();
    const run = await rotationAction();
    requestCookies.current = cookieSource(limited.cookie);
    expect(
      (await run({ error: null }, form(id, sessions.csrfToken(limited.session, 'token.rotate'))))
        .error,
    ).toContain('admin token');
    requestCookies.current = cookieSource(null);
    expect(await redirectTarget(() => run({ error: null }, form(id)))).toContain(
      '/dashboard/login',
    );
  });

  it.each(['', 'missing', 'revoked', 'expired', 'deleted'])(
    'refuses %s targets without secret delivery',
    async (kind) => {
      const target = tokens.create({
        name: `rotate-stale-${sequence++}`,
        scope: '*',
        expiresAt: kind === 'expired' ? new Date(0) : null,
      });
      if (kind === 'revoked' || kind === 'deleted') tokens.revoke(target.token.name);
      if (kind === 'deleted') tokens.deleteRevoked(target.token.id);
      const before = tokens.findById(target.token.id);
      const run = await rotationAction();
      const id = kind === '' || kind === 'missing' ? kind : target.token.id;
      const result = await run(
        { error: null },
        form(id, sessions.csrfToken(admin.session, 'token.rotate')),
      );
      expect(result.error).toBeTruthy();
      expect(result).not.toHaveProperty('plaintext');
      expect(tokens.findById(target.token.id)).toEqual(before);
    },
  );
});

describe('token.delete action', () => {
  it('deletes the immutable ID with valid admin CSRF and redirects', async () => {
    const id = target();
    const run = await action();
    const data = form(id, sessions.csrfToken(admin.session, 'token.delete'));
    data.set('name', 'admin');
    expect(await redirectTarget(() => run({ error: null }, data))).toContain('/dashboard/tokens');
    expect(tokens.findById(id)?.deletedAt).toBeInstanceOf(Date);
    expect(tokens.findByName('admin')?.deletedAt).toBeNull();
  });

  it('refuses anonymous callers without mutation', async () => {
    const id = target();
    requestCookies.current = cookieSource(null);
    const run = await action();
    expect(await redirectTarget(() => run({ error: null }, form(id)))).toContain(
      '/dashboard/login',
    );
    expect(tokens.findById(id)?.deletedAt).toBeNull();
  });

  it.each([undefined, 'token.revoke'])(
    'refuses missing or cross-form CSRF %s',
    async (formName) => {
      const id = target();
      const run = await action();
      const csrf = formName === undefined ? undefined : sessions.csrfToken(admin.session, formName);
      expect((await run({ error: null }, form(id, csrf))).error).toContain('could not be verified');
      expect(tokens.findById(id)?.deletedAt).toBeNull();
    },
  );

  it('refuses non-admin callers even with valid CSRF', async () => {
    const id = target();
    requestCookies.current = cookieSource(limited.cookie);
    const run = await action();
    expect(
      (await run({ error: null }, form(id, sessions.csrfToken(limited.session, 'token.delete'))))
        .error,
    ).toContain('admin token');
    expect(tokens.findById(id)?.deletedAt).toBeNull();
  });

  it('returns domain errors for active, missing and repeated targets', async () => {
    const active = tokens.create({ name: `active-${sequence++}`, scope: '*' });
    const run = await action();
    const csrf = sessions.csrfToken(admin.session, 'token.delete');
    expect((await run({ error: null }, form(active.token.id, csrf))).error).toContain('revoke');
    expect(tokens.findById(active.token.id)?.deletedAt).toBeNull();
    expect((await run({ error: null }, form('missing', csrf))).error).toContain('not found');
    const id = target();
    tokens.deleteRevoked(id);
    expect((await run({ error: null }, form(id, csrf))).error).toContain('already deleted');
  });
});
