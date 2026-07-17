import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { tokens as tokensSchema } from '../db/schema/tokens.js';
import { AgentSessionsService, SUMMARY_MAX_CHARS } from '../services/agent-sessions.js';
import { MemoryService } from '../services/memory.js';
import { ProjectsService } from '../services/projects.js';
import { projectScope } from '../services/scope.js';
import { TokensService } from '../services/tokens.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { createApiRouter } from './api-router.js';

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
  tokens = new TokensService(createRepositories(db.handle.db));

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

  const created = tokens.create({ name: 'proj-scoped', scope: `project:${proj.id}` });
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

    it('409 session_already_ended on summary write to an ended session', async () => {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-already-ended' },
      });
      await call(app, 'POST', `/${projectSlug}/sessions/sess-already-ended/end`, {
        token: adminToken.plaintext,
      });
      const r = await call(app, 'POST', `/${projectSlug}/sessions/sess-already-ended/summary`, {
        token: adminToken.plaintext,
        body: { summary: 'after-end' },
      });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('session_already_ended');
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

    it('truncates summary > SUMMARY_MAX_CHARS server-side with the …[truncated] suffix', async () => {
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
      expect(row?.summary?.endsWith('…[truncated]')).toBe(true);
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
      expect(row?.summary?.endsWith('…[truncated]')).toBe(true);
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
      expect(row?.summary?.endsWith('…[truncated]')).toBe(true);
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
      const otherToken = tokens.create({ name: 'other', scope: `project:${otherProj.id}` });
      const forbidden = await call(app, 'POST', `/${projectSlug}/memory/recall`, {
        token: otherToken.plaintext,
        body: { query: 'x' },
      });
      expect(forbidden.status).toBe(403);
      expect(forbidden.body.code).toBe('forbidden');
    });
  });
});
