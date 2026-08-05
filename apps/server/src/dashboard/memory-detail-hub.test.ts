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
import { extractCsrf } from '../test/forms.js';

import { createMemoriesRouter } from './memories.js';
import type { ResolvedSession } from './types.js';

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
    const tokensSvc = new TokensService(repos, t.handle.db);
    const admin = tokensSvc.create({ name: 'admin', scope: '*' });
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

  it('a superseded memory links forward to its successor; an active one shows no such link', async () => {
    const b = memorySvc.save(
      { type: 'feedback', title: 'succ-b', content: 'succ-b', topicKey: 'topic-succ' },
      SCOPE_GLOBAL,
    );
    const c2 = memorySvc.save(
      { type: 'feedback', title: 'succ-b-v2', content: 'succ-b-v2', topicKey: 'topic-succ' },
      SCOPE_GLOBAL,
    );

    const supersededHtml = await (await app.request(`/${b.id}`)).text();
    expect(supersededHtml).toContain('Superseded by');
    expect(supersededHtml).toContain(`href="/dashboard/memories/${c2.id}"`);

    const activeHtml = await (await app.request(`/${c2.id}`)).text();
    expect(activeHtml).not.toContain('Superseded by');
  });

  it('shows last_seen_at in the metadata block regardless of status', async () => {
    const row = memorySvc.save(
      { type: 'feedback', title: 'last-seen-marker', content: 'last-seen-marker' },
      SCOPE_GLOBAL,
    );
    const html = await (await app.request(`/${row.id}`)).text();
    expect(html).toMatch(/Last seen[\s\S]{0,200}data-rembric-ts/);
  });

  it('Predecessors table shows content snapshots ordered chronologically', async () => {
    const a = memorySvc.save(
      {
        type: 'feedback',
        title: 'predecessor-a',
        content: 'predecessor-a-content',
        topicKey: 'topic-y',
      },
      SCOPE_GLOBAL,
    );
    const b = memorySvc.save(
      {
        type: 'feedback',
        title: 'predecessor-b',
        content: 'predecessor-b-content',
        topicKey: 'topic-y',
      },
      SCOPE_GLOBAL,
    );
    const head = memorySvc.save(
      { type: 'feedback', title: 'predecessor-head', content: 'predecessor-head-content' },
      SCOPE_GLOBAL,
    );
    // `replaces` order reversed from chronological, to prove the view sorts by createdAt.
    t.handle.raw.prepare('UPDATE memory SET created_at = ? WHERE id = ?').run(1_000, a.id);
    t.handle.raw.prepare('UPDATE memory SET created_at = ? WHERE id = ?').run(2_000, b.id);
    t.handle.raw
      .prepare('UPDATE memory SET replaces = ? WHERE id = ?')
      .run(JSON.stringify([b.id, a.id]), head.id);

    const html = await (await app.request(`/${head.id}`)).text();
    expect(html).toContain('predecessor-a-content');
    expect(html).toContain('predecessor-b-content');
    expect(html.indexOf('predecessor-a-content')).toBeLessThan(
      html.indexOf('predecessor-b-content'),
    );
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

  describe('Judgments section ordering and degree', () => {
    const mem = (title: string) =>
      memorySvc.save({ type: 'feedback', title, content: title }, SCOPE_GLOBAL);

    /** Judgment-row ids in the order the section rendered them. */
    function renderedOrder(html: string): string[] {
      const out: string[] = [];
      const re = /data-href="\/dashboard\/judgments\/([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null) out.push(m[1]!);
      return out;
    }

    const setCreatedAt = (relationId: string, ms: number) =>
      t.handle.raw
        .prepare('UPDATE memory_relations SET created_at = ? WHERE id = ?')
        .run(ms, relationId);

    it('a conflicts_with created before twelve related rows still leads, and all thirteen render', async () => {
      const hub = mem('order-hub');
      const conflict = relationsSvc.compare({
        sourceId: hub.id,
        targetId: mem('order-conflict-target').id,
        relation: 'conflicts_with',
        actor: 'test',
        kind: 'agent',
        confidence: 0.9,
      });
      setCreatedAt(conflict.id, 1_000);
      const relatedIds: string[] = [];
      for (let i = 0; i < 12; i++) {
        const rel = relationsSvc.compare({
          sourceId: hub.id,
          targetId: mem(`order-related-${i}`).id,
          relation: 'related',
          actor: 'test',
          kind: 'agent',
          confidence: 0.5,
        });
        setCreatedAt(rel.id, 100_000 + i);
        relatedIds.push(rel.id);
      }

      const order = renderedOrder(await (await app.request(`/${hub.id}`)).text());
      expect(order).toHaveLength(13);
      expect(order[0]).toBe(conflict.id);
      for (const id of relatedIds) expect(order.indexOf(id)).toBeGreaterThan(0);
    });

    it('an orphaned row is tiered as unjudged, not demoted to related', async () => {
      // `adminListTouching` does not hide orphaned rows the way `listTouchingAny`
      // does, so the dashboard is the only surface that ranks them. They must sit
      // with the pendings — an orphaned candidate is unresolved, not informational.
      const hub = mem('orphan-hub');
      const orphanPending = relationsSvc.createPending({
        sourceId: hub.id,
        targetId: mem('orphan-target').id,
      });
      relationsSvc.orphan(orphanPending.judgmentId, 'deadline reached');
      setCreatedAt(orphanPending.id, 1_000);
      const related = relationsSvc.compare({
        sourceId: hub.id,
        targetId: mem('orphan-related-target').id,
        relation: 'related',
        actor: 'test',
        kind: 'agent',
        confidence: 0.5,
      });
      setCreatedAt(related.id, 900_000);

      // Orphan is far OLDER, so only its tier can put it ahead of the `related`.
      const html = await (await app.request(`/${hub.id}`)).text();
      expect(renderedOrder(html)).toEqual([orphanPending.id, related.id]);
      // And the kind column shows what it was sorted by. A raw `relation` here is
      // NULL, which rendered an empty pill on a row leading the table.
      expect(html).toContain('pending_conflict');
    });

    it('the kind column shows this memory POV, not the raw relation', async () => {
      const predecessor = mem('pov-predecessor');
      const successor = mem('pov-successor');
      relationsSvc.compare({
        sourceId: successor.id,
        targetId: predecessor.id,
        relation: 'supersedes',
        actor: 'test',
        kind: 'agent',
        confidence: 0.9,
      });

      const fromSuccessor = await (await app.request(`/${successor.id}`)).text();
      expect(fromSuccessor).toContain('supersedes');
      expect(fromSuccessor).not.toContain('superseded_by');

      // Same row, other end: it is what superseded THIS memory.
      const fromPredecessor = await (await app.request(`/${predecessor.id}`)).text();
      expect(fromPredecessor).toContain('superseded_by');
    });

    it('twenty pending rows do not displace one judged supersedes', async () => {
      const hub = mem('pending-hub');
      const pendingIds: string[] = [];
      for (let i = 0; i < 20; i++) {
        const p = relationsSvc.createPending({
          sourceId: hub.id,
          targetId: mem(`pending-target-${i}`).id,
        });
        setCreatedAt(p.id, 500_000 + i);
        pendingIds.push(p.id);
      }
      const judged = relationsSvc.compare({
        sourceId: hub.id,
        targetId: mem('supersedes-target').id,
        relation: 'supersedes',
        actor: 'test',
        kind: 'agent',
        confidence: 0.95,
      });
      setCreatedAt(judged.id, 1_000);

      const order = renderedOrder(await (await app.request(`/${hub.id}`)).text());
      expect(order).toHaveLength(21);
      expect(order[0]).toBe(judged.id);
      expect(Math.min(...pendingIds.map((id) => order.indexOf(id)))).toBe(1);
    });

    it('a same-millisecond batch renders in the same order twice, broken by judgment_id', async () => {
      const hub = mem('tie-hub');
      const ids: string[] = [];
      for (let i = 0; i < 8; i++) {
        const rel = relationsSvc.compare({
          sourceId: hub.id,
          targetId: mem(`tie-target-${i}`).id,
          relation: 'related',
          actor: 'test',
          kind: 'agent',
          confidence: 0.5,
        });
        setCreatedAt(rel.id, 777_000);
        ids.push(rel.id);
      }
      // judgment_id descends as the rows were inserted, so the comparator's
      // third key must reverse the scan order rather than agree with it.
      ids.forEach((id, i) =>
        t.handle.raw
          .prepare('UPDATE memory_relations SET judgment_id = ? WHERE id = ?')
          .run(`tie-J${7 - i}`, id),
      );

      const first = renderedOrder(await (await app.request(`/${hub.id}`)).text());
      const second = renderedOrder(await (await app.request(`/${hub.id}`)).text());
      expect(first).toHaveLength(8);
      expect(first).toEqual([...ids].reverse());
      expect(second).toEqual(first);
    });

    it('the heading reports the degree, and 0 on the empty state', async () => {
      const hub = mem('degree-hub');
      const empty = await (await app.request(`/${hub.id}`)).text();
      expect(empty).toContain('Judgments (0)');
      expect(empty).toContain('No judgments touch this memory.');

      for (let i = 0; i < 7; i++) {
        relationsSvc.compare({
          sourceId: hub.id,
          targetId: mem(`degree-target-${i}`).id,
          relation: 'related',
          actor: 'test',
          kind: 'agent',
          confidence: 0.5,
        });
      }
      const html = await (await app.request(`/${hub.id}`)).text();
      expect(renderedOrder(html)).toHaveLength(7);
      expect(html).toContain('Judgments (7)');
    });
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
