import { randomBytes } from 'node:crypto';

import { Hono, type Context, type Next } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { agentSessions } from '../db/schema/agent-sessions.js';
import { tokens } from '../db/schema/tokens.js';
import { MemoryService } from '../services/memory.js';
import { RelationsService } from '../services/relations.js';
import { SCOPE_GLOBAL } from '../services/scope.js';
import { SessionsService } from '../services/sessions.js';
import { TokensService } from '../services/tokens.js';
import { createTestDb, type TestDb } from '../test/db.js';

import { createMemoriesRouter } from './memories.js';
import type { ResolvedSession } from './types.js';

function extractCsrf(html: string, action: string): string {
  const formRe = new RegExp(
    `<form[^>]*action="${action.replace(/[/.]/g, (m) => '\\' + m)}"[\\s\\S]*?</form>`,
  );
  const m = formRe.exec(html);
  if (!m) throw new Error(`form for action ${action} not found`);
  const c = /<input[^>]*name="csrf"[^>]*value="([^"]+)"/.exec(m[0]);
  if (!c?.[1]) throw new Error(`csrf input not found in form ${action}`);
  return c[1];
}

describe('memory detail hub', () => {
  let t: TestDb;
  let repos: Repositories;
  let memorySvc: MemoryService;
  let relationsSvc: RelationsService;
  let sessions: SessionsService;
  let app: Hono;

  beforeEach(() => {
    t = createTestDb();
    repos = createRepositories(t.handle.db);
    memorySvc = new MemoryService(repos, t.handle.db);
    relationsSvc = new RelationsService(repos, t.handle.db);
    sessions = new SessionsService(repos, randomBytes(32));
    const tokensSvc = new TokensService(repos);
    const admin = tokensSvc.create({ name: 'admin', scope: '*', projectId: null });
    const created = sessions.create(admin.token.id);
    const session: ResolvedSession = {
      session: created.session,
      sessions,
      tokenId: admin.token.id,
    };

    app = new Hono();
    app.use('*', (c: Context, next: Next) => {
      c.set('session' as never, session as never);
      return next();
    });
    app.route('/', createMemoriesRouter({ repos, memory: memorySvc, sessions }));
  });

  afterEach(() => t.cleanup());

  it('renders the source when present, and "—" when absent', async () => {
    const withSource = memorySvc.save(
      {
        type: 'feedback',
        title: 'with-source-marker',
        content: 'with-source-marker',
        source: { agent: 'claude-code', tokenName: 'laptop-token' },
      },
      SCOPE_GLOBAL,
    );
    const withoutSource = memorySvc.save(
      { type: 'feedback', title: 'no-source-marker', content: 'no-source-marker' },
      SCOPE_GLOBAL,
    );

    const withHtml = await (await app.request(`/${withSource.id}`)).text();
    expect(withHtml).toContain('agent: claude-code');
    expect(withHtml).toContain('token: laptop-token');

    const withoutHtml = await (await app.request(`/${withoutSource.id}`)).text();
    // The Source kv cell renders the em-dash placeholder.
    expect(withoutHtml).toMatch(/Source[\s\S]{0,200}—/);
  });

  it('renders a session_id link to the session detail when present', async () => {
    t.handle.db
      .insert(tokens)
      .values({ id: 'tk1', name: 'tok', hash: 'h', scope: '*', createdAt: new Date(500) })
      .run();
    t.handle.db
      .insert(agentSessions)
      .values({ id: 'SESSAAA', tokenId: 'tk1', agent: 'claude-code', startedAt: new Date(500) })
      .run();
    const withSession = memorySvc.save(
      {
        type: 'feedback',
        title: 'has-session-marker',
        content: 'has-session-marker',
        sessionId: 'SESSAAA',
      },
      SCOPE_GLOBAL,
    );
    const html = await (await app.request(`/${withSession.id}`)).text();
    expect(html).toContain('href="/dashboard/sessions/SESSAAA"');
  });

  it('renders replaces ids as links to their memory detail pages', async () => {
    const b = memorySvc.save(
      { type: 'feedback', title: 'replaces-b', content: 'replaces-b', topicKey: 'topic-x' },
      SCOPE_GLOBAL,
    );
    const c2 = memorySvc.save(
      { type: 'feedback', title: 'replaces-b-v2', content: 'replaces-b-v2', topicKey: 'topic-x' },
      SCOPE_GLOBAL,
    );
    expect(c2.replaces).toContain(b.id);

    const html = await (await app.request(`/${c2.id}`)).text();
    expect(html).toContain(`href="/dashboard/memories/${b.id}"`);
  });

  it('Judgments section lists relations touching the memory, title-linked, with judgment links; empty state otherwise', async () => {
    const source = memorySvc.save(
      { type: 'feedback', title: 'judg-source-marker', content: 'judg-source-marker' },
      SCOPE_GLOBAL,
    );
    const target = memorySvc.save(
      { type: 'feedback', title: 'judg-target-marker', content: 'judg-target-marker' },
      SCOPE_GLOBAL,
    );

    const emptyHtml = await (await app.request(`/${source.id}`)).text();
    expect(emptyHtml).toContain('No judgments touch this memory.');

    const rel = relationsSvc.compare({
      sourceId: source.id,
      targetId: target.id,
      relation: 'related',
      actor: 'e2e-test',
      kind: 'agent',
      confidence: 0.8,
      reason: 'detail hub test',
    });

    const sourceHtml = await (await app.request(`/${source.id}`)).text();
    expect(sourceHtml).toContain('judg-target-marker');
    expect(sourceHtml).toContain(`href="/dashboard/memories/${target.id}"`);
    expect(sourceHtml).toContain(`data-href="/dashboard/judgments/${rel.id}"`);
    expect(sourceHtml).toContain(`href="/dashboard/judgments/${rel.id}"`);

    const targetHtml = await (await app.request(`/${target.id}`)).text();
    expect(targetHtml).toContain('judg-source-marker');
    expect(targetHtml).toContain(`href="/dashboard/memories/${source.id}"`);
  });

  it('confirm rejects without CSRF (403) and succeeds with CSRF, refreshing review + confirm count on reload', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const staleSvc = new MemoryService(repos, t.handle.db, () => new Date(Date.now() - 120 * DAY));
    const m = staleSvc.save(
      { type: 'project', title: 'confirm-flow-marker', content: 'confirm-flow-marker' },
      SCOPE_GLOBAL,
    );

    const noCsrf = await app.request(`/${m.id}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({}).toString(),
    });
    expect(noCsrf.status).toBe(403);

    const before = await (await app.request(`/${m.id}`)).text();
    expect(before).toContain('pill needs_review');
    expect(before).toContain('NEEDS REVIEW');
    const csrf = extractCsrf(before, `/dashboard/memories/${m.id}/confirm`);

    const confirmed = await app.request(`/${m.id}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf }).toString(),
    });
    expect(confirmed.status).toBe(302);
    expect(confirmed.headers.get('location')).toBe(`/dashboard/memories/${m.id}?confirmed=1`);

    // The redirect Location is the absolute dashboard path; this test
    // mounts the router at `/`, so re-request the equivalent relative path.
    const after = await (await app.request(`/${m.id}?confirmed=1`)).text();
    expect(after).toContain('CONFIRMED');
    expect(after).not.toContain('pill needs_review');
    expect(after).toMatch(/Confirms[\s\S]{0,80}>1</);
  });
});
