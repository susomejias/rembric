import { randomBytes } from 'node:crypto';

import { Hono, type Context, type Next } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { AgentSessionsService } from '../services/agent-sessions.js';
import { SessionsService } from '../services/sessions.js';
import { TokensService } from '../services/tokens.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { createSessionsRouter } from './sessions.js';
import type { ResolvedSession } from './types.js';

describe('session detail SUMMARY HISTORY section', () => {
  let t: TestDb;
  let app: Hono;
  let agentSessionsSvc: AgentSessionsService;
  let ownerTokenId: string;

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

    agentSessionsSvc = new AgentSessionsService(repos, t.handle.db);
    const owner = tokensSvc.create({ name: 'owner', scope: '*' });
    ownerTokenId = owner.token.id;

    app = new Hono();
    app.use('*', (c: Context, next: Next) => {
      c.set('session' as never, session as never);
      return next();
    });
    app.route('/', createSessionsRouter({ repos, sessions, agentSessions: agentSessionsSvc }));
  });

  afterEach(() => t.cleanup());

  it('a session with three curated writes shows three versions, newest first, matching the Summary block', async () => {
    const s = agentSessionsSvc.start({ tokenId: ownerTokenId, projectId: null, agent: 'claude' });
    agentSessionsSvc.writeSummary(s.id, { tokenId: ownerTokenId, summary: 'v1 text', final: true });
    agentSessionsSvc.writeSummary(s.id, { tokenId: ownerTokenId, summary: 'v2 text', final: true });
    agentSessionsSvc.writeSummary(s.id, { tokenId: ownerTokenId, summary: 'v3 text', final: true });

    const res = await app.request(`/${s.id}`);
    const html = await res.text();

    const idx3 = html.indexOf('v3 text');
    const idx2 = html.indexOf('v2 text');
    const idx1 = html.indexOf('v1 text');
    expect(idx3).toBeGreaterThan(-1);
    expect(idx2).toBeGreaterThan(idx3);
    expect(idx1).toBeGreaterThan(idx2);

    expect(html).toMatch(/<summary>\s*v3 ·/);
    expect(html).toMatch(/<summary>\s*v2 ·/);
    expect(html).toMatch(/<summary>\s*v1 ·/);
    expect(html).toContain('Summary History (3)');

    // The newest version's content equals the Summary block rendered above it.
    const summaryBlockIdx = html.indexOf('<h2>Summary<');
    const historyIdx = html.indexOf('Summary History');
    const summaryBlock = html.slice(summaryBlockIdx, historyIdx);
    expect(summaryBlock).toContain('v3 text');
  });

  it('a session with no versions states so, and the section is present unconditionally', async () => {
    const s = agentSessionsSvc.start({ tokenId: ownerTokenId, projectId: null, agent: 'claude' });

    const res = await app.request(`/${s.id}`);
    const html = await res.text();

    expect(html).toContain('Summary History (0)');
    expect(html).toContain('No summary versions recorded.');
  });

  it('exposes no form or mutation targeting a version row', async () => {
    const s = agentSessionsSvc.start({ tokenId: ownerTokenId, projectId: null, agent: 'claude' });
    agentSessionsSvc.writeSummary(s.id, {
      tokenId: ownerTokenId,
      summary: 'only version',
      final: true,
    });

    const res = await app.request(`/${s.id}`);
    const html = await res.text();

    expect(html).not.toMatch(/<form[^>]*summary-history/i);
    expect(html).not.toMatch(/<form[^>]*\/version/i);
  });

  it('renders version timestamps through the shared formatTs helper, never hand-formatted', async () => {
    const s = agentSessionsSvc.start({ tokenId: ownerTokenId, projectId: null, agent: 'claude' });
    agentSessionsSvc.writeSummary(s.id, {
      tokenId: ownerTokenId,
      summary: 'timestamped',
      final: true,
    });

    const res = await app.request(`/${s.id}`);
    const html = await res.text();

    const historyIdx = html.indexOf('rbr-summary-version');
    const versionBlock = html.slice(historyIdx, historyIdx + 400);
    expect(versionBlock).toContain('data-rembric-ts');
  });
});
