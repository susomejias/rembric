import { deriveTitle, RelationsService } from '@rembric/core';
import { createRepositories, memory, memoryRelations, type NewMemory } from '@rembric/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../db';
import { seedProject } from '../default-project';

import { buildDashboardServices, installViewMocks, renderToHtml, servicesRef } from './harness';

installViewMocks('/dashboard/judgments');

const PAGE_SIZE = 50;
const SEEDED = PAGE_SIZE + 2;

const MALFORMED_EVIDENCE = '{not json <b>raw</b>';

function widget(id: string): NewMemory {
  const content = `widget ${id}`;
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
  };
}

let t: TestDb;

beforeEach(() => {
  t = createTestDb();
  seedProject(t.handle, 'p0', 'project-zero');
  servicesRef.current = buildDashboardServices(t.handle);
  t.handle.db
    .insert(memory)
    .values([widget('RS'), widget('RT')])
    .run();
  t.handle.db
    .insert(memoryRelations)
    .values({
      id: 'REL-MALFORMED',
      judgmentId: 'J-MALFORMED',
      sourceId: 'RS',
      targetId: 'RT',
      relation: null,
      status: 'pending',
      evidence: MALFORMED_EVIDENCE,
      createdAt: new Date(1_000),
    })
    .run();
});

afterEach(() => t.cleanup());

async function renderJudgments(params: Record<string, string> = {}): Promise<string> {
  const page = (await import('../../app/dashboard/judgments/page')).default;
  return renderToHtml(await page({ searchParams: Promise.resolve(params) }));
}

async function renderJudgmentDetail(id: string): Promise<string> {
  const page = (await import('../../app/dashboard/judgments/[id]/page')).default;
  return renderToHtml(await page({ params: Promise.resolve({ id }) }));
}

describe('judgment evidence fallback', () => {
  it('renders a malformed stored evidence value escaped instead of throwing', async () => {
    const html = await renderJudgmentDetail('REL-MALFORMED');
    expect(html).toContain('{not json &lt;b&gt;raw&lt;/b&gt;');
    expect(html).not.toContain('<b>raw</b>');
  });

  it('a structured evidence value is pretty-printed inside the same <pre> boundary', async () => {
    t.handle.raw
      .prepare('UPDATE memory_relations SET evidence = ? WHERE id = ?')
      .run(JSON.stringify({ why: 'structured' }), 'REL-MALFORMED');

    const html = await renderJudgmentDetail('REL-MALFORMED');
    expect(html).toMatch(/<pre[^>]*>[\s\S]*&quot;why&quot;: &quot;structured&quot;[\s\S]*<\/pre>/);
  });
});

describe('judgments list verdict pill and routing', () => {
  it('renders the pending verdict pill and links through the /dashboard/judgments route', async () => {
    const html = await renderJudgments();
    expect(html).toContain('</span>pending</span>');
    expect(html).toContain('href="/dashboard/judgments/REL-MALFORMED"');
    expect(html).not.toContain('/dashboard/relations');
  });

  it('renders a judged verdict pill for a closed relation', async () => {
    const relations = new RelationsService(createRepositories(t.handle.db), t.handle.db);
    relations.compare({
      sourceId: 'RS',
      targetId: 'RT',
      relation: 'supersedes',
      actor: 'test',
      kind: 'agent',
      confidence: 0.9,
    });

    const html = await renderJudgments();
    expect(html).toContain('</span>supersedes</span>');
    expect(html).toContain('</span>judged</span>');
  });

  it(`caps the page slice at PAGE_SIZE for ${SEEDED} seeded relations`, async () => {
    t.handle.db
      .insert(memoryRelations)
      .values(
        Array.from({ length: SEEDED }, (_, i) => ({
          id: `R${i}`,
          judgmentId: `J${i}`,
          sourceId: 'RS',
          targetId: 'RT',
          relation: null,
          status: 'pending' as const,
          createdAt: new Date(1_000),
        })),
      )
      .run();

    const html = await renderJudgments();
    expect(html).toContain(`${PAGE_SIZE} ROWS`);
    expect(html).not.toContain(`${PAGE_SIZE + 1} ROWS`);
    expect(html).not.toContain(`${SEEDED} ROWS`);
  });
});
