import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tokens as tokensSchema } from '../db/schema/tokens.js';
import { AgentSessionsService } from '../services/agent-sessions.js';
import { ProjectsService } from '../services/projects.js';
import { TokensService } from '../services/tokens.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { createApiRouter } from './api-router.js';

let db: TestDb;
let agentSessions: AgentSessionsService;
let projects: ProjectsService;
let tokens: TokensService;
let adminToken: { id: string; plaintext: string };
let projectScopedToken: { id: string; plaintext: string };
let projectSlug: string;

const ADMIN_BOOTSTRAP = 'test-admin-token-with-enough-entropy';

function makeApp() {
  return createApiRouter({ agentSessions, tokens, projects });
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
  agentSessions = new AgentSessionsService(db.handle.db);
  projects = new ProjectsService(db.handle.db);
  tokens = new TokensService(db.handle.db);

  tokens.bootstrapAdmin(ADMIN_BOOTSTRAP);
  const admin = db.handle.db
    .select()
    .from(tokensSchema)
    .where(eq(tokensSchema.name, 'admin'))
    .get();
  adminToken = { id: admin!.id, plaintext: ADMIN_BOOTSTRAP };

  const proj = projects.create({ slug: 'api-test-proj' });
  projectSlug = proj.slug;

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

    it('persists title alongside summary (always final:false on HTTP path)', async () => {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-sum-title' },
      });
      const r = await call(app, 'POST', `/${projectSlug}/sessions/sess-sum-title/summary`, {
        token: adminToken.plaintext,
        body: { summary: 'Goal', title: 'Fix bug' },
      });
      expect(r.status).toBe(200);
      const row = agentSessions.getById('sess-sum-title');
      expect(row?.summary).toBe('Goal');
      expect(row?.title).toBe('Fix bug');
      // HTTP path never lifts `_final` — only memory.session_summary (MCP) can.
      expect(row?.summaryFinal).toBe(false);
      expect(row?.titleFinal).toBe(false);
    });

    it('HTTP body `final:true` is silently ignored on /summary', async () => {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-final-ignored' },
      });
      const r = await call(app, 'POST', `/${projectSlug}/sessions/sess-final-ignored/summary`, {
        token: adminToken.plaintext,
        // A misbehaving plugin tries to lift the curated flag via HTTP.
        body: { summary: 'raw transcript', title: 'fake curated', final: true },
      });
      expect(r.status).toBe(200);
      const row = agentSessions.getById('sess-final-ignored');
      // zod strips `final`; handler hard-codes false; flags stay 0.
      expect(row?.summaryFinal).toBe(false);
      expect(row?.titleFinal).toBe(false);
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

    it('HTTP write is silently blocked when summary_final is already true', async () => {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-twice' },
      });
      // Simulate a prior memory.session_summary (MCP) call that set final=1.
      // The HTTP path can never lift that flag itself, so we set it via the
      // service layer (the only legitimate path).
      agentSessions.writeSummary('sess-twice', {
        tokenId: adminToken.id,
        summary: 'final-first',
        final: true,
      });
      // Now a HTTP-path Stop hook tries to overwrite (final defaults to false).
      const r = await call(app, 'POST', `/${projectSlug}/sessions/sess-twice/summary`, {
        token: adminToken.plaintext,
        body: { summary: 'non-final-second' },
      });
      expect(r.status).toBe(200);
      const row = agentSessions.getById('sess-twice');
      // Curated value wins; HTTP overwrite is ignored.
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

    it('end accepts summary and title atomically (always final:false on HTTP path)', async () => {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-end-with-summary' },
      });
      const r = await call(app, 'POST', `/${projectSlug}/sessions/sess-end-with-summary/end`, {
        token: adminToken.plaintext,
        body: { summary: 'transcript dump', title: 'Bug fix' },
      });
      expect(r.status).toBe(200);
      const row = agentSessions.getById('sess-end-with-summary');
      expect(row?.status).toBe('ended');
      expect(row?.summary).toBe('transcript dump');
      expect(row?.title).toBe('Bug fix');
      expect(row?.summaryFinal).toBe(false);
      expect(row?.titleFinal).toBe(false);
    });

    it('HTTP body `final:true` is silently ignored on /end', async () => {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-end-final-ignored' },
      });
      const r = await call(app, 'POST', `/${projectSlug}/sessions/sess-end-final-ignored/end`, {
        token: adminToken.plaintext,
        body: { summary: 'transcript', title: 'fallback', final: true },
      });
      expect(r.status).toBe(200);
      const row = agentSessions.getById('sess-end-final-ignored');
      expect(row?.status).toBe('ended');
      expect(row?.summaryFinal).toBe(false);
      expect(row?.titleFinal).toBe(false);
    });

    it('end on already-ended session preserves curated summary against HTTP overwrite', async () => {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-end-protected' },
      });
      // Simulate a prior memory.session_summary (MCP) call that curated.
      agentSessions.writeSummary('sess-end-protected', {
        tokenId: adminToken.id,
        summary: 'model wrote',
        title: 'Real title',
        final: true,
      });
      // Bash hook then ends with the HTTP fallback (which is always final:false).
      await call(app, 'POST', `/${projectSlug}/sessions/sess-end-protected/end`, {
        token: adminToken.plaintext,
        body: { summary: 'raw transcript', title: 'fallback title' },
      });
      const row = agentSessions.getById('sess-end-protected');
      // Curated values preserved through the end transition.
      expect(row?.status).toBe('ended');
      expect(row?.summary).toBe('model wrote');
      expect(row?.title).toBe('Real title');
    });
  });
});
