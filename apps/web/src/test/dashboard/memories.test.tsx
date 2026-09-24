import { deriveTitle, MemoryService, RelationsService } from '@rembric/core';
import { createRepositories, memory, type NewMemory, type Repositories } from '@rembric/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../db';
import { defaultProjectScope, seedProject } from '../default-project';

import {
  after,
  buildDashboardServices,
  installViewMocks,
  judgmentLinkOrder,
  renderToHtml,
  servicesRef,
} from './harness';

installViewMocks('/dashboard/memories');

// The page loads one bounded window (LIST_LIMIT) while the header reports the
// true filtered total, so the fixture overflows the window on purpose.
const LIST_LIMIT = 500;
const OVERFLOW = LIST_LIMIT + 2;
const SEEDED = 52;

function widget(id: string, overrides: Partial<NewMemory> = {}): NewMemory {
  const content = `widget number ${id}`;
  return {
    id,
    title: deriveTitle(content),
    content,
    scope: 'project',
    projectId: 'p0',
    type: 'project',
    tags: [],
    status: 'active',
    replaces: [],
    createdAt: new Date(1_000),
    lastSeenAt: new Date(1_000),
    ...overrides,
  };
}

let t: TestDb;
let repos: Repositories;
let services: ReturnType<typeof buildDashboardServices> & { memory: MemoryService };

beforeEach(() => {
  t = createTestDb();
  seedProject(t.handle, 'p0', 'project-zero');
  repos = createRepositories(t.handle.db);
  services = {
    ...buildDashboardServices(t.handle),
    memory: new MemoryService(repos, t.handle.db),
  };
  servicesRef.current = services;
});

afterEach(() => t.cleanup());

async function renderMemories(params: Record<string, string> = {}): Promise<string> {
  const page = (await import('../../app/dashboard/memories/page')).default;
  return renderToHtml(await page({ searchParams: Promise.resolve(params) }));
}

async function renderMemoryDetail(id: string): Promise<string> {
  const page = (await import('../../app/dashboard/memories/[id]/page')).default;
  return renderToHtml(
    await page({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }),
  );
}

describe('memories list header and bounded window', () => {
  beforeEach(() => {
    t.handle.db
      .insert(memory)
      .values(Array.from({ length: OVERFLOW }, (_, i) => widget(`G${i}`)))
      .run();
  });

  it(`reports the true total (${OVERFLOW}) while loading a single ${LIST_LIMIT}-row window`, async () => {
    const html = await renderMemories();
    expect(html).toContain(`${OVERFLOW} total · ${OVERFLOW} active · ${OVERFLOW} need review`);
    // The client pager counts the bounded window, never the true total.
    expect(html).toContain(`1–10 of ${LIST_LIMIT}`);
    expect(html).not.toContain(`1–10 of ${OVERFLOW}`);
    expect(html).toContain('Pagination');
  });

  it('renders the needs-review count and the review pill for ancient rows', async () => {
    const html = await renderMemories();
    expect(html).toContain(`${OVERFLOW} need review`);
    expect(html).toContain('>needs review<');
  });
});

describe('memories list (client data-table)', () => {
  it('renders the toolbar, selection checkboxes, row labels, pills and menu trigger', async () => {
    t.handle.db
      .insert(memory)
      .values([
        widget('A1', { title: 'alpha memory', content: 'alpha memory' }),
        widget('A2', {
          title: 'beta memory',
          content: 'beta memory',
          status: 'archived',
          createdAt: new Date(),
          lastSeenAt: new Date(),
        }),
      ])
      .run();

    const active = await renderMemories();
    expect(active).toContain('Filter by status');
    expect(active).toContain('Search memories…');
    expect(active).toContain('Select all rows on this page');
    expect(active).toContain('Select project memory — alpha memory"');
    expect(active).toContain('Actions for memory alpha memory');
    expect(active).toContain('>active<');
    // The default status filter still hides non-active rows.
    expect(active).not.toContain('beta memory');

    const archived = await renderMemories({ status: 'archived' });
    expect(archived).toContain('Select project memory — beta memory"');
    expect(archived).toContain('>archived<');
  });
});

describe('memories list filters', () => {
  it('an FTS query honours the default active status filter, not the raw match count', async () => {
    t.handle.db
      .insert(memory)
      .values([
        widget('WACT', { title: 'active-widget-marker', content: 'active-widget-marker' }),
        widget('WSUP', {
          title: 'superseded-widget-marker',
          content: 'superseded-widget-marker',
          status: 'superseded',
        }),
        widget('WARC', {
          title: 'archived-widget-marker',
          content: 'archived-widget-marker',
          status: 'archived',
        }),
      ])
      .run();

    const html = await renderMemories({ q: 'widget' });
    expect(html).toContain('active-widget-marker');
    expect(html).not.toContain('superseded-widget-marker');
    expect(html).not.toContain('archived-widget-marker');
  });

  it('needs_review combined with a query keeps only rows past their review TTL', async () => {
    t.handle.db
      .insert(memory)
      .values([
        widget('ANCIENT', { title: 'ancient-widget-marker', content: 'ancient-widget-marker' }),
        widget('FRESH', {
          title: 'fresh-widget-marker',
          content: 'fresh-widget-marker',
          createdAt: new Date(),
          lastSeenAt: new Date(),
        }),
      ])
      .run();

    const html = await renderMemories({ review: 'needs_review', q: 'widget' });
    expect(html).toContain('ancient-widget-marker');
    expect(html).not.toContain('fresh-widget-marker');
  });

  it('an unresolvable project slug yields an empty list, not every scope', async () => {
    t.handle.db
      .insert(memory)
      .values([widget('KEEP'), widget('DROP')])
      .run();

    const html = await renderMemories({ project: 'no-such-slug' });
    expect(html).toContain('NO MEMORY MATCHES THIS FILTER');
    expect(html).not.toContain('widget number');
  });
});

describe('memories search robustness (#258)', () => {
  it('redisplays the operator query verbatim and does not 500 on punctuation', async () => {
    services.memory.save(
      { type: 'project', title: 'deploy plan', content: 'deploy via docker-compose' },
      defaultProjectScope(t.handle),
    );

    const punctuation = await renderMemories({ q: 'docker-compose?' });
    expect(punctuation).toContain('value="docker-compose?"');

    const match = await renderMemories({ q: 'deploy plan' });
    expect(match).toContain('deploy plan');
  });
});

describe('memory detail hub', () => {
  it('renders the source agent when present, and the em-dash placeholder when absent', async () => {
    const withSource = services.memory.save(
      {
        type: 'feedback',
        title: 'with-source-marker',
        content: 'with-source-marker',
        source: { agent: 'claude-code', tokenName: 'laptop-token' },
      },
      defaultProjectScope(t.handle),
    );
    const withoutSource = services.memory.save(
      { type: 'feedback', title: 'no-source-marker', content: 'no-source-marker' },
      defaultProjectScope(t.handle),
    );

    expect(after(await renderMemoryDetail(withSource.id), 'Source', 200)).toContain('claude-code');
    expect(after(await renderMemoryDetail(withoutSource.id), 'Source', 200)).toContain('—');
  });

  it('shows last_seen_at in the metadata block', async () => {
    const row = services.memory.save(
      { type: 'feedback', title: 'last-seen-marker', content: 'last-seen-marker' },
      defaultProjectScope(t.handle),
    );
    const html = await renderMemoryDetail(row.id);
    expect(html).toMatch(/Last seen[\s\S]{0,200}data-rembric-ts/);
  });

  it('renders replaces ids as links to their memory detail pages', async () => {
    const b = services.memory.save(
      { type: 'feedback', title: 'replaces-b', content: 'replaces-b', topicKey: 'topic-x' },
      defaultProjectScope(t.handle),
    );
    const successor = services.memory.save(
      { type: 'feedback', title: 'replaces-b-v2', content: 'replaces-b-v2', topicKey: 'topic-x' },
      defaultProjectScope(t.handle),
    );
    expect(successor.replaces).toContain(b.id);

    const html = await renderMemoryDetail(successor.id);
    expect(html).toContain(`href="/dashboard/memories/${b.id}"`);
  });

  it('a superseded memory links forward to its successor; an active one shows no such link', async () => {
    const predecessor = services.memory.save(
      { type: 'feedback', title: 'succ-b', content: 'succ-b', topicKey: 'topic-succ' },
      defaultProjectScope(t.handle),
    );
    const successor = services.memory.save(
      { type: 'feedback', title: 'succ-b-v2', content: 'succ-b-v2', topicKey: 'topic-succ' },
      defaultProjectScope(t.handle),
    );

    const supersededHtml = await renderMemoryDetail(predecessor.id);
    expect(supersededHtml).toContain('Superseded by');
    expect(supersededHtml).toContain(`href="/dashboard/memories/${successor.id}"`);

    const activeHtml = await renderMemoryDetail(successor.id);
    expect(activeHtml).not.toContain('Superseded by');
  });

  it('orders the predecessors table chronologically regardless of replaces order', async () => {
    const a = services.memory.save(
      {
        type: 'feedback',
        title: 'predecessor-a',
        content: 'predecessor-a-content',
        topicKey: 'topic-y',
      },
      defaultProjectScope(t.handle),
    );
    const b = services.memory.save(
      {
        type: 'feedback',
        title: 'predecessor-b',
        content: 'predecessor-b-content',
        topicKey: 'topic-y',
      },
      defaultProjectScope(t.handle),
    );
    const head = services.memory.save(
      { type: 'feedback', title: 'predecessor-head', content: 'predecessor-head-content' },
      defaultProjectScope(t.handle),
    );
    t.handle.raw.prepare('UPDATE memory SET created_at = ? WHERE id = ?').run(1_000, a.id);
    t.handle.raw.prepare('UPDATE memory SET created_at = ? WHERE id = ?').run(2_000, b.id);
    t.handle.raw
      .prepare('UPDATE memory SET replaces = ? WHERE id = ?')
      .run(JSON.stringify([b.id, a.id]), head.id);

    const html = await renderMemoryDetail(head.id);
    expect(html.indexOf('predecessor-a-content')).toBeLessThan(
      html.indexOf('predecessor-b-content'),
    );
  });

  it('renders the judgments section with POV kind, degree and empty state', async () => {
    const relations = new RelationsService(repos, t.handle.db);
    const hub = services.memory.save(
      { type: 'feedback', title: 'degree-hub', content: 'degree-hub' },
      defaultProjectScope(t.handle),
    );
    const target = services.memory.save(
      { type: 'feedback', title: 'judg-target-marker', content: 'judg-target-marker' },
      defaultProjectScope(t.handle),
    );

    const empty = await renderMemoryDetail(hub.id);
    expect(empty).toContain('JUDGMENTS (0)');
    expect(empty).toContain('NO JUDGMENTS TOUCH THIS MEMORY');

    const relation = relations.compare({
      sourceId: hub.id,
      targetId: target.id,
      relation: 'supersedes',
      actor: 'test',
      kind: 'agent',
      confidence: 0.9,
    });

    const html = await renderMemoryDetail(hub.id);
    expect(html).toContain('JUDGMENTS (1)');
    expect(judgmentLinkOrder(html)).toContain(relation.id);
    expect(html).toContain(`href="/dashboard/memories/${target.id}"`);
    expect(html).toContain('supersedes');

    const fromTarget = await renderMemoryDetail(target.id);
    expect(fromTarget).toContain('superseded_by');
  });

  it('a stale row renders the NEEDS REVIEW flash and pill', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const stale = new MemoryService(repos, t.handle.db, () => new Date(Date.now() - 120 * DAY));
    const row = stale.save(
      { type: 'project', title: 'confirm-flow-marker', content: 'confirm-flow-marker' },
      defaultProjectScope(t.handle),
    );

    const html = await renderMemoryDetail(row.id);
    expect(html).toContain('NEEDS REVIEW');
    expect(html).toContain('>needs review<');
    expect(html).not.toContain('>CONFIRMED<');
  });
});

describe('dashboard shell badge counters', () => {
  it('renders request-wide judgment and needs-review badges with per-project tooltips', async () => {
    t.handle.db
      .insert(memory)
      .values([widget('BADGE-SRC'), widget('BADGE-TGT')])
      .run();
    new RelationsService(repos, t.handle.db).createPending({
      sourceId: 'BADGE-SRC',
      targetId: 'BADGE-TGT',
    });
    t.handle.db
      .insert(memory)
      .values(Array.from({ length: SEEDED }, (_, i) => widget(`B${i}`)))
      .run();

    const DashboardLayout = (await import('../../app/dashboard/layout')).default;
    const html = await renderToHtml(DashboardLayout({ children: null }));

    expect(html).toContain(
      'pending judgment candidate across all projects — resolve with memory.judge',
    );
    expect(html).toContain('project-zero: 1');
    expect(html).toContain(
      'active memories past their review TTL across all projects — re-affirm with memory.confirm',
    );
    expect(html).toContain(`project-zero: ${SEEDED + 2}`);
  });
});
