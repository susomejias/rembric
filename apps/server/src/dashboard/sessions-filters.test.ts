import { randomBytes } from 'node:crypto';

import { Hono, type Context, type Next } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { agentSessions, type NewAgentSession } from '../db/schema/agent-sessions.js';
import { projects } from '../db/schema/projects.js';
import { tokens } from '../db/schema/tokens.js';
import { AgentSessionsService } from '../services/agent-sessions.js';
import { SessionsService } from '../services/sessions.js';
import { TokensService } from '../services/tokens.js';
import { createTestDb, type TestDb } from '../test/db.js';

import { PAGE_SIZE } from './components.js';
import { createSessionsRouter } from './sessions.js';
import type { ResolvedSession } from './types.js';

function row(overrides: Partial<NewAgentSession> & { id: string }): NewAgentSession {
  return {
    tokenId: 'tk1',
    agent: 'claude-code',
    startedAt: new Date(1_000),
    ...overrides,
  };
}

describe('sessions filter bar', () => {
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
      .insert(projects)
      .values([{ id: 'p1', slug: 'proj-one', createdAt: new Date(500) }])
      .run();
    t.handle.db
      .insert(tokens)
      .values([{ id: 'tk1', name: 'test', hash: 'x', scope: '*', createdAt: new Date(500) }])
      .run();
    t.handle.db
      .insert(agentSessions)
      .values([
        row({ id: 'S1', agent: 'claude-code', status: 'active', startedAt: new Date(1_000) }),
        row({ id: 'S2', agent: 'opencode', status: 'ended', startedAt: new Date(2_000) }),
        row({
          id: 'S3',
          agent: 'claude-code',
          status: 'ended',
          projectId: 'p1',
          startedAt: new Date(3_000),
        }),
        row({ id: 'S4', agent: 'claude-code', status: 'ended', startedAt: new Date(4_000) }),
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

  it('combined agent + status filter narrows rows, total, and shows a labelled filter bar', async () => {
    const html = await (await app.request('/?agent=claude-code&status=ended')).text();
    expect(html).toContain('<b>TOTAL</b> 2');
    expect(html).toContain('data-href="/dashboard/sessions/S3"');
    expect(html).toContain('data-href="/dashboard/sessions/S4"');
    expect(html).not.toContain('data-href="/dashboard/sessions/S1"');
    expect(html).not.toContain('data-href="/dashboard/sessions/S2"');
    // Accessible label association per filter control.
    expect(html).toContain('<label class="k" for="f-agent">AGENT</label>');
    expect(html).toContain('<label class="k" for="f-status">STATUS</label>');
    expect(html).toContain('<label class="k" for="f-project">SCOPE</label>');
  });

  it('project scope filter narrows to that project only', async () => {
    const html = await (await app.request('/?project=proj-one')).text();
    expect(html).toContain('<b>TOTAL</b> 1');
    expect(html).toContain('data-href="/dashboard/sessions/S3"');
  });

  it('global-only scope filter excludes project-scoped rows', async () => {
    const html = await (await app.request('/?project=__global__')).text();
    expect(html).toContain('<b>TOTAL</b> 3');
    expect(html).not.toContain('data-href="/dashboard/sessions/S3"');
  });

  it('unfiltered list reports the true total across all non-deleted rows', async () => {
    const html = await (await app.request('/')).text();
    expect(html).toContain('<b>TOTAL</b> 4');
  });

  it('the pager preserves active filter query params across pages', async () => {
    // Seed past PAGE_SIZE more claude-code/ended rows so a NEXT link renders.
    const extra: NewAgentSession[] = Array.from({ length: PAGE_SIZE }, (_, i) =>
      row({ id: `X${i}`, agent: 'claude-code', status: 'ended', startedAt: new Date(5_000 + i) }),
    );
    t.handle.db.insert(agentSessions).values(extra).run();

    const html = await (await app.request('/?agent=claude-code&status=ended')).text();
    expect(html).toMatch(/href="\/\?agent=claude-code&(?:amp;)?status=ended&(?:amp;)?page=1"/);
  });
});
