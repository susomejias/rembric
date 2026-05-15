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
    it('persists summary and ends the session', async () => {
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
      expect(row?.status).toBe('ended');
      expect(row?.summary).toContain('Goal: x');
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

    it('409 session_already_ended on second summary', async () => {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-twice' },
      });
      await call(app, 'POST', `/${projectSlug}/sessions/sess-twice/summary`, {
        token: adminToken.plaintext,
        body: { summary: 'first' },
      });
      const r = await call(app, 'POST', `/${projectSlug}/sessions/sess-twice/summary`, {
        token: adminToken.plaintext,
        body: { summary: 'second' },
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

    it('409 on double-end', async () => {
      const app = makeApp();
      await call(app, 'POST', `/${projectSlug}/sessions`, {
        token: adminToken.plaintext,
        body: { id: 'sess-end-2' },
      });
      await call(app, 'POST', `/${projectSlug}/sessions/sess-end-2/end`, {
        token: adminToken.plaintext,
      });
      const r = await call(app, 'POST', `/${projectSlug}/sessions/sess-end-2/end`, {
        token: adminToken.plaintext,
      });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('session_already_ended');
    });
  });
});
