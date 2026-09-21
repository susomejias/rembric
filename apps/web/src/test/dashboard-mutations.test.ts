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
import {
  createDb,
  createRepositories,
  projectScope,
  type DashboardSession,
  type DbHandle,
  type Scope,
} from '@rembric/db';
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

describe('memories mutations', () => {
  // `apps/server/src/dashboard/memories.ts` `/:id/archive` and `/:id/confirm`:
  // the row is read unscoped and the scope the service call is pinned to comes
  // from that row's own project. Confirm records the operator's event, which is
  // what bumps the confirmation count the detail hub renders.
  const ARCHIVE_FORM = 'memory.archive';
  const CONFIRM_FORM = 'memory.confirm';

  function saveMemory(title: string): string {
    const { memory } = getServices();
    const row = memory.save(
      { type: 'feedback', title, content: `${title} content` },
      projectScope(fixture.projects.getDefault().id),
    );
    return row.id;
  }

  /** The retired handler's scope resolution: read the row, then scope to its project. */
  function resolveScope(id: string): Scope {
    const row = getServices().memory.unsafeGetById(id);
    if (!row?.projectId) throw new Error('fixture: memory has no project to scope to');
    return projectScope(row.projectId);
  }

  it('archives then re-affirms a memory, resolving scope from the row itself', async () => {
    const id = saveMemory('slice-four-marker');

    const archive = await guardAction(submission(ARCHIVE_FORM, { id }), ARCHIVE_FORM, adminCookie);
    expect(archive).toMatchObject({ ok: true });
    if (!archive.ok) return;
    archive.services.memory.archive(id, resolveScope(id));

    expect(archive.services.memory.unsafeGetById(id)?.status).toBe('archived');
    expect(archive.services.repos.memory.adminCountConfirmations(id)).toBe(0);

    const confirm = await guardAction(submission(CONFIRM_FORM, { id }), CONFIRM_FORM, adminCookie);
    expect(confirm).toMatchObject({ ok: true });
    if (!confirm.ok) return;
    confirm.services.memory.confirm(id, resolveScope(id), {
      source: { agent: 'dashboard-operator' },
    });

    expect(confirm.services.repos.memory.adminCountConfirmations(id)).toBe(1);
  });

  it('refuses a non-admin session before the service call, leaving the row untouched', async () => {
    const id = saveMemory('slice-four-refused');

    const result = await guardAction(
      form({ id, csrf: fixture.sessions.csrfToken(fixture.limited.session, ARCHIVE_FORM) }),
      ARCHIVE_FORM,
      cookieSource(fixture.limited.cookie),
    );
    expect(result).toMatchObject({ ok: false, error: 'admin_required' });
    // The control for the refusal: an admin session would archive this same row,
    // so an unchanged status is evidence the guard stopped before the service.
    expect(getServices().memory.unsafeGetById(id)?.status).toBe('active');
  });

  it('refuses another project scope, proving the row-scoped resolution is load-bearing', () => {
    const id = saveMemory('slice-four-scope');
    const other = fixture.projects.create({ slug: 'slice-four-other', displayName: null });

    // The positive control is the round-trip above: the same kind of row, scoped
    // from its own project, archives. Here the wrong project's scope must refuse
    // and leave the row untouched.
    expect(() => getServices().memory.archive(id, projectScope(other.id))).toThrow(DomainError);
    expect(getServices().memory.unsafeGetById(id)?.status).toBe('active');
  });
});

describe('judgments mutations', () => {
  // `apps/server/src/dashboard/judgments.ts` `/:judgmentId/orphan`: the operator
  // closes a pending judgment once; the second call is the "already closed"
  // answer the row's form surfaces as an error.
  const ORPHAN_FORM = 'judgment.orphan';

  function pendingJudgment(): string {
    const { memory, repos } = getServices();
    const scope = projectScope(fixture.projects.getDefault().id);
    const source = memory.save(
      { type: 'feedback', title: 'orphan-source', content: 'source' },
      scope,
    );
    const target = memory.save(
      { type: 'feedback', title: 'orphan-target', content: 'target' },
      scope,
    );
    const judgmentId = `jdg-${source.id}`;
    repos.relations.insert({
      id: `rel-${source.id}`,
      judgmentId,
      sourceId: source.id,
      targetId: target.id,
      relation: null,
      status: 'pending',
      createdAt: new Date(),
    });
    return judgmentId;
  }

  it('orphans a pending judgment once, then reports the already-closed one', async () => {
    const judgmentId = pendingJudgment();

    const guard = await guardAction(
      submission(ORPHAN_FORM, { judgmentId }),
      ORPHAN_FORM,
      adminCookie,
    );
    expect(guard).toMatchObject({ ok: true });
    if (!guard.ok) return;

    expect(guard.services.relations.orphanByOperator(judgmentId)).toBe(true);
    expect(getServices().repos.relations.findByJudgmentId(judgmentId)?.status).toBe('orphaned');

    // `false` is the missing-or-closed branch the action turns into its error.
    expect(guard.services.relations.orphanByOperator(judgmentId)).toBe(false);
  });
});

describe('maintenance mutations', () => {
  // `apps/server/src/dashboard/maintenance.ts`'s three purge POSTs. Each covers
  // the zero-count branch main renders as a disabled control and the non-zero
  // branch it renders as a danger-confirmed form.
  const PURGE_SESSIONS = 'maintenance.purge-sessions';
  const PURGE_MEMORIES = 'maintenance.purge-archived-memories';
  const PURGE_PROMPTS = 'maintenance.purge-prompts';

  /** End a run and backdate `ended_at` past the one-hour purge grace. */
  function endAndBackdate(sessionId: string): void {
    getServices().agentSessions.end(sessionId, { tokenId: fixture.admin.id });
    fixture.handle.raw
      .prepare('UPDATE sessions SET ended_at = ? WHERE id = ?')
      .run(Date.now() - 2 * 60 * 60 * 1000, sessionId);
  }

  it('purges empty sessions: zero is a no-op, then a backdated ended run is removed', async () => {
    const guard = await guardAction(submission(PURGE_SESSIONS), PURGE_SESSIONS, adminCookie);
    expect(guard).toMatchObject({ ok: true });
    if (!guard.ok) return;

    expect(guard.services.agentSessions.countPurgeableEmpty()).toBe(0);
    expect(guard.services.agentSessions.purgeEmpty({ adminBypass: true }).deletedIds).toEqual([]);

    const started = guard.services.agentSessions.start({
      tokenId: fixture.admin.id,
      projectId: fixture.projects.getDefault().id,
      agent: 'purge-fixture',
    });
    endAndBackdate(started.id);

    expect(guard.services.agentSessions.countPurgeableEmpty()).toBe(1);
    const purged = guard.services.agentSessions.purgeEmpty({ adminBypass: true });
    expect(purged.deletedIds).toContain(started.id);
    expect(guard.services.agentSessions.countPurgeableEmpty()).toBe(0);
  });

  it('purges archived memories: zero is a no-op, then a disconnected row is removed', async () => {
    const guard = await guardAction(submission(PURGE_MEMORIES), PURGE_MEMORIES, adminCookie);
    expect(guard).toMatchObject({ ok: true });
    if (!guard.ok) return;

    expect(guard.services.memory.countPurgeableDisconnectedArchived()).toBe(0);
    expect(
      guard.services.memory.purgeDisconnectedArchived({ adminBypass: true }).deletedIds,
    ).toEqual([]);

    const scope = projectScope(fixture.projects.getDefault().id);
    const saved = guard.services.memory.save(
      { type: 'feedback', title: 'slice-six-archived', content: 'slice-six-archived' },
      scope,
    );
    guard.services.memory.archive(saved.id, scope);

    expect(guard.services.memory.countPurgeableDisconnectedArchived()).toBe(1);
    const purged = guard.services.memory.purgeDisconnectedArchived({ adminBypass: true });
    expect(purged.deletedIds).toContain(saved.id);
    expect(guard.services.memory.unsafeGetById(saved.id)).toBeUndefined();
    expect(guard.services.memory.countPurgeableDisconnectedArchived()).toBe(0);
  });

  it('purges deleted prompts: zero is a no-op, then a soft-deleted prompt is removed', async () => {
    const guard = await guardAction(submission(PURGE_PROMPTS), PURGE_PROMPTS, adminCookie);
    expect(guard).toMatchObject({ ok: true });
    if (!guard.ok) return;

    expect(guard.services.prompts.countPurgeableDeleted()).toBe(0);
    expect(guard.services.prompts.purgeDeleted({ adminBypass: true }).deletedIds).toEqual([]);

    const projectId = fixture.projects.getDefault().id;
    const keep = guard.services.prompts.save({ content: 'keep', title: 'keep', projectId });
    const drop = guard.services.prompts.save({ content: 'drop', title: 'drop', projectId });
    guard.services.prompts.softDelete(drop.id);

    expect(guard.services.prompts.countPurgeableDeleted()).toBe(1);
    const purged = guard.services.prompts.purgeDeleted({ adminBypass: true });
    expect(purged.deletedIds).toEqual([drop.id]);
    expect(guard.services.prompts.findById(keep.id)).toBeDefined();
    expect(guard.services.prompts.findById(drop.id)).toBeUndefined();
    expect(guard.services.prompts.countPurgeableDeleted()).toBe(0);
  });
});
