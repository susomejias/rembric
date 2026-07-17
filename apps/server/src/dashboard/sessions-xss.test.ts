import { randomBytes } from 'node:crypto';

import { Hono, type Context, type Next } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { agentSessions } from '../db/schema/agent-sessions.js';
import { projects } from '../db/schema/projects.js';
import { prompts } from '../db/schema/prompts.js';
import { tokens } from '../db/schema/tokens.js';
import { AgentSessionsService } from '../services/agent-sessions.js';
import { SessionsService } from '../services/sessions.js';
import { TokensService } from '../services/tokens.js';
import { agentSessionRow as row, createTestDb, type TestDb } from '../test/index.js';

import { createSessionsRouter } from './sessions.js';
import type { ResolvedSession } from './types.js';

/**
 * 0252 — stored XSS via prompt tags / project slug on the session-detail
 * and session-list dashboard pages.
 */
describe('dashboard sessions XSS regression (#252)', () => {
  let t: TestDb;
  let app: Hono;

  beforeEach(() => {
    t = createTestDb();
    const repos = createRepositories(t.handle.db);
    const sessions = new SessionsService(repos, randomBytes(32));
    const tokensSvc = new TokensService(repos);
    const admin = tokensSvc.create({ name: 'admin', scope: '*', projectId: null });
    const created = sessions.create(admin.token.id);
    const session: ResolvedSession = {
      session: created.session,
      sessions,
      tokenId: admin.token.id,
    };

    t.handle.db
      .insert(tokens)
      .values([{ id: 'tk1', name: 'test', hash: 'x', scope: '*', createdAt: new Date(500) }])
      .run();
    t.handle.db
      .insert(agentSessions)
      .values([row({ id: 'S1', status: 'ended', tokenId: 'tk1' })])
      .run();
    t.handle.db
      .insert(prompts)
      .values([
        {
          id: 'P1',
          sessionId: 'S1',
          content: 'deploy notes',
          title: 'deploy',
          tags: ['<img src=x onerror=alert(1)>'],
          createdAt: new Date(1_000),
        },
      ])
      .run();

    const agentSessionsSvc = new AgentSessionsService(repos, t.handle.db);
    app = new Hono();
    app.use('*', (c: Context, next: Next) => {
      c.set('session' as never, session as never);
      return next();
    });
    app.route('/', createSessionsRouter({ repos, sessions, agentSessions: agentSessionsSvc }));
  });

  afterEach(() => t.cleanup());

  it('escapes a malicious prompt tag on the session-detail page', async () => {
    const res = await app.request('/S1');
    const html = await res.text();
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapes a legacy (pre-regex) project slug on the session-list page', async () => {
    t.handle.db
      .insert(projects)
      .values([{ id: 'PR1', slug: 'legit-slug', createdAt: new Date(500) }])
      .run();
    // Simulate a legacy slug containing HTML — the SLUG_REGEX only guards
    // new writes, not rows that predate it.
    t.handle.raw
      .prepare("UPDATE projects SET slug = '<script>alert(1)</script>' WHERE id = 'PR1'")
      .run();
    t.handle.raw.prepare("UPDATE sessions SET project_id = 'PR1' WHERE id = 'S1'").run();

    const res = await app.request('/');
    const html = await res.text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
