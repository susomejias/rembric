import { randomBytes } from 'node:crypto';

import { Hono, type Context, type Next } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { agentSessions } from '../db/schema/agent-sessions.js';
import { tokens } from '../db/schema/tokens.js';
import { AgentSessionsService } from '../services/agent-sessions.js';
import { SessionsService } from '../services/sessions.js';
import { TokensService } from '../services/tokens.js';
import { agentSessionRow as row, createTestDb, type TestDb } from '../test/index.js';

import { createSessionsRouter } from './sessions.js';
import type { ResolvedSession } from './types.js';

describe('session detail curation-state rendering', () => {
  let t: TestDb;
  let app: Hono;

  beforeEach(() => {
    t = createTestDb();
    const repos = createRepositories(t.handle.db);
    const sessions = new SessionsService(repos, randomBytes(32));
    const tokensSvc = new TokensService(repos, t.handle.db);
    const admin = tokensSvc.create({ name: 'admin', scope: '*' });
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
      .values([
        row({
          id: 'S-CURATED',
          status: 'ended',
          description: 'seed goal here',
          summary: 'Goal: fix the bug.\n\n**Accomplished**: fixed it.',
          summaryFinal: true,
        }),
        row({
          id: 'S-RAW',
          status: 'ended',
          description: 'seed goal here',
          summary: 'user: fix the bug\nassistant: **Fixed it.**',
          summaryFinal: false,
        }),
        row({ id: 'S-EMPTY', status: 'active' }),
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

  it('renders a curated summary as Markdown with no RAW chip', async () => {
    const res = await app.request('/S-CURATED');
    const html = await res.text();
    expect(html).toContain('<strong>Accomplished</strong>');
    expect(html).not.toContain('class="pill raw"');
    expect(html).toContain('seed goal here');
  });

  it('renders an uncurated summary as escaped preformatted text with a RAW chip', async () => {
    const res = await app.request('/S-RAW');
    const html = await res.text();
    expect(html).toContain('class="pill raw"');
    expect(html).toContain('>RAW<');
    expect(html).toMatch(/<pre>[^]*fix the bug[^]*<\/pre>/);
    expect(html).not.toContain('<strong>Fixed it.</strong>');
    expect(html).toContain('**Fixed it.**');
    expect(html).toContain('seed goal here');
  });

  it('renders no summary and no chip for an empty session', async () => {
    const res = await app.request('/S-EMPTY');
    const html = await res.text();
    expect(html).not.toContain('class="pill raw"');
  });
});
