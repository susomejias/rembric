import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { tokens as tokensSchema } from '../db/schema/tokens.js';
import { buildSessionHandlers } from '../mcp/session-tools.js';
import { AgentSessionsService, SUMMARY_MAX_CHARS } from '../services/agent-sessions.js';
import { MemoryService } from '../services/memory.js';
import { ProjectsService } from '../services/projects.js';
import { projectScope } from '../services/scope.js';
import { TokensService } from '../services/tokens.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { createApiRouter } from './api-router.js';
import { runWithContext, type RequestContext } from './request-context.js';
import { SessionRouter } from './session-router.js';

let db: TestDb;
let agentSessions: AgentSessionsService;
let memory: MemoryService;
let projects: ProjectsService;
let tokens: TokensService;
let adminToken: { id: string; plaintext: string };
let projectScopedToken: { id: string; plaintext: string };
let projectSlug: string;
let projectId: string;

const ADMIN_BOOTSTRAP = 'test-admin-token-with-enough-entropy';

function makeApp() {
  return createApiRouter({ agentSessions, memory, tokens, projects });
}

async function call(
  app: ReturnType<typeof makeApp>,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await app.request(path, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.status, body };
}

beforeEach(() => {
  db = createTestDb();
  agentSessions = new AgentSessionsService(createRepositories(db.handle.db), db.handle.db);
  memory = new MemoryService(createRepositories(db.handle.db), db.handle.db);
  projects = new ProjectsService(createRepositories(db.handle.db));
  tokens = new TokensService(createRepositories(db.handle.db), db.handle.db);

  tokens.bootstrapAdmin(ADMIN_BOOTSTRAP);
  const admin = db.handle.db
    .select()
    .from(tokensSchema)
    .where(eq(tokensSchema.name, 'admin'))
    .get();
  adminToken = { id: admin!.id, plaintext: ADMIN_BOOTSTRAP };

  const proj = projects.create({ slug: 'api-test-proj' });
  projectSlug = proj.slug;
  projectId = proj.id;

  const created = tokens.create({ name: 'proj-scoped', project: proj, access: 'write' });
  projectScopedToken = { id: created.token.id, plaintext: created.plaintext };
});

afterEach(() => db.cleanup());

describe('createApiRouter', () => {
  describe('auth', () => {
    it('401 when no Authorization header', async () => {
      const app = makeApp();
      const r = await call(app, 'POST', `/${projectSlug}/sessions`, {
        body: { id: 'sess-abc12345' },
      });
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('missing_token');
    });

    it('401 on unknown bearer token', async () => {
      const app = makeApp();
      const r = await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: 'not-a-real-token',
        body: { id: 'sess-abc12345' },
      });
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('token_invalid');
    });

    it('404 when slug does not resolve', async () => {
      const app = makeApp();
      const r = await call(app, 'POST', `/no-such-slug/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-abc12345' },
      });
      expect(r.status).toBe(404);
      expect(r.body.code).toBe('project_not_found');
    });

    it('403 when token scope does not cover the slug', async () => {
      const other = projects.create({ slug: 'other-proj' });
      const app = makeApp();
      const r = await call(app, 'POST', `/${other.slug}/sessions`, {
        token: projectScopedToken.plaintext,
        body: { id: 'sess-abc12345' },
      });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('forbidden');
    });
  });

  describe('POST /:slug/sessions', () => {
    it('creates a new session row and returns created: true', async () => {
      const app = makeApp();
      const r = await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-fresh-1', cwd: '/tmp/foo' },
      });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.sessionId).toBe('sess-fresh-1');
      expect(r.body.scope).toBe('project');
      expect(r.body.created).toBe(true);
      expect(typeof r.body.startedAt).toBe('string');
    });

    it('is idempotent: second POST returns created: false', async () => {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-idempo-1' },
      });
      const r = await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-idempo-1' },
      });
      expect(r.status).toBe(200);
      expect(r.body.created).toBe(false);
    });

    it('409 id_collision when another token already owns the id', async () => {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-collide-1' },
      });
      const r = await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: projectScopedToken.plaintext,
        body: { id: 'sess-collide-1' },
      });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('id_collision');
    });

    it('400 on missing id', async () => {
      const app = makeApp();
      const r = await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: {},
      });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('invalid_input');
    });

    it('400 on malformed id', async () => {
      const app = makeApp();
      for (const id of ['x', 'has spaces', 'A'.repeat(129)]) {
        const r = await call(app, 'POST', `/${projectSlug}/sessions`, {
          token: adminToken.plaintext,
          body: { id },
        });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('invalid_input');
      }
    });

    it('404 on path-less /sessions without slug', async () => {
      const app = makeApp();
      const r = await call(app, 'POST', `/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-abc12345' },
      });
      expect(r.status).toBe(404);
    });
  });

  describe('POST /:slug/sessions/:id/summary', () => {
    it('persists summary without transitioning status', async () => {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-sum-1' },
      });
      const r = await call(app, 'POST', `/${projectSlug}/sessions/sess-sum-1/summary`, {
        token: adminToken.plaintext,
        body: { summary: 'Goal: x\nDone: y' },
      });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      const row = agentSessions.getById('sess-sum-1');
      // /summary writes summary but does NOT transition — use /end for that.
      expect(row?.status).toBe('active');
      expect(row?.summary).toContain('Goal: x');
      expect(row?.summaryFinal).toBe(false);
    });

    it('persists title alongside summary with final:true precedence', async () => {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-sum-title' },
      });
      const r = await call(app, 'POST', `/${projectSlug}/sessions/sess-sum-title/summary`, {
        token: adminToken.plaintext,
        body: { summary: 'Goal', title: 'Fix bug', final: true },
      });
      expect(r.status).toBe(200);
      const row = agentSessions.getById('sess-sum-title');
      expect(row?.title).toBe('Fix bug');
      expect(row?.summaryFinal).toBe(true);
      expect(row?.titleFinal).toBe(true);
    });

    it('400 on empty summary', async () => {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-sum-2' },
      });
      const r = await call(app, 'POST', `/${projectSlug}/sessions/sess-sum-2/summary`, {
        token: adminToken.plaintext,
        body: { summary: '' },
      });
      expect(r.status).toBe(400);
    });

    it('404 when session does not exist', async () => {
      const app = makeApp();
      const r = await call(app, 'POST', `/${projectSlug}/sessions/never-existed/summary`, {
        token: adminToken.plaintext,
        body: { summary: 'x' },
      });
      expect(r.status).toBe(404);
      expect(r.body.code).toBe('session_not_found');
    });

    it('404 when session belongs to a different token', async () => {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-owned-by-admin' },
      });
      const r = await call(app, 'POST', `/${projectSlug}/sessions/sess-owned-by-admin/summary`, {
        token: projectScopedToken.plaintext,
        body: { summary: 'x' },
      });
      expect(r.status).toBe(404);
      expect(r.body.code).toBe('session_not_found');
    });

    // #256 — a session created under an archived project must not be
    // writable by connecting through an unrelated, non-archived slug: the
    // handler must check the SESSION's own projectId, not only ownership.
    it('404 when the session belongs to a different project than the URL slug (archived-project bypass)', async () => {
      const app = makeApp();
      const archivedProj = projects.create({ slug: 'archived-proj' });
      await call(app, 'POST', `/${archivedProj.slug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-in-archived-proj' },
      });
      projects.archive(archivedProj.id);

      // Same (admin) token, but connecting via a DIFFERENT, non-archived slug.
      const r = await call(app, 'POST', `/${projectSlug}/sessions/sess-in-archived-proj/summary`, {
        token: adminToken.plaintext,
        body: { summary: 'bypass attempt' },
      });
      expect(r.status).toBe(404);
      expect(r.body.code).toBe('session_not_found');
      // The write never landed.
      const row = agentSessions.getById('sess-in-archived-proj');
      expect(row?.summary).toBeNull();
    });

    it('403 when a project-scoped token lacks write authorization for the URL slug', async () => {
      const app = makeApp();
      const other = projects.create({ slug: 'other-write-proj' });
      const r = await call(app, 'POST', `/${other.slug}/sessions/whatever-id/summary`, {
        token: projectScopedToken.plaintext,
        body: { summary: 'x' },
      });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('forbidden');
    });

    it('non-final write is silently blocked when summary_final is true', async () => {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-twice' },
      });
      await call(app, 'POST', `/${projectSlug}/sessions/sess-twice/summary`, {
        token: adminToken.plaintext,
        body: { summary: 'final-first', final: true },
      });
      const r = await call(app, 'POST', `/${projectSlug}/sessions/sess-twice/summary`, {
        token: adminToken.plaintext,
        body: { summary: 'non-final-second', final: false },
      });
      expect(r.status).toBe(200);
      const row = agentSessions.getById('sess-twice');
      // First (final:true) write wins; non-final overwrite is ignored.
      expect(row?.summary).toBe('final-first');
      expect(row?.summaryFinal).toBe(true);
    });

    it('200 on summary write to an ended session, with status and ended_at unchanged', async () => {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-already-ended' },
      });
      await call(app, 'POST', `/${projectSlug}/sessions/sess-already-ended/end`, {
        token: adminToken.plaintext,
      });
      const before = agentSessions.getById('sess-already-ended');
      const r = await call(app, 'POST', `/${projectSlug}/sessions/sess-already-ended/summary`, {
        token: adminToken.plaintext,
        body: { summary: 'after-end' },
      });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.summary).toBe('after-end');
      const row = agentSessions.getById('sess-already-ended');
      expect(row?.summary).toBe('after-end');
      expect(row?.status).toBe('ended');
      expect(row?.status).toBe(before?.status);
      expect(row?.endedAt?.getTime()).toBe(before?.endedAt?.getTime());
      expect(row?.lastActivityAt?.getTime()).toBe(before?.lastActivityAt?.getTime());
    });

    it('200 on summary write to an abandoned session, with lifecycle columns unchanged', async () => {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-swept-abandoned' },
      });
      agentSessions.markAbandoned('sess-swept-abandoned', { adminBypass: true });
      const before = agentSessions.getById('sess-swept-abandoned');
      const r = await call(app, 'POST', `/${projectSlug}/sessions/sess-swept-abandoned/summary`, {
        token: adminToken.plaintext,
        body: { summary: 'curated handoff', title: 'Fix the reaper', final: true },
      });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.summary).toBe('curated handoff');
      expect(r.body.summaryFinal).toBe(true);
      const row = agentSessions.getById('sess-swept-abandoned');
      expect(row?.summary).toBe('curated handoff');
      expect(row?.title).toBe('Fix the reaper');
      expect(row?.status).toBe('abandoned');
      expect(row?.endedAt?.getTime()).toBe(before?.endedAt?.getTime());
      expect(row?.lastActivityAt?.getTime()).toBe(before?.lastActivityAt?.getTime());
    });

    it('a repeated non-final transcript sync on an abandoned session never clobbers the curated summary', async () => {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-abandoned-sync' },
      });
      await call(app, 'POST', `/${projectSlug}/sessions/sess-abandoned-sync/summary`, {
        token: adminToken.plaintext,
        body: { summary: 'curated handoff', final: true },
      });
      agentSessions.markAbandoned('sess-abandoned-sync', { adminBypass: true });
      for (const _turn of [1, 2]) {
        const r = await call(app, 'POST', `/${projectSlug}/sessions/sess-abandoned-sync/summary`, {
          token: adminToken.plaintext,
          body: { summary: 'raw transcript dump', final: false },
        });
        expect(r.status).toBe(200);
        expect(r.body.summary).toBe('curated handoff');
      }
      const row = agentSessions.getById('sess-abandoned-sync');
      expect(row?.summary).toBe('curated handoff');
      expect(row?.summaryFinal).toBe(true);
      expect(row?.status).toBe('abandoned');
    });

    it('409 session_deleted on a soft-deleted abandoned session', async () => {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-abandoned-deleted' },
      });
      agentSessions.markAbandoned('sess-abandoned-deleted', { adminBypass: true });
      agentSessions.softDelete('sess-abandoned-deleted', { adminBypass: true });
      const r = await call(app, 'POST', `/${projectSlug}/sessions/sess-abandoned-deleted/summary`, {
        token: adminToken.plaintext,
        body: { summary: 'late write on a purged-intent row' },
      });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('session_deleted');
      expect(agentSessions.getById('sess-abandoned-deleted')?.summary).toBeNull();
    });

    it('409 session_deleted when soft-deleted', async () => {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-deleted' },
      });
      agentSessions.softDelete('sess-deleted', { adminBypass: true });
      const r = await call(app, 'POST', `/${projectSlug}/sessions/sess-deleted/summary`, {
        token: adminToken.plaintext,
        body: { summary: 'x' },
      });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('session_deleted');
    });

    it('truncates summary > SUMMARY_MAX_CHARS server-side, marking the front', async () => {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-trunc-summary' },
      });
      const r = await call(app, 'POST', `/${projectSlug}/sessions/sess-trunc-summary/summary`, {
        token: adminToken.plaintext,
        body: { summary: 'A'.repeat(SUMMARY_MAX_CHARS + 2000) },
      });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      const row = agentSessions.getById('sess-trunc-summary');
      expect(row?.summary?.length).toBe(SUMMARY_MAX_CHARS);
      expect(row?.summary?.startsWith('…[truncated]')).toBe(true);
      // Response body echoes the truncated value.
      expect((r.body.summary as string).length).toBe(SUMMARY_MAX_CHARS);
    });

    it('summary just over the old 20_000 wire boundary now truncates instead of rejecting', async () => {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-old-boundary' },
      });
      const r = await call(app, 'POST', `/${projectSlug}/sessions/sess-old-boundary/summary`, {
        token: adminToken.plaintext,
        body: { summary: 'A'.repeat(20_001) },
      });
      expect(r.status).toBe(200);
      const row = agentSessions.getById('sess-old-boundary');
      expect(row?.summary?.length).toBe(SUMMARY_MAX_CHARS);
      expect(row?.summary?.startsWith('…[truncated]')).toBe(true);
    });

    it('a summary at the plugin code-point cap containing emoji truncates instead of rejecting', async () => {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-emoji-summary' },
      });
      const emojiSummary = 'a'.repeat(19_999) + '😀';
      expect(emojiSummary.length).toBe(20_001);
      const r = await call(app, 'POST', `/${projectSlug}/sessions/sess-emoji-summary/summary`, {
        token: adminToken.plaintext,
        body: { summary: emojiSummary },
      });
      expect(r.status).toBe(200);
      expect(r.body.code).not.toBe('invalid_input');
      const row = agentSessions.getById('sess-emoji-summary');
      expect(row?.summary?.length).toBe(SUMMARY_MAX_CHARS);
    });

    it('400 invalid_input on summary > 40_000 (raised wire DoS guard still fires)', async () => {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-dos-summary' },
      });
      const r = await call(app, 'POST', `/${projectSlug}/sessions/sess-dos-summary/summary`, {
        token: adminToken.plaintext,
        body: { summary: 'A'.repeat(40_001) },
      });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('invalid_input');
    });

    it('title over TITLE_MAX_LENGTH truncates instead of rejecting', async () => {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-long-title' },
      });
      const r = await call(app, 'POST', `/${projectSlug}/sessions/sess-long-title/summary`, {
        token: adminToken.plaintext,
        body: { summary: 'x', title: 'T'.repeat(150) },
      });
      expect(r.status).toBe(200);
      const row = agentSessions.getById('sess-long-title');
      expect(row?.title?.length).toBe(100);
    });

    it('a title at the plugin code-point cap containing emoji truncates instead of rejecting', async () => {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-emoji-title' },
      });
      const emojiTitle = 't'.repeat(99) + '😀';
      expect(emojiTitle.length).toBe(101);
      const r = await call(app, 'POST', `/${projectSlug}/sessions/sess-emoji-title/summary`, {
        token: adminToken.plaintext,
        body: { summary: 'x', title: emojiTitle },
      });
      expect(r.status).toBe(200);
      expect(r.body.code).not.toBe('invalid_input');
      const row = agentSessions.getById('sess-emoji-title');
      expect(row?.title?.length).toBeLessThanOrEqual(100);
      expect(row?.title).toBe('t'.repeat(99));
    });

    it('400 invalid_input on title > 200 (raised wire DoS guard still fires)', async () => {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-dos-title' },
      });
      const r = await call(app, 'POST', `/${projectSlug}/sessions/sess-dos-title/summary`, {
        token: adminToken.plaintext,
        body: { summary: 'x', title: 'T'.repeat(201) },
      });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('invalid_input');
    });
  });

  describe('POST /:slug/sessions/:id/end', () => {
    it('closes an active session without summary', async () => {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-end-1' },
      });
      const r = await call(app, 'POST', `/${projectSlug}/sessions/sess-end-1/end`, {
        token: adminToken.plaintext,
      });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      const row = agentSessions.getById('sess-end-1');
      expect(row?.status).toBe('ended');
      expect(row?.summary).toBeNull();
    });

    it('double-end is idempotent (no error, returns the already-ended row)', async () => {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-end-2' },
      });
      const first = await call(app, 'POST', `/${projectSlug}/sessions/sess-end-2/end`, {
        token: adminToken.plaintext,
      });
      const firstEnd = first.body.endedAt;
      const r = await call(app, 'POST', `/${projectSlug}/sessions/sess-end-2/end`, {
        token: adminToken.plaintext,
      });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.endedAt).toBe(firstEnd);
    });

    it('end accepts summary and title atomically (final:false precedence)', async () => {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-end-with-summary' },
      });
      const r = await call(app, 'POST', `/${projectSlug}/sessions/sess-end-with-summary/end`, {
        token: adminToken.plaintext,
        body: { summary: 'transcript dump', title: 'Bug fix', final: false },
      });
      expect(r.status).toBe(200);
      const row = agentSessions.getById('sess-end-with-summary');
      expect(row?.status).toBe('ended');
      expect(row?.summary).toBe('transcript dump');
      expect(row?.title).toBe('Bug fix');
      expect(row?.summaryFinal).toBe(false);
    });

    it('end truncates oversize summary server-side and still transitions', async () => {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-end-trunc' },
      });
      const r = await call(app, 'POST', `/${projectSlug}/sessions/sess-end-trunc/end`, {
        token: adminToken.plaintext,
        body: { summary: 'A'.repeat(SUMMARY_MAX_CHARS + 2000), final: false },
      });
      expect(r.status).toBe(200);
      const row = agentSessions.getById('sess-end-trunc');
      expect(row?.status).toBe('ended');
      expect(row?.endedAt).not.toBeNull();
      expect(row?.summary?.length).toBe(SUMMARY_MAX_CHARS);
      expect(row?.summary?.startsWith('…[truncated]')).toBe(true);
    });

    it('404 when the session belongs to a different project than the URL slug (archived-project bypass)', async () => {
      const app = makeApp();
      const archivedProj = projects.create({ slug: 'archived-proj-end' });
      await call(app, 'POST', `/${archivedProj.slug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-end-in-archived-proj' },
      });
      projects.archive(archivedProj.id);

      const r = await call(app, 'POST', `/${projectSlug}/sessions/sess-end-in-archived-proj/end`, {
        token: adminToken.plaintext,
        body: { summary: 'bypass attempt' },
      });
      expect(r.status).toBe(404);
      expect(r.body.code).toBe('session_not_found');
      const row = agentSessions.getById('sess-end-in-archived-proj');
      expect(row?.status).toBe('active');
    });

    it('403 when a project-scoped token lacks write authorization for the URL slug', async () => {
      const app = makeApp();
      const other = projects.create({ slug: 'other-end-proj' });
      const r = await call(app, 'POST', `/${other.slug}/sessions/whatever-id/end`, {
        token: projectScopedToken.plaintext,
      });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('forbidden');
    });

    it('end on already-ended session preserves final summary against non-final overwrite', async () => {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-end-protected' },
      });
      // Model writes a final summary first.
      await call(app, 'POST', `/${projectSlug}/sessions/sess-end-protected/summary`, {
        token: adminToken.plaintext,
        body: { summary: 'model wrote', title: 'Real title', final: true },
      });
      // Bash hook then ends with a non-final fallback.
      await call(app, 'POST', `/${projectSlug}/sessions/sess-end-protected/end`, {
        token: adminToken.plaintext,
        body: { summary: 'raw transcript', title: 'fallback title', final: false },
      });
      const row = agentSessions.getById('sess-end-protected');
      // Model values preserved through the end transition.
      expect(row?.status).toBe('ended');
      expect(row?.summary).toBe('model wrote');
      expect(row?.title).toBe('Real title');
    });

    it('end on an abandoned session applies the summary without promoting the status', async () => {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-end-abandoned' },
      });
      agentSessions.markAbandoned('sess-end-abandoned', { adminBypass: true });
      const before = agentSessions.getById('sess-end-abandoned');
      const r = await call(app, 'POST', `/${projectSlug}/sessions/sess-end-abandoned/end`, {
        token: adminToken.plaintext,
        body: { summary: 'transcript', title: 'Fix the reaper', final: false },
      });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.endedAt).toBe(before?.endedAt?.toISOString());
      const row = agentSessions.getById('sess-end-abandoned');
      expect(row?.summary).toBe('transcript');
      expect(row?.title).toBe('Fix the reaper');
      expect(row?.status).toBe('abandoned');
      expect(row?.endedAt?.getTime()).toBe(before?.endedAt?.getTime());
      expect(row?.lastActivityAt?.getTime()).toBe(before?.lastActivityAt?.getTime());
    });
  });

  describe('no session route resumes a terminal row', () => {
    async function terminalSession(id: string, terminal: 'ended' | 'abandoned') {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id },
      });
      if (terminal === 'ended') {
        await call(app, 'POST', `/${projectSlug}/sessions/${id}/end`, {
          token: adminToken.plaintext,
        });
      } else {
        agentSessions.markAbandoned(id, { adminBypass: true });
      }
      return app;
    }

    it.each(['ended', 'abandoned'] as const)(
      'the ensure POST reports created: false and leaves the row %s',
      async (terminal) => {
        const id = `sess-ensure-${terminal}`;
        const app = await terminalSession(id, terminal);
        const before = agentSessions.getById(id);

        const r = await call(app, 'POST', `/${projectSlug}/sessions`, {
          token: adminToken.plaintext,
          body: { id },
        });

        expect(r.status).toBe(200);
        expect(r.body.created).toBe(false);
        expect(r.body.sessionId).toBe(id);
        const row = agentSessions.getById(id);
        expect(row?.status).toBe(terminal);
        expect(row?.endedAt?.getTime()).toBe(before?.endedAt?.getTime());
      },
    );

    it('neither /summary nor /end revives it either, and the row is resumable all along', async () => {
      const id = 'sess-no-http-resume';
      const app = await terminalSession(id, 'ended');
      const before = agentSessions.getById(id);

      for (const path of [
        `/${projectSlug}/sessions/${id}/summary`,
        `/${projectSlug}/sessions/${id}/end`,
      ]) {
        const r = await call(app, 'POST', path, {
          token: adminToken.plaintext,
          body: { summary: 'still talking' },
        });
        expect(r.status).toBe(200);
        const row = agentSessions.getById(id);
        expect(row?.status).toBe('ended');
        expect(row?.endedAt?.getTime()).toBe(before?.endedAt?.getTime());
      }

      // Control: the row was revivable the whole time — only the service verb
      // does it, so the assertions above are about the routes, not the fixture.
      agentSessions.resume(id, { tokenId: adminToken.id });
      const resumed = agentSessions.getById(id);
      expect(resumed?.status).toBe('active');
      expect(resumed?.endedAt).toBeNull();
    });
  });

  describe('every session route is classified as resuming or not', () => {
    /**
     * Keyed by the Hono pattern the router registers, and asserted set-equal to
     * it below: the previous shape enumerated only `/summary` and `/end`, so a
     * new route that revived a terminal row would have passed unnoticed.
     */
    const SESSION_ROUTES: Record<
      string,
      { resumesTerminalRows: boolean; body: (id: string) => unknown }
    > = {
      '/:slug/sessions': { resumesTerminalRows: false, body: (id) => ({ id }) },
      '/:slug/sessions/:id/summary': {
        resumesTerminalRows: false,
        body: () => ({ summary: 'still talking' }),
      },
      '/:slug/sessions/:id/end': { resumesTerminalRows: false, body: () => ({}) },
      '/:slug/sessions/:id/resume': { resumesTerminalRows: true, body: () => ({}) },
    };

    it('the classification covers exactly the POST routes the router registers', () => {
      const registered = makeApp()
        .routes.filter((r) => r.method === 'POST' && r.path.startsWith('/:slug/sessions'))
        .map((r) => r.path);
      expect([...new Set(registered)].sort()).toEqual(Object.keys(SESSION_ROUTES).sort());
    });

    for (const [route, spec] of Object.entries(SESSION_ROUTES)) {
      const verb = spec.resumesTerminalRows ? 'returns' : 'does not return';
      it(`POST ${route} ${verb} an ended row to active`, async () => {
        const id = `sess-class-${route.replace(/[^a-z]/g, '') || 'root'}`;
        agentSessions.ensure({ id, tokenId: adminToken.id, projectId, agent: 'probe' });
        agentSessions.end(id, { tokenId: adminToken.id });
        const before = agentSessions.getById(id);
        expect(before?.status).toBe('ended');

        const path = `/${projectSlug}${route.replace('/:slug', '').replace(':id', id)}`;
        const r = await call(makeApp(), 'POST', path, {
          token: adminToken.plaintext,
          body: spec.body(id),
        });

        expect(r.status).toBe(200);
        const row = agentSessions.getById(id);
        if (spec.resumesTerminalRows) {
          expect(row?.status).toBe('active');
          expect(row?.endedAt).toBeNull();
        } else {
          expect(row?.status).toBe('ended');
          expect(row?.endedAt?.getTime()).toBe(before?.endedAt?.getTime());
        }
      });
    }
  });

  describe('POST /:slug/sessions/:id/resume', () => {
    function terminalSession(id: string, terminal: 'ended' | 'abandoned') {
      agentSessions.ensure({ id, tokenId: adminToken.id, projectId, agent: 'probe' });
      if (terminal === 'ended') {
        agentSessions.end(id, { tokenId: adminToken.id });
      } else {
        agentSessions.markAbandoned(id, { adminBypass: true });
      }
      return agentSessions.getById(id)!;
    }

    it('returns an ended session to active and reports what it discarded', async () => {
      const id = 'sess-resume-ended';
      const before = terminalSession(id, 'ended');

      const r = await call(makeApp(), 'POST', `/${projectSlug}/sessions/${id}/resume`, {
        token: adminToken.plaintext,
        body: {},
      });

      expect(r.status).toBe(200);
      const { resumedAt, ...reported } = r.body;
      expect(reported).toEqual({
        ok: true,
        sessionId: id,
        status: 'active',
        startedAt: before.startedAt.toISOString(),
        previousStatus: 'ended',
        previousEndedAt: before.endedAt!.toISOString(),
        title: before.title,
      });
      const row = agentSessions.getById(id);
      expect(resumedAt).toBe(row?.lastActivityAt?.toISOString());
      expect(row?.status).toBe('active');
      expect(row?.endedAt).toBeNull();
    });

    it('resumes an abandoned session identically, differing only in previousStatus', async () => {
      const id = 'sess-resume-abandoned';
      const before = terminalSession(id, 'ended');

      const fromEnded = await call(makeApp(), 'POST', `/${projectSlug}/sessions/${id}/resume`, {
        token: adminToken.plaintext,
        body: {},
      });
      const afterEnded = agentSessions.getById(id)!;

      agentSessions.markAbandoned(id, { adminBypass: true });
      const fromAbandoned = await call(makeApp(), 'POST', `/${projectSlug}/sessions/${id}/resume`, {
        token: adminToken.plaintext,
        body: {},
      });
      const afterAbandoned = agentSessions.getById(id)!;

      expect(fromAbandoned.body.previousStatus).toBe('abandoned');
      expect(fromEnded.body.previousStatus).toBe('ended');
      // The two timestamps are the two transitions' own clocks, not a
      // difference in what the route reports.
      const normalizeResponse = (body: Record<string, unknown>) => ({
        ...body,
        previousStatus: 'ended',
        previousEndedAt: null,
        resumedAt: null,
      });
      expect(normalizeResponse(fromAbandoned.body)).toEqual(normalizeResponse(fromEnded.body));
      expect(fromAbandoned.body.previousEndedAt).not.toBeNull();
      expect(fromEnded.body.previousEndedAt).not.toBeNull();
      // `last_activity_at` is the one column a second resume must move.
      expect({ ...afterAbandoned, lastActivityAt: null }).toEqual({
        ...afterEnded,
        lastActivityAt: null,
      });
      expect(afterAbandoned.lastActivityAt).not.toBeNull();
      expect(before.endedAt).not.toBeNull();
    });

    it('is a success no-op on an already-active row, leaving last_activity_at alone', async () => {
      const id = 'sess-resume-noop';
      agentSessions.ensure({ id, tokenId: adminToken.id, projectId, agent: 'probe' });
      const before = agentSessions.getById(id)!;
      expect(before.lastActivityAt).not.toBeNull();

      const r = await call(makeApp(), 'POST', `/${projectSlug}/sessions/${id}/resume`, {
        token: adminToken.plaintext,
        body: {},
      });

      expect(r.status).toBe(200);
      expect(r.body.previousStatus).toBe('active');
      expect(r.body.previousEndedAt).toBeNull();
      expect(r.body.resumedAt).toBe(before.lastActivityAt!.toISOString());
      const after = agentSessions.getById(id)!;
      expect(after.lastActivityAt?.getTime()).toBe(before.lastActivityAt?.getTime());
      expect(after).toEqual(before);
    });

    it('refuses an unknown property, with the {} control succeeding in the same run', async () => {
      const id = 'sess-resume-strict';
      terminalSession(id, 'ended');

      const rejected = await call(makeApp(), 'POST', `/${projectSlug}/sessions/${id}/resume`, {
        token: adminToken.plaintext,
        body: { epoch: 3 },
      });

      expect(rejected.status).toBe(400);
      expect(rejected.body.code).toBe('invalid_input');
      expect(rejected.body.message).toContain('epoch');
      expect(agentSessions.getById(id)?.status).toBe('ended');

      const accepted = await call(makeApp(), 'POST', `/${projectSlug}/sessions/${id}/resume`, {
        token: adminToken.plaintext,
        body: {},
      });
      expect(accepted.status).toBe(200);
      expect(agentSessions.getById(id)?.status).toBe('active');
    });

    it('accepts an absent body, as the bash helper sends', async () => {
      const id = 'sess-resume-nobody';
      terminalSession(id, 'ended');

      const r = await call(makeApp(), 'POST', `/${projectSlug}/sessions/${id}/resume`, {
        token: adminToken.plaintext,
      });

      expect(r.status).toBe(200);
      expect(agentSessions.getById(id)?.status).toBe('active');
    });

    it('409 session_deleted on a soft-deleted row, which stays deleted and terminal', async () => {
      const id = 'sess-resume-deleted';
      terminalSession(id, 'ended');
      agentSessions.softDelete(id, { tokenId: adminToken.id });

      const r = await call(makeApp(), 'POST', `/${projectSlug}/sessions/${id}/resume`, {
        token: adminToken.plaintext,
        body: {},
      });

      expect(r.status).toBe(409);
      expect(r.body.code).toBe('session_deleted');
      const row = agentSessions.getById(id);
      expect(row?.deletedAt).not.toBeNull();
      expect(row?.status).toBe('ended');
    });

    it('404 session_not_found when the row belongs to another token, never 403', async () => {
      const id = 'sess-resume-othertoken';
      const before = terminalSession(id, 'ended');

      const r = await call(makeApp(), 'POST', `/${projectSlug}/sessions/${id}/resume`, {
        token: projectScopedToken.plaintext,
        body: {},
      });

      expect(r.status).toBe(404);
      expect(r.body.code).toBe('session_not_found');
      expect(agentSessions.getById(id)).toEqual(before);
    });

    it('404 session_not_found when the row belongs to another project', async () => {
      const other = projects.create({ slug: 'resume-other-proj' });
      const id = 'sess-resume-otherproj';
      agentSessions.ensure({
        id,
        tokenId: adminToken.id,
        projectId: other.id,
        agent: 'probe',
      });
      agentSessions.end(id, { tokenId: adminToken.id });
      const before = agentSessions.getById(id);

      const r = await call(makeApp(), 'POST', `/${projectSlug}/sessions/${id}/resume`, {
        token: adminToken.plaintext,
        body: {},
      });

      expect(r.status).toBe(404);
      expect(r.body.code).toBe('session_not_found');
      expect(agentSessions.getById(id)).toEqual(before);
    });

    it('403 forbidden for a read-only token, leaving the row terminal', async () => {
      const readOnly = tokens.create({
        name: 'resume-read-only',
        project: projects.getById(projectId)!,
        access: 'read',
      });
      const id = 'sess-resume-readonly';
      const before = terminalSession(id, 'ended');

      const r = await call(makeApp(), 'POST', `/${projectSlug}/sessions/${id}/resume`, {
        token: readOnly.plaintext,
        body: {},
      });

      expect(r.status).toBe(403);
      expect(r.body.code).toBe('forbidden');
      expect(agentSessions.getById(id)).toEqual(before);
    });

    it('404 on the path-less /sessions/:id/resume', async () => {
      const id = 'sess-resume-noslug';
      terminalSession(id, 'ended');

      const r = await call(makeApp(), 'POST', `/sessions/${id}/resume`, {
        token: adminToken.plaintext,
        body: {},
      });

      expect(r.status).toBe(404);
      expect(r.body.code).toBe('not_found');
      expect(agentSessions.getById(id)?.status).toBe('ended');
    });

    it('does not pin the SessionRouter, though memory.session_resume on the same row does', async () => {
      const tokenRow = db.handle.db
        .select()
        .from(tokensSchema)
        .where(eq(tokensSchema.id, adminToken.id))
        .get()!;
      const router = new SessionRouter();
      const handlers = buildSessionHandlers({ agentSessions, projects, router });
      const mcpSessionId = 'mcp-transport-1';
      const ctx: RequestContext = {
        token: tokenRow,
        scope: '*',
        memberProjectIds: [],
        project: projects.getById(projectId)!,
        requestedSlug: projectSlug,
        mcpSessionId,
      };
      const id = 'sess-resume-router';
      terminalSession(id, 'ended');

      const r = await call(makeApp(), 'POST', `/${projectSlug}/sessions/${id}/resume`, {
        token: adminToken.plaintext,
        body: {},
      });
      expect(r.status).toBe(200);
      expect(router.get(tokenRow.id, mcpSessionId)?.rembricSessionId ?? null).toBeNull();

      agentSessions.end(id, { tokenId: adminToken.id });
      const mcp = (await runWithContext(ctx, () =>
        handlers.sessionResume({ sessionId: id }),
      )) as unknown as { isError?: boolean };
      expect(mcp.isError).toBeFalsy();
      expect(router.get(tokenRow.id, mcpSessionId)?.rembricSessionId).toBe(id);
    });
  });

  describe('POST /:slug/memory/recall', () => {
    it('returns ranked memories and a formatted <memory-context> block', async () => {
      memory.save(
        { type: 'user', title: 'auth token handling', content: 'auth token handling notes' },
        projectScope(projectId),
      );
      const app = makeApp();
      const r = await call(app, 'POST', `/${projectSlug}/memory/recall`, {
        token: adminToken.plaintext,
        body: { query: 'auth token handling' },
      });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      const memories = r.body.memories as { id: string; title: string; snippet: string }[];
      expect(memories.length).toBeGreaterThan(0);
      expect(memories[0]?.title).toBe('auth token handling');
      expect(r.body.formatted).toContain('<memory-context>');
      expect(r.body.formatted).toContain('auth token handling');
    });

    it('does not bump last_seen_at (passive recall must not inflate recency)', async () => {
      const saved = memory.save(
        { type: 'user', title: 'recency probe row', content: 'recency probe content' },
        projectScope(projectId),
      );
      const before = memory.unsafeGetById(saved.id)?.lastSeenAt?.getTime();
      const app = makeApp();
      const r = await call(app, 'POST', `/${projectSlug}/memory/recall`, {
        token: adminToken.plaintext,
        body: { query: 'recency probe' },
      });
      expect(r.status).toBe(200);
      expect((r.body.memories as unknown[]).length).toBeGreaterThan(0);
      const after = memory.unsafeGetById(saved.id)?.lastSeenAt?.getTime();
      expect(after).toBe(before);
    });

    it('returns an empty formatted string when nothing matches', async () => {
      const app = makeApp();
      const r = await call(app, 'POST', `/${projectSlug}/memory/recall`, {
        token: adminToken.plaintext,
        body: { query: 'no such memory exists anywhere' },
      });
      expect(r.status).toBe(200);
      expect(r.body.memories).toEqual([]);
      expect(r.body.formatted).toBe('');
    });

    it('clamps limit above 5 rather than rejecting the request', async () => {
      for (let i = 0; i < 7; i++) {
        memory.save(
          { type: 'user', title: `bulk row ${i}`, content: `bulk row content ${i}` },
          projectScope(projectId),
        );
      }
      const app = makeApp();
      const r = await call(app, 'POST', `/${projectSlug}/memory/recall`, {
        token: adminToken.plaintext,
        body: { query: 'bulk row', limit: 50 },
      });
      expect(r.status).toBe(200);
      const memories = r.body.memories as unknown[];
      expect(memories.length).toBeLessThanOrEqual(5);
    });

    it('rejects a missing or empty query without executing a search', async () => {
      const app = makeApp();
      const missing = await call(app, 'POST', `/${projectSlug}/memory/recall`, {
        token: adminToken.plaintext,
        body: {},
      });
      expect(missing.status).toBe(400);
      expect(missing.body.code).toBe('invalid_input');

      const empty = await call(app, 'POST', `/${projectSlug}/memory/recall`, {
        token: adminToken.plaintext,
        body: { query: '' },
      });
      expect(empty.status).toBe(400);
    });

    it('matches the existing /api/<slug>/* auth/scope error contract', async () => {
      const app = makeApp();

      const noToken = await call(app, 'POST', `/${projectSlug}/memory/recall`, {
        body: { query: 'x' },
      });
      expect(noToken.status).toBe(401);
      expect(noToken.body.code).toBe('missing_token');

      const badToken = await call(app, 'POST', `/${projectSlug}/memory/recall`, {
        token: 'not-a-real-token',
        body: { query: 'x' },
      });
      expect(badToken.status).toBe(401);
      expect(badToken.body.code).toBe('token_invalid');

      const unknownSlug = await call(app, 'POST', `/unknown-slug-xyz/memory/recall`, {
        token: adminToken.plaintext,
        body: { query: 'x' },
      });
      expect(unknownSlug.status).toBe(404);
      expect(unknownSlug.body.code).toBe('project_not_found');

      const otherProj = projects.create({ slug: 'other-recall-proj' });
      const otherToken = tokens.create({ name: 'other', project: otherProj, access: 'write' });
      const forbidden = await call(app, 'POST', `/${projectSlug}/memory/recall`, {
        token: otherToken.plaintext,
        body: { query: 'x' },
      });
      expect(forbidden.status).toBe(403);
      expect(forbidden.body.code).toBe('forbidden');
    });
  });
});

// The boundary check runs before an awaited body upload, so a soft-delete can
// land between it and the write. These arms drive that interleave; the guard
// they cover lives in the service, whose own re-read is the fresh one.
describe('a soft-delete landing between the boundary check and the write', () => {
  const RACE_SESSION = 'race-session-0001';

  class SignallingSessions extends AgentSessionsService {
    public checkReads = 0;
    public onFirstRead: (() => void) | null = null;
    override getById(sessionId: string) {
      const row = super.getById(sessionId);
      this.checkReads += 1;
      if (this.checkReads === 1) this.onFirstRead?.();
      return row;
    }
  }

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  }

  // Only pulled when the handler calls `c.req.json()`, i.e. strictly after the
  // boundary check returned. Signalling from `start` instead fires at Request
  // construction, which makes every arm look clean and the defect look absent.
  function stalledBody(payload: string, gate: Promise<void>) {
    const full = new TextEncoder().encode(payload);
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(full.slice(0, 4));
        await gate;
        controller.enqueue(full.slice(4));
        controller.close();
      },
    });
  }

  async function raceCall(path: string, payload: string, interleave: (() => void) | null) {
    const sessions = new SignallingSessions(createRepositories(db.handle.db), db.handle.db);
    const checked = deferred();
    sessions.onFirstRead = () => checked.resolve();
    const gate = deferred();
    const app = createApiRouter({ agentSessions: sessions, memory, tokens, projects });
    const req = Promise.resolve(
      app.request(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${projectScopedToken.plaintext}`,
        },
        body: stalledBody(payload, gate.promise),
        // undici needs this for a streaming body.
        duplex: 'half',
      }),
    );
    const reached = await Promise.race([checked.promise.then(() => true), req.then(() => false)]);
    if (reached && interleave) interleave();
    gate.resolve();
    const res = await req;
    let body: Record<string, unknown>;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    return { status: res.status, body, reachedTheWindow: reached };
  }

  beforeEach(() => {
    agentSessions.ensure({
      id: RACE_SESSION,
      tokenId: projectScopedToken.id,
      projectId,
      agent: 'probe',
    });
  });

  it('CONTROL: without an interleave the write still succeeds', async () => {
    const r = await raceCall(
      `/${projectSlug}/sessions/${RACE_SESSION}/end`,
      JSON.stringify({ summary: 'control one' }),
      null,
    );
    expect(r.status).toBe(200);
    expect(agentSessions.getById(RACE_SESSION)?.status).toBe('ended');
  });

  it('CONTROL: a row deleted before the request is refused', async () => {
    agentSessions.softDelete(RACE_SESSION, { tokenId: projectScopedToken.id });
    const r = await raceCall(
      `/${projectSlug}/sessions/${RACE_SESSION}/end`,
      JSON.stringify({ summary: 'pre-deleted' }),
      null,
    );
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('session_deleted');
  });

  for (const [label, path] of [
    ['end', 'end'],
    ['summary', 'summary'],
  ] as const) {
    it(`/${label} on an active row refuses a delete that lands inside the window`, async () => {
      const r = await raceCall(
        `/${projectSlug}/sessions/${RACE_SESSION}/${path}`,
        JSON.stringify({ summary: 'raced onto a deleted row' }),
        () => agentSessions.softDelete(RACE_SESSION, { tokenId: projectScopedToken.id }),
      );
      // Without this the interleave never landed inside the window and the
      // assertions below would pass for the wrong reason.
      expect(r.reachedTheWindow).toBe(true);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('session_deleted');
      const row = agentSessions.getById(RACE_SESSION);
      expect(row?.status).toBe('active');
      expect(row?.summary).toBeNull();
    });

    it(`/${label} on a terminal row reports the delete as 409, not 500`, async () => {
      agentSessions.end(RACE_SESSION, { tokenId: projectScopedToken.id });
      const r = await raceCall(
        `/${projectSlug}/sessions/${RACE_SESSION}/${path}`,
        JSON.stringify({ summary: 'raced onto a deleted terminal row' }),
        () => agentSessions.softDelete(RACE_SESSION, { tokenId: projectScopedToken.id }),
      );
      expect(r.reachedTheWindow).toBe(true);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('session_deleted');
    });
  }
});
