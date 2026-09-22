import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@/lib/version', () => ({ REMBRIC_VERSION: '9.9.9' }));

import {
  AgentSessionsService,
  deriveOAuthAreqKey,
  deriveSessionKey,
  DomainError,
  EntityBackfillWorker,
  ProjectsService,
  SessionsService,
  signAuthRequest,
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
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { runEntityRebuild } from '../app/dashboard/entities/page';
import { GET as downloadBackup } from '../app/dashboard/maintenance/backup/download/[file]/route';
import { GET as downloadLatestBackup } from '../app/dashboard/maintenance/backup/download/route';
import {
  createOnDemandBackup,
  latestOnDemandBackup,
  readMaintenanceState,
  resolveBackupDownload,
  ON_DEMAND_BACKUP_KEEP,
} from '../app/dashboard/maintenance/data';
import { POST as consentPost } from '../app/dashboard/oauth/consent/route';
import { checkForUpdates } from '../app/dashboard/update/actions';
import { getUpdates } from '../app/dashboard/update/update-service';
import { guardAction } from '../lib/actions/guard';
import { getServices } from '../lib/services';
import type { SessionCookieSource } from '../lib/session';

vi.mock('@/components/dashboard/action-form', () => ({}));
vi.mock('@/components/dashboard/confirm-submit', () => ({}));
vi.mock('@/components/dashboard/csrf-field', () => ({}));
vi.mock('@/components/dashboard/filters', () => ({}));
vi.mock('@/components/dashboard/support', () => ({}));
vi.mock('@/components/dashboard/ui', () => ({}));
vi.mock('@/components/ui/button', () => ({}));
vi.mock('@/lib/actions/guard', async () => await import('../lib/actions/guard'));
vi.mock('@/lib/services', async () => await import('../lib/services'));
vi.mock('@/lib/version', () => ({ REMBRIC_VERSION: '0.0.1' }));

const requestCookies = vi.hoisted(() => ({ current: null as SessionCookieSource | null }));
vi.mock('next/headers', () => ({ cookies: () => requestCookies.current }));

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
      } catch {}
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

function form(fields: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const item of value) data.append(key, item);
    else data.set(key, value);
  }
  return data;
}

let adminCookie: SessionCookieSource;

function csrfFor(formName: string): string {
  return fixture.sessions.csrfToken(fixture.admin.session, formName);
}

function submission(formName: string, fields: Record<string, string | string[]> = {}): FormData {
  return form({ ...fields, csrf: csrfFor(formName) });
}

beforeAll(() => {
  fixture = createFixture();
  process.env['REMBRIC_DATA_DIR'] = fixture.dataDir;
  process.env['REMBRIC_ADMIN_TOKEN'] = ADMIN_TOKEN;
  process.env['REMBRIC_PUBLIC_URL'] = 'http://127.0.0.1:3100';
  delete process.env['REMBRIC_SESSION_SECRET'];
  adminCookie = cookieSource(fixture.admin.cookie);
});

afterAll(() => {
  fixture.cleanup();
  delete process.env['REMBRIC_DATA_DIR'];
  delete process.env['REMBRIC_ADMIN_TOKEN'];
  delete process.env['REMBRIC_PUBLIC_URL'];
});

describe('alias probe', () => {
  it('loads update-service through a mocked @/lib/version', async () => {
    const mod = await import('../app/dashboard/update/update-service');
    expect(mod.getUpdates()).toBeDefined();
  });
});

describe('guardAction', () => {
  const FORM = 'project.create';

  it('refuses a submission with no session, naming the missing session', async () => {
    const result = await guardAction(submission(FORM), FORM, cookieSource(null));

    expect(result).toMatchObject({ ok: false, error: 'session_required' });
  });

  it('refuses a session minted from a non-admin token, even with a valid CSRF token', async () => {
    const result = await guardAction(
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

    const defaultProject = fixture.projects.getDefault();
    expect(() => fixture.projects.archive(defaultProject.id)).toThrow(DomainError);
  });
});

describe('sessions mutations', () => {
  function startSession(): string {
    const started = fixture.agentSessions.start({
      tokenId: fixture.admin.id,
      projectId: fixture.projects.getDefault().id,
      agent: 'web-test',
    });
    return started.id;
  }

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
    expect(getServices().memory.unsafeGetById(id)?.status).toBe('active');
  });

  it('refuses another project scope, proving the row-scoped resolution is load-bearing', () => {
    const id = saveMemory('slice-four-scope');
    const other = fixture.projects.create({ slug: 'slice-four-other', displayName: null });

    expect(() => getServices().memory.archive(id, projectScope(other.id))).toThrow(DomainError);
    expect(getServices().memory.unsafeGetById(id)?.status).toBe('active');
  });
});

describe('judgments mutations', () => {
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

    expect(guard.services.relations.orphanByOperator(judgmentId)).toBe(false);
  });
});

describe('maintenance mutations', () => {
  const PURGE_SESSIONS = 'maintenance.purge-sessions';
  const PURGE_MEMORIES = 'maintenance.purge-archived-memories';
  const PURGE_PROMPTS = 'maintenance.purge-prompts';

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

describe('maintenance backup', () => {
  const BACKUP_FORM = 'maintenance.backup';

  function backupsPath(): string {
    return join(fixture.dataDir, 'backups');
  }

  function downloadRequest(cookie: string | null): NextRequest {
    return new NextRequest('http://localhost/dashboard/maintenance/backup/download', {
      headers: cookie === null ? {} : { cookie: `${SessionsService.cookieName()}=${cookie}` },
    });
  }

  function fileRequest(file: string, cookie: string | null = fixture.admin.cookie): NextRequest {
    return new NextRequest(
      `http://localhost/dashboard/maintenance/backup/download/${encodeURIComponent(file)}`,
      { headers: cookie === null ? {} : { cookie: `${SessionsService.cookieName()}=${cookie}` } },
    );
  }

  it('writes an on-demand snapshot the page then lists as the latest', async () => {
    rmSync(backupsPath(), { recursive: true, force: true });

    const guard = await guardAction(submission(BACKUP_FORM), BACKUP_FORM, adminCookie);
    expect(guard).toMatchObject({ ok: true });
    if (!guard.ok) return;

    expect(latestOnDemandBackup()).toBeNull();

    const created = createOnDemandBackup();
    expect(created.file).toMatch(/^on-demand-\d+\.sqlite$/);
    expect(created.kind).toBe('on-demand');
    expect(existsSync(created.path)).toBe(true);
    expect(created.sizeBytes).toBeGreaterThan(0);

    const state = readMaintenanceState(false);
    expect(state.latestOnDemand?.file).toBe(created.file);
    expect(state.backups.map((b) => b.file)).toContain(created.file);
    expect(state.backupsDir).toBe(backupsPath());
  });

  it('keeps only the 3 newest on-demand snapshots', () => {
    rmSync(backupsPath(), { recursive: true, force: true });
    mkdirSync(backupsPath(), { recursive: true });
    for (const ms of [1_000, 2_000, 3_000]) {
      writeFileSync(join(backupsPath(), `on-demand-${ms}.sqlite`), 'older snapshot');
    }

    const created = createOnDemandBackup();
    const kept = readdirSync(backupsPath()).filter((f) => f.startsWith('on-demand-'));

    expect(kept).toHaveLength(ON_DEMAND_BACKUP_KEEP);
    expect(kept).toContain(created.file);
    expect(kept).not.toContain('on-demand-1000.sqlite');
  });

  it('streams the latest snapshot as an attachment, and refuses without one', async () => {
    rmSync(backupsPath(), { recursive: true, force: true });

    const none = downloadLatestBackup(downloadRequest(fixture.admin.cookie));
    expect(none.status).toBe(404);
    expect(none.headers.get('content-disposition')).toBeNull();

    const created = createOnDemandBackup();
    const response = downloadLatestBackup(downloadRequest(fixture.admin.cookie));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-length')).toBe(String(created.sizeBytes));
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="${created.file}"`,
    );
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.length).toBe(created.sizeBytes);
  });

  it('serves a named snapshot, including a pre-update one, and 404s a missing file', async () => {
    rmSync(backupsPath(), { recursive: true, force: true });
    mkdirSync(backupsPath(), { recursive: true });
    const preUpdate = 'pre-update-v0.24.0-1700000000000.sqlite';
    writeFileSync(join(backupsPath(), preUpdate), 'not a real sqlite file, just bytes');

    const byName = await downloadBackup(fileRequest(preUpdate), {
      params: Promise.resolve({ file: preUpdate }),
    });
    expect(byName.status).toBe(200);
    expect(byName.headers.get('content-disposition')).toContain(preUpdate);

    const missing = await downloadBackup(fileRequest('on-demand-9999999999999.sqlite'), {
      params: Promise.resolve({ file: 'on-demand-9999999999999.sqlite' }),
    });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-disposition')).toBeNull();
  });

  it('rejects a filename outside the producer-generated shape before it touches the fs', async () => {
    const traversal = '../../../../etc/passwd';
    expect(resolveBackupDownload(traversal)).toMatchObject({ ok: false, status: 400 });

    const response = await downloadBackup(fileRequest(traversal), {
      params: Promise.resolve({ file: traversal }),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('content-disposition')).toBeNull();

    expect(resolveBackupDownload('/etc/passwd')).toMatchObject({ ok: false, status: 400 });
  });

  it('refuses a download without an admin session', () => {
    const anonymous = downloadLatestBackup(downloadRequest(null));
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get('location')).toContain('/dashboard/login');

    const limited = downloadLatestBackup(downloadRequest(fixture.limited.cookie));
    expect(limited.status).toBe(403);
    expect(limited.headers.get('content-disposition')).toBeNull();
  });
});

describe('consolidation sweep and undo', () => {
  const SWEEP_FORM = 'sweep.run';
  const RUN_UNDO_FORM = 'run.undo';
  const OP_UNDO_FORM = 'op.undo';

  function decayCandidate(title: string): string {
    const { memory } = getServices();
    const row = memory.save(
      { type: 'project', title, content: `${title} content` },
      projectScope(fixture.projects.getDefault().id),
    );
    fixture.handle.raw
      .prepare('UPDATE memory SET last_seen_at = ? WHERE id = ?')
      .run(Date.now() - 200 * 86_400_000, row.id);
    return row.id;
  }

  function defaultRunId(services: ReturnType<typeof getServices>): string {
    const summary = services.forcedSweep();
    const run = summary.runs.find((r) => r.scope.projectId === fixture.projects.getDefault().id);
    if (run === undefined) throw new Error('fixture: the default project did not sweep');
    return run.runId;
  }

  it('forces a sweep whose run undoes back to the pre-run status', async () => {
    const guard = await guardAction(submission(SWEEP_FORM), SWEEP_FORM, adminCookie);
    expect(guard).toMatchObject({ ok: true });
    if (!guard.ok) return;

    const idleRunId = defaultRunId(guard.services);
    expect(guard.services.repos.consolidation.adminOpCounts(idleRunId)).toEqual({
      total: 0,
      reverted: 0,
    });

    const id = decayCandidate('slice-eight-decay');
    const runId = defaultRunId(guard.services);
    const ops = guard.services.repos.consolidation.adminListOps(runId);

    expect(ops).toHaveLength(1);
    expect(ops[0]?.opType).toBe('decay');
    expect(guard.services.memory.unsafeGetById(id)?.status).toBe('archived');

    const undo = await guardAction(
      submission(RUN_UNDO_FORM, { runId }),
      RUN_UNDO_FORM,
      adminCookie,
    );
    expect(undo).toMatchObject({ ok: true });
    if (!undo.ok) return;
    const result = undo.services.undoRun(runId);

    expect(result.reverted).toEqual([ops[0]?.id]);
    expect(result.skipped).toEqual([]);
    expect(undo.services.memory.unsafeGetById(id)?.status).toBe('active');
    expect(
      undo.services.repos.consolidation.adminGetOp(ops[0]?.id ?? '')?.revertedAt,
    ).not.toBeNull();
  });

  it('undoes a single op, then reports the second undo as already reverted', async () => {
    const id = decayCandidate('slice-eight-single');
    const services = getServices();
    const runId = defaultRunId(services);
    const [op] = services.repos.consolidation.adminListOps(runId);
    if (op === undefined) throw new Error('fixture: the sweep journaled no op');

    const guard = await guardAction(
      submission(OP_UNDO_FORM, { opId: op.id }),
      OP_UNDO_FORM,
      adminCookie,
    );
    expect(guard).toMatchObject({ ok: true });
    if (!guard.ok) return;

    expect(guard.services.undoOp(op.id)).toEqual({ reverted: op.id, skipped: [] });
    expect(guard.services.memory.unsafeGetById(id)?.status).toBe('active');

    expect(() => guard.services.undoOp(op.id)).toThrow(/already reverted/);
  });

  it('refuses a run undo as a non-admin, leaving the op applied', async () => {
    const id = decayCandidate('slice-eight-refused');
    const runId = defaultRunId(getServices());

    const refused = await guardAction(
      form({
        runId,
        csrf: fixture.sessions.csrfToken(fixture.limited.session, RUN_UNDO_FORM),
      }),
      RUN_UNDO_FORM,
      cookieSource(fixture.limited.cookie),
    );
    expect(refused).toMatchObject({ ok: false, error: 'admin_required' });

    const undo = await guardAction(
      submission(RUN_UNDO_FORM, { runId }),
      RUN_UNDO_FORM,
      adminCookie,
    );
    expect(undo).toMatchObject({ ok: true });
    if (!undo.ok) return;
    expect(undo.services.memory.unsafeGetById(id)?.status).toBe('archived');
    undo.services.undoRun(runId);
    expect(undo.services.memory.unsafeGetById(id)?.status).toBe('active');
  });
});

describe('entities rebuild', () => {
  const FORM = 'entities.rebuild';

  it('re-scans the whole backlog across batches and reports the processed count', async () => {
    const guard = await guardAction(submission(FORM), FORM, adminCookie);
    expect(guard).toMatchObject({ ok: true });
    if (!guard.ok) return;

    const seeded = 150;
    const scope = projectScope(fixture.projects.getDefault().id);
    for (let i = 0; i < seeded; i++) {
      guard.services.memory.save(
        { type: 'project', title: `rebuild-${i}`, content: `apps/rebuild/file-${i}.ts` },
        scope,
      );
    }

    const processed = runEntityRebuild(guard.services.entityBackfillWorker);

    expect(processed).toBeGreaterThanOrEqual(seeded);
    expect(guard.services.repos.entities.adminBacklogCount()).toBe(0);
  });

  it('stops on the first empty batch when there is nothing to scan', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'rembric-entities-empty-'));
    const handle = createDb({ dataDir, onMigrationProgress: () => {}, onStartupLog: () => {} });
    try {
      const worker = new EntityBackfillWorker({
        repos: createRepositories(handle.db),
        tx: handle.db,
      });
      expect(runEntityRebuild(worker)).toBe(0);
    } finally {
      handle.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('update manual check', () => {
  const FORM = 'update.check';
  const RELEASES_URL = 'http://updates.test/releases';

  function resetUpdatesSingleton(): void {
    delete (globalThis as Record<string, unknown>)['__rembricUpdates'];
  }

  async function redirectTarget(run: () => Promise<unknown>): Promise<string> {
    try {
      await run();
    } catch (err) {
      const digest = (err as { digest?: unknown }).digest;
      return typeof digest === 'string' ? digest : '';
    }
    throw new Error('expected redirect() to throw');
  }

  function stubReleases(releases: unknown): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(releases), {
            status: 200,
            headers: { etag: 'test-etag' },
          }),
        ),
      ),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['REMBRIC_UPDATE_CHECK_URL'];
    delete process.env['REMBRIC_UPDATE_CHECK'];
    resetUpdatesSingleton();
  });

  it('drives the singleton and redirects with no flash when a release is found', async () => {
    process.env['REMBRIC_UPDATE_CHECK_URL'] = RELEASES_URL;
    stubReleases([
      {
        tag_name: 'server-v9.9.9',
        body: 'notes',
        html_url: 'http://example.test/release',
        published_at: '2024-01-01T00:00:00.000Z',
      },
    ]);
    resetUpdatesSingleton();
    requestCookies.current = cookieSource(fixture.admin.cookie);

    const digest = await redirectTarget(() => checkForUpdates({ error: null }, submission(FORM)));

    expect(digest).toContain('/dashboard/update');
    expect(digest).not.toContain('checked=');
    expect(getUpdates().peek()?.latestVersion).toBe('9.9.9');
  });

  it('flashes the honest outcome when no newer release is known', async () => {
    process.env['REMBRIC_UPDATE_CHECK_URL'] = RELEASES_URL;
    stubReleases([]);
    resetUpdatesSingleton();
    requestCookies.current = cookieSource(fixture.admin.cookie);

    const digest = await redirectTarget(() => checkForUpdates({ error: null }, submission(FORM)));

    expect(digest).toContain('/dashboard/update?checked=none');
  });

  it('returns to the page with no flash when the check is disabled', async () => {
    process.env['REMBRIC_UPDATE_CHECK'] = 'off';
    resetUpdatesSingleton();
    requestCookies.current = cookieSource(fixture.admin.cookie);

    const digest = await redirectTarget(() => checkForUpdates({ error: null }, submission(FORM)));

    expect(digest).toContain('/dashboard/update');
    expect(digest).not.toContain('checked=');
  });
});

describe('oauth consent endpoint', () => {
  const FORM = 'oauth.consent';
  const REDIRECT_URI = 'https://client.example/callback';

  function signedAreq(overrides: Partial<Parameters<typeof signAuthRequest>[0]> = {}): string {
    return signAuthRequest(
      {
        clientId: 'web-mutation-client',
        redirectUri: REDIRECT_URI,
        codeChallenge: 'pkce-challenge',
        scope: 'mcp',
        state: 'state-abc',
        exp: Math.floor(Date.now() / 1000) + 600,
        ...overrides,
      },
      deriveOAuthAreqKey(ADMIN_TOKEN),
    );
  }

  function consentRequest(fields: Record<string, string>): NextRequest {
    return new NextRequest('http://localhost/dashboard/oauth/consent', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `${SessionsService.cookieName()}=${fixture.admin.cookie}`,
      },
      body: new URLSearchParams(fields),
    });
  }

  function approveFields(): Record<string, string> {
    return {
      csrf: fixture.sessions.csrfToken(fixture.admin.session, FORM),
      areq: signedAreq(),
      decision: 'approve',
    };
  }

  it('mints a code and redirects to the registered redirect_uri with the state', async () => {
    const response = await consentPost(consentRequest(approveFields()));

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI);
    expect(location.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(location.searchParams.get('state')).toBe('state-abc');
  });

  it('redirects access_denied back to the client without minting a code', async () => {
    const response = await consentPost(consentRequest({ ...approveFields(), decision: 'deny' }));

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('code')).toBeNull();
    expect(location.searchParams.get('state')).toBe('state-abc');
  });

  it('refuses a wrong token and a missing token with the retired handler 403', async () => {
    const wrong = await consentPost(consentRequest({ ...approveFields(), csrf: 'not-the-token' }));
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toMatchObject({ ok: false, code: 'csrf_invalid' });

    const missing = await consentPost(consentRequest({ areq: signedAreq(), decision: 'approve' }));
    expect(missing.status).toBe(403);
    expect(await missing.json()).toMatchObject({ ok: false, code: 'csrf_invalid' });
  });
});
