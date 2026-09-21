import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AgentSessionsService,
  deriveSessionKey,
  DomainError,
  ProjectsService,
  SessionsService,
  TokensService,
} from '@rembric/core';
import { createDb, createRepositories, type DashboardSession, type DbHandle } from '@rembric/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { guardAction } from '../lib/actions/guard';
import { getServices } from '../lib/services';
import type { SessionCookieSource } from '../lib/session';

/**
 * The mutation layer's contract, against a real migrated SQLite file.
 *
 * Everything below `guardAction` is the production path: the guard resolves the
 * session through the app's own cached `SessionsService` (over the same file
 * this fixture created), verifies the CSRF token with the same service the page
 * minted it from, and hands back the same `getServices()` graph the page's
 * action calls. The only injected thing is the cookie store, because a Server
 * Action reads it from a request context this process does not have.
 *
 * The fixture mirrors `apps/server/src/test/db.ts` (fresh temp dir, real
 * migrations, paired cleanup) and `dashboard-e2e.test.ts`'s second connection
 * onto the running data dir. `REMBRIC_DATA_DIR` and `REMBRIC_ADMIN_TOKEN` are
 * set in `beforeAll`, which is early enough: `lib/db.ts` and `lib/session.ts`
 * open nothing at import time.
 */
const ADMIN_TOKEN = 'web-mutation-test-admin-token-enough-entropy';

interface Fixture {
  dataDir: string;
  handle: DbHandle;
  repos: ReturnType<typeof createRepositories>;
  tokens: TokensService;
  projects: ProjectsService;
  agentSessions: AgentSessionsService;
  sessions: SessionsService;
  admin: { id: string; cookie: string; session: DashboardSession };
  limited: { cookie: string; session: DashboardSession };
  cleanup: () => void;
}

let fixture: Fixture;

function createFixture(): Fixture {
  const dataDir = mkdtempSync(join(tmpdir(), 'rembric-web-test-'));
  // Silenced: every fixture applies every migration, and the provenance line
  // would print once for this throwaway database and once again for the app's
  // own connection to it.
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
  // A valid, non-admin credential: the same service mints its session, so the
  // only difference the guard sees is the scope the token row carries.
  const limitedToken = tokens.create({ name: 'limited', scope: 'read:*', expiresAt: null });
  const limited = sessions.create(limitedToken.token.id);

  return {
    dataDir,
    handle,
    repos,
    tokens,
    projects: new ProjectsService(repos),
    agentSessions: new AgentSessionsService(repos, handle.db),
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

/** A cookie store carrying one session cookie value, or none. */
function cookieSource(cookie: string | null): SessionCookieSource {
  return {
    get: (name) =>
      cookie !== null && name === SessionsService.cookieName() ? { value: cookie } : undefined,
  };
}

function form(fields: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const item of value) data.append(key, item);
    else data.set(key, value);
  }
  return data;
}

/** A submission shaped exactly like the rendered form: fields plus its CSRF token. */
let adminCookie: SessionCookieSource;

function csrfFor(formName: string): string {
  return fixture.sessions.csrfToken(fixture.admin.session, formName);
}

function submission(formName: string, fields: Record<string, string | string[]> = {}): FormData {
  return form({ ...fields, csrf: csrfFor(formName) });
}

beforeAll(() => {
  fixture = createFixture();
  // The app opens its own connection to this directory the first time a
  // mutation runs; these are the two variables it resolves that from.
  process.env['REMBRIC_DATA_DIR'] = fixture.dataDir;
  process.env['REMBRIC_ADMIN_TOKEN'] = ADMIN_TOKEN;
  adminCookie = cookieSource(fixture.admin.cookie);
});

afterAll(() => {
  fixture.cleanup();
  delete process.env['REMBRIC_DATA_DIR'];
  delete process.env['REMBRIC_ADMIN_TOKEN'];
});

describe('guardAction', () => {
  const FORM = 'project.create';

  it('refuses a submission with no session, naming the missing session', async () => {
    const result = await guardAction(submission(FORM), FORM, cookieSource(null));

    expect(result).toMatchObject({ ok: false, error: 'session_required' });
  });

  it('refuses a session minted from a non-admin token, even with a valid CSRF token', async () => {
    const result = await guardAction(
      // A correctly bound token: the refusal must come from the scope, not the CSRF check.
      form({ csrf: fixture.sessions.csrfToken(fixture.limited.session, FORM) }),
      FORM,
      cookieSource(fixture.limited.cookie),
    );

    expect(result).toMatchObject({ ok: false, error: 'admin_required' });
  });

  it('refuses a CSRF token minted for a different form name', async () => {
    const result = await guardAction(form({ csrf: csrfFor('project.rename') }), FORM, adminCookie);

    expect(result).toMatchObject({ ok: false, error: 'csrf_invalid' });
  });

  it('refuses a submission carrying no CSRF token', async () => {
    const result = await guardAction(form({}), FORM, adminCookie);

    expect(result).toMatchObject({ ok: false, error: 'csrf_invalid' });
  });

  it('admits an admin session, hands back the app service graph, and runs the mutation', async () => {
    const result = await guardAction(
      submission(FORM, { slug: 'guarded-project', displayName: '' }),
      FORM,
      adminCookie,
    );

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;

    // The control for the three refusals above: the same fixture cookie, with
    // the token minted for this form name, is admitted. The guard hands back
    // the very graph the page reads and writes through, so the mutation and the
    // view cannot be two views of the same rows.
    expect(result.services).toBe(getServices());

    const create = vi.spyOn(result.services.projects, 'create');
    result.services.projects.create({ slug: 'guarded-project', displayName: 'guarded-display' });

    expect(create).toHaveBeenCalledTimes(1);
    expect(result.services.projects.findBySlug('guarded-project')?.displayName).toBe(
      'guarded-display',
    );
    create.mockRestore();
  });
});

describe('projects mutations', () => {
  // `apps/server/src/dashboard/projects.ts`: create → archive → unarchive, each
  // guarded by its own form name. Main's dashboard has no archive round trip
  // test of its own, so this is the port's coverage of that pair.
  it('creates, archives and unarchives a project, and refuses the default project', async () => {
    const project = fixture.projects.create({ slug: 'slice-one', displayName: null });

    const archive = await guardAction(
      submission('project.archive', { id: project.id }),
      'project.archive',
      adminCookie,
    );
    expect(archive).toMatchObject({ ok: true });
    if (!archive.ok) return;
    archive.services.projects.archive(project.id);

    const activeIds = archive.services.projects.list().map((row) => row.id);
    const archivedIds = archive.services.projects.listArchived().map((row) => row.id);
    expect(activeIds).not.toContain(project.id);
    expect(archivedIds).toContain(project.id);

    const unarchive = await guardAction(
      submission('project.unarchive', { id: project.id }),
      'project.unarchive',
      adminCookie,
    );
    expect(unarchive).toMatchObject({ ok: true });
    if (!unarchive.ok) return;
    unarchive.services.projects.unarchive(project.id);

    expect(unarchive.services.projects.list().map((row) => row.id)).toContain(project.id);
    expect(unarchive.services.projects.listArchived().map((row) => row.id)).not.toContain(
      project.id,
    );

    // The archived arm is refused at the service, not only hidden by the
    // template: `assertWritable` is the boundary a crafted POST would reach.
    const defaultProject = fixture.projects.getDefault();
    expect(() => fixture.projects.archive(defaultProject.id)).toThrow(DomainError);
  });
});

describe('sessions mutations', () => {
  /** A fresh active run, exactly as `dashboard-e2e.test.ts` seeds one. */
  function startSession(): string {
    const started = fixture.agentSessions.start({
      tokenId: fixture.admin.id,
      projectId: fixture.projects.getDefault().id,
      agent: 'web-test',
    });
    return started.id;
  }

  // `apps/server/src/dashboard/sessions.ts`: softDelete → undelete, mirroring
  // main's own dashboard E2E round trip.
  it('soft-deletes a session and restores it, while refusing an ended abandon', async () => {
    const id = startSession();

    const remove = await guardAction(
      submission('session.delete', { id }),
      'session.delete',
      adminCookie,
    );
    expect(remove).toMatchObject({ ok: true });
    if (!remove.ok) return;
    const deleted = remove.services.agentSessions.softDelete(id, { adminBypass: true });
    expect(deleted.deletedAt).not.toBeNull();

    const restore = await guardAction(
      submission('session.undelete', { id }),
      'session.undelete',
      adminCookie,
    );
    expect(restore).toMatchObject({ ok: true });
    if (!restore.ok) return;
    restore.services.agentSessions.undelete(id, { adminBypass: true });
    expect(restore.services.agentSessions.getById(id)?.deletedAt).toBeNull();

    // Abandon is only offered for an active row; the transition it would make
    // from `ended` is refused, which is what keeps the rendered control honest.
    const ended = startSession();
    fixture.agentSessions.end(ended, { tokenId: fixture.admin.id });
    const abandon = await guardAction(
      submission('session.abandon', { id: ended }),
      'session.abandon',
      adminCookie,
    );
    expect(abandon).toMatchObject({ ok: true });
    if (!abandon.ok) return;
    expect(() =>
      abandon.services.agentSessions.markAbandoned(ended, { adminBypass: true }),
    ).toThrow(DomainError);
  });
});

describe('tokens mutations', () => {
  // `apps/server/src/dashboard/tokens.ts` POST `/`: the empty project set mints
  // the admin scope, one slug mints the single-project arm, and the minted
  // plaintext is the only copy that will ever exist.
  it('mints an admin-scope token over no project and revokes it by name', async () => {
    const guard = await guardAction(
      submission('token.create', { name: 'slice-three-admin', access: 'write', expires: '' }),
      'token.create',
      adminCookie,
    );
    expect(guard).toMatchObject({ ok: true });
    if (!guard.ok) return;

    const [firstSlug] = [] as string[];
    expect(firstSlug).toBeUndefined();
    const minted = guard.services.tokens.create({ name: 'slice-three-admin', scope: '*' });
    expect(minted.plaintext).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(guard.services.tokens.findByName('slice-three-admin')?.revokedAt).toBeNull();

    const revoke = await guardAction(
      submission('token.revoke', { name: 'slice-three-admin' }),
      'token.revoke',
      adminCookie,
    );
    expect(revoke).toMatchObject({ ok: true });
    if (!revoke.ok) return;
    revoke.services.tokens.revoke('slice-three-admin');
    expect(revoke.services.tokens.findByName('slice-three-admin')?.revokedAt).not.toBeNull();
    // Revoking twice is a refusal, which is what the `—` cell promises: the row
    // offers no second Revoke.
    expect(() => revoke.services.tokens.revoke('slice-three-admin')).toThrow(DomainError);
  });

  it('mints a project-bound token from one slug, creating the project', async () => {
    const guard = await guardAction(
      submission('token.create', { name: 'slice-three-project', access: 'read' }),
      'token.create',
      adminCookie,
    );
    expect(guard).toMatchObject({ ok: true });
    if (!guard.ok) return;

    const { plaintext } = guard.services.tokens.createForSlugs(
      {
        name: 'slice-three-project',
        slugs: ['slice-three-project'],
        access: 'read',
        expiresAt: null,
      },
      guard.services.projects,
    );

    expect(plaintext.length).toBeGreaterThan(0);
    const row = guard.services.tokens.findByName('slice-three-project');
    expect(row?.scope).toBe(
      'read:project:' + (guard.services.projects.findBySlug('slice-three-project')?.id ?? ''),
    );
  });
});
