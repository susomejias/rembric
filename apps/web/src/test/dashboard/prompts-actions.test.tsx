import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The `@/` alias bridge for the prompts page module.
 *
 * The test project has no `@` alias (see `maintenance/data.ts`), so the page's
 * view-layer specifiers are stubbed here and the guard and the service graph are
 * proxied to the real modules — a Server Action reads them through the page
 * module, and the tested path is the production path. Nothing here renders the
 * page, so the render-time components are only stubbed to keep their transitive
 * imports out of the module graph.
 */
vi.mock('@/components/dashboard/action-form', () => ({}));
vi.mock('@/components/dashboard/confirm-submit', () => ({}));
vi.mock('@/components/dashboard/csrf-field', () => ({}));
vi.mock('@/components/dashboard/filters', () => ({}));
vi.mock('@/components/dashboard/support', () => ({}));
vi.mock('@/components/dashboard/ui', () => ({}));
vi.mock('@/components/ui/button', () => ({}));
vi.mock('@/lib/actions/guard', async () => await import('../../lib/actions/guard'));
vi.mock('@/lib/services', async () => await import('../../lib/services'));

import {
  deriveSessionKey,
  PromptsService,
  ProjectsService,
  SessionsService,
  TokensService,
} from '@rembric/core';
import { createDb, createRepositories, type DashboardSession, type DbHandle } from '@rembric/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionCookieSource } from '../../lib/session';

/**
 * The prompts Delete/Undelete actions, driven through the real guard against a
 * real migrated SQLite file — the same fixture shape `dashboard-mutations.test.ts`
 * uses, because the guard resolves the session through the app's own cached
 * `SessionsService` over `REMBRIC_DATA_DIR`.
 *
 * The only injected thing is the cookie store: a Server Action reads it from a
 * request context this process does not have.
 */
const requestCookies = vi.hoisted(() => ({ current: null as SessionCookieSource | null }));
vi.mock('next/headers', () => ({ cookies: () => requestCookies.current }));

const DELETE_FORM = 'prompt.delete';
const UNDELETE_FORM = 'prompt.undelete';
const ADMIN_TOKEN = 'web-prompts-actions-admin-token-enough-entropy';

interface Fixture {
  dataDir: string;
  handle: DbHandle;
  projects: ProjectsService;
  prompts: PromptsService;
  sessions: SessionsService;
  admin: { id: string; cookie: string; session: DashboardSession };
  limited: { cookie: string; session: DashboardSession };
  cleanup: () => void;
}

let fixture: Fixture;

function createFixture(): Fixture {
  const dataDir = mkdtempSync(join(tmpdir(), 'rembric-prompts-test-'));
  const handle = createDb({ dataDir, onMigrationProgress: () => {}, onStartupLog: () => {} });
  const repos = createRepositories(handle.db);
  const tokens = new TokensService(repos, handle.db);
  tokens.bootstrapAdmin(ADMIN_TOKEN);
  const adminRow = repos.tokens.findByName('admin');
  if (adminRow === undefined) throw new Error('fixture: admin token was not bootstrapped');

  const sessions = new SessionsService(
    { dashboardSessions: repos.dashboardSessions },
    deriveSessionKey(ADMIN_TOKEN),
  );
  const admin = sessions.create(adminRow.id);
  const limitedToken = tokens.create({ name: 'limited', scope: 'read:*', expiresAt: null });
  const limited = sessions.create(limitedToken.token.id);

  return {
    dataDir,
    handle,
    projects: new ProjectsService(repos),
    prompts: new PromptsService(repos, handle.db),
    sessions,
    admin: { id: adminRow.id, cookie: admin.cookie, session: admin.session },
    limited: { cookie: limited.cookie, session: limited.session },
    cleanup: () => {
      try {
        handle.close();
      } catch {
        // ignore double-close
      }
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function cookieSource(cookie: string | null): SessionCookieSource {
  return {
    get: (name) =>
      cookie !== null && name === SessionsService.cookieName() ? { value: cookie } : undefined,
  };
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

let adminCookie: SessionCookieSource;

function csrfFor(formName: string, session = fixture.admin.session): string {
  return fixture.sessions.csrfToken(session, formName);
}

/** A submission shaped exactly like the rendered form: the id field plus its CSRF token. */
function submission(formName: string, id: string): FormData {
  return form({ id, csrf: csrfFor(formName) });
}

/** The state a Server Action's `useActionState` signature receives. */
const EMPTY_STATE = { error: null };

/** The path `redirect()` threw toward; a redirect is the action's success signal. */
async function redirectTarget(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    const digest = (err as { digest?: unknown }).digest;
    if (typeof digest === 'string') return digest;
    throw err;
  }
  throw new Error('expected redirect() to throw');
}

type ActionFn = (
  state: typeof EMPTY_STATE,
  formData: FormData,
) => Promise<{ error: string | null }>;

/**
 * The page module's two mutation exports. Absent until the page declares them,
 * so a missing export is a test failure here rather than a link error.
 */
async function actions(): Promise<{ deletePrompt: ActionFn; undeletePrompt: ActionFn }> {
  const mod = (await import('../../app/dashboard/prompts/page')) as {
    deletePrompt?: ActionFn;
    undeletePrompt?: ActionFn;
  };
  if (mod.deletePrompt === undefined || mod.undeletePrompt === undefined) {
    throw new Error('prompts page does not export the delete/undelete actions');
  }
  return { deletePrompt: mod.deletePrompt, undeletePrompt: mod.undeletePrompt };
}

function deletedAt(id: string): Date | null {
  return fixture.prompts.findById(id)?.deletedAt ?? null;
}

beforeAll(() => {
  fixture = createFixture();
  process.env['REMBRIC_DATA_DIR'] = fixture.dataDir;
  process.env['REMBRIC_ADMIN_TOKEN'] = ADMIN_TOKEN;
  delete process.env['REMBRIC_SESSION_SECRET'];
  adminCookie = cookieSource(fixture.admin.cookie);
});

afterAll(() => {
  fixture.cleanup();
  delete process.env['REMBRIC_DATA_DIR'];
  delete process.env['REMBRIC_ADMIN_TOKEN'];
});

beforeEach(() => {
  requestCookies.current = adminCookie;
});

/** A freshly saved prompt, exactly as an agent would have written one; returns its generated id. */
function savePrompt(label: string): string {
  const row = fixture.prompts.save({
    content: `${label} content`,
    title: `${label} title`,
  });
  return row.id;
}

describe('prompt.delete authorization', () => {
  it('refuses an anonymous submission and leaves the row live', async () => {
    const id = savePrompt('P-anon');
    requestCookies.current = cookieSource(null);
    const { deletePrompt } = await actions();

    const digest = await redirectTarget(() =>
      deletePrompt(EMPTY_STATE, submission(DELETE_FORM, id)),
    );

    expect(digest).toContain('/dashboard/login');
    expect(deletedAt(id)).toBeNull();
  });

  it('refuses a submission carrying no CSRF token, before the service call', async () => {
    const id = savePrompt('P-nocsrf');
    const { deletePrompt } = await actions();

    const result = await deletePrompt(EMPTY_STATE, form({ id }));

    expect(result.error).toContain('could not be verified');
    expect(deletedAt(id)).toBeNull();
  });

  it('refuses a CSRF token minted for the undelete form, proving the form-name binding', async () => {
    const id = savePrompt('P-crossform');
    const { deletePrompt } = await actions();

    const result = await deletePrompt(EMPTY_STATE, form({ id, csrf: csrfFor(UNDELETE_FORM) }));

    expect(result.error).toContain('could not be verified');
    expect(deletedAt(id)).toBeNull();
  });

  it('refuses a session minted from a non-admin token, even with a valid CSRF token', async () => {
    const id = savePrompt('P-limited');
    requestCookies.current = cookieSource(fixture.limited.cookie);
    const { deletePrompt } = await actions();

    const result = await deletePrompt(
      EMPTY_STATE,
      form({ id, csrf: csrfFor(DELETE_FORM, fixture.limited.session) }),
    );

    expect(result.error).toContain('admin token');
    expect(deletedAt(id)).toBeNull();
  });
});

describe('prompt.delete and prompt.undelete state transitions', () => {
  it('soft-deletes a live row and restores it, each landing on its own flash query', async () => {
    const id = savePrompt('P-round');
    const { deletePrompt, undeletePrompt } = await actions();

    const removed = await redirectTarget(() =>
      deletePrompt(EMPTY_STATE, submission(DELETE_FORM, id)),
    );
    expect(removed).toContain(`/dashboard/prompts?deleted=${id}`);
    expect(deletedAt(id)).not.toBeNull();

    const restored = await redirectTarget(() =>
      undeletePrompt(EMPTY_STATE, submission(UNDELETE_FORM, id)),
    );
    expect(restored).toContain(`/dashboard/prompts?undeleted=${id}`);
    expect(deletedAt(id)).toBeNull();
  });

  it('is idempotent: a second delete keeps the stored timestamp and still redirects', async () => {
    const id = savePrompt('P-idem');
    const { deletePrompt } = await actions();

    await redirectTarget(() => deletePrompt(EMPTY_STATE, submission(DELETE_FORM, id)));
    // The first call reached the service — the control for the unchanged-value
    // assertion below.
    expect(deletedAt(id)).not.toBeNull();

    // Backdated so "unchanged" cannot be an artifact of two calls landing in the
    // same millisecond: a second delete that re-set the column would overwrite it.
    const backdated = 1;
    fixture.handle.raw.prepare('UPDATE prompts SET deleted_at = ? WHERE id = ?').run(backdated, id);

    const second = await redirectTarget(() =>
      deletePrompt(EMPTY_STATE, submission(DELETE_FORM, id)),
    );

    expect(second).toContain(`/dashboard/prompts?deleted=${id}`);
    expect(deletedAt(id)?.getTime()).toBe(backdated);
  });

  it('is idempotent: undeleting a live row is a no-op that still redirects', async () => {
    const id = savePrompt('P-live-undelete');
    const { undeletePrompt } = await actions();

    const digest = await redirectTarget(() =>
      undeletePrompt(EMPTY_STATE, submission(UNDELETE_FORM, id)),
    );

    expect(digest).toContain(`/dashboard/prompts?undeleted=${id}`);
    expect(deletedAt(id)).toBeNull();
  });

  it('surfaces an unknown id as the form error instead of redirecting', async () => {
    const { deletePrompt, undeletePrompt } = await actions();

    const del = await deletePrompt(EMPTY_STATE, submission(DELETE_FORM, 'P-missing'));
    expect(del.error).toContain('P-missing');

    const undel = await undeletePrompt(EMPTY_STATE, submission(UNDELETE_FORM, 'P-missing'));
    expect(undel.error).toContain('P-missing');
  });
});
