import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@/lib/actions/guard', async () => await import('../../lib/actions/guard'));
vi.mock('@/lib/services', async () => await import('../../lib/services'));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { deriveSessionKey, SessionsService, TokensService } from '@rembric/core';
import { createDb, createRepositories, type DbHandle } from '@rembric/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
