import { deriveTitle, RelationsService } from '@rembric/core';
import {
  createRepositories,
  memory,
  memoryRelations,
  RELATION_VALUES,
  type NewMemory,
} from '@rembric/db';
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../db';
import { seedProject } from '../default-project';

import { buildDashboardServices, installViewMocks, renderToHtml, servicesRef } from './harness';

import { DetailCopy } from '@/components/dashboard/detail-copy';
import { MarkdownContent } from '@/components/dashboard/markdown-content';
import { PAGE_SIZE } from '@/components/dashboard/support';
import type { Services } from '@/lib/services';

installViewMocks('/dashboard/judgments');

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

async function renderJudgments(): Promise<string> {
  const page = (await import('../../app/dashboard/judgments/page')).default;
  return renderToHtml(await page());
}

async function renderJudgmentDetail(id: string): Promise<string> {
  const page = (await import('../../app/dashboard/judgments/[id]/page')).default;
  return renderToHtml(await page({ params: Promise.resolve({ id }) }));
}

function relationChipClass(html: string, label: string): string {
  const re = new RegExp(
    `<span class="([^"]*rounded-full border[^"]*)"[^>]*><span aria-hidden="true"[^>]*></span>${label}</span>`,
  );
  const match = re.exec(html);
  if (!match) throw new Error(`no relation chip for ${label}`);
  return match[1]!;
}

function descendants(node: ReactNode): ReactElement<{ children?: ReactNode }>[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<{ children?: ReactNode }>(child)
      ? [child, ...descendants(child.props.children)]
      : [],
  );
}

describe('judgment detail composition', () => {
  it('keeps both independent original copy payloads including whitespace', async () => {
    const source = '  # Source body\n\nKeep source spacing.\n';
    const target = '\n# Target body\n\nKeep target spacing.  ';
    t.handle.raw.prepare('UPDATE memory SET content = ? WHERE id = ?').run(source, 'RS');
    t.handle.raw.prepare('UPDATE memory SET content = ? WHERE id = ?').run(target, 'RT');
    const page = (await import('../../app/dashboard/judgments/[id]/page')).default;
    const element: ReactElement<{ children: ReactNode }> = await page({
      params: Promise.resolve({ id: 'REL-MALFORMED' }),
    });
    const nodes = descendants(element.props.children);
    const copies = nodes.filter((node) => node.type === DetailCopy);
    const bodies = nodes.filter((node) => node.type === MarkdownContent);
    expect(copies).toHaveLength(2);
    expect(bodies).toHaveLength(2);
    for (const [index, copy] of copies.entries()) {
      if (!isValidElement<ComponentProps<typeof DetailCopy>>(copy)) throw new Error('Missing copy');
      const body = bodies[index];
      if (!isValidElement<ComponentProps<typeof MarkdownContent>>(body))
        throw new Error('Missing body');
      expect(copy.props.text).toBe(index === 0 ? source : target);
      expect(copy.props.label).toBe(index === 0 ? 'Copy source' : 'Copy target');
      expect(body.props.markdown).toBe(copy.props.text);
    }
  });

  it('keeps both titled primary panels and posts the opaque judgment identifier, not the route id', async () => {
    const html = await renderJudgmentDetail('REL-MALFORMED');
    expect(html).toContain('detail-layout judgment-detail');
    expect(html).toContain('Back to judgments');
    expect(html).not.toContain('detail-actions-panel');
    expect(html).not.toContain('>Share</button>');
    expect(html).toContain('>Mark orphaned</button>');
    expect(html).toContain('>Compare memories</h1>');
    expect(html).not.toContain('>Judgment REL-MALFORMED</h1>');
    expect(html).not.toContain('class="ficha-rail"');
    expect(html).toContain('aria-label="Verdict"');
    expect(html).toContain('aria-label="Reason"');
    expect(html).toContain('aria-label="Source memory"');
    expect(html).toContain('aria-label="Target memory"');
    expect(html).toContain('min-[900px]:grid-cols-[minmax(0,1fr)_56px_minmax(0,1fr)]');
    for (const title of ['Evidence', 'Properties'])
      expect(html).toMatch(new RegExp(`<details[^>]*aria-label="${title}"`));
    expect(html).not.toMatch(/<details[^>]*\bopen/);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toMatch(/<h2\b[^>]*><a[^>]*>widget RS/);
    expect(html).toMatch(/<h2\b[^>]*><a[^>]*>widget RT/);
    expect(html).toContain('href="/dashboard/memories/RS"');
    expect(html).toContain('href="/dashboard/memories/RT"');
    expect(html).toContain('name="judgmentId" value="J-MALFORMED"');
    expect(html).not.toContain('name="judgmentId" value="REL-MALFORMED"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html.indexOf('Copy source')).toBeLessThan(html.indexOf('Judgment id'));
    expect(html.indexOf('aria-label="Verdict"')).toBeLessThan(
      html.indexOf('aria-label="Source memory"'),
    );
    expect(html.indexOf('Evidence</summary>')).toBeLessThan(
      html.indexOf('aria-label="Source memory"'),
    );
    expect(html.indexOf('Copy target')).toBeLessThan(html.indexOf('Properties</summary>'));
    expect(html).not.toContain('bg-card px-6 py-[18px]');
    expect(html).not.toContain('Reason</summary>');
  });

  it.each(['judged', 'orphaned'] as const)(
    'keeps the %s explanation and no orphan action',
    async (status) => {
      t.handle.raw
        .prepare('UPDATE memory_relations SET status = ?, reason = ? WHERE id = ?')
        .run(status, '<b>plain reason</b>', 'REL-MALFORMED');
      const html = await renderJudgmentDetail('REL-MALFORMED');
      expect(html).toContain('this judgment is closed');
      expect(html).not.toContain('name="judgmentId"');
      expect(html).not.toContain('ficha-actions');
      expect(html).toContain('&lt;b&gt;plain reason&lt;/b&gt;');
      expect(html).not.toContain('<b>plain reason</b>');
    },
  );
});

describe('approved judgment verdicts', () => {
  const labels = {
    supersedes: 'Supersedes',
    conflicts_with: 'Conflicts with',
    related: 'Related',
    compatible: 'Compatible',
    scoped: 'Scoped',
    not_conflict: 'Not a conflict',
  };
  it.each(RELATION_VALUES)(
    'presents %s with its actual direction and without inventing a lifecycle',
    async (relation) => {
      t.handle.raw
        .prepare(
          'UPDATE memory_relations SET relation = ?, status = ?, confidence = ?, reason = ? WHERE id = ?',
        )
        .run(relation, 'judged', 0.91, 'Recorded plain reason', 'REL-MALFORMED');
      const html = await renderJudgmentDetail('REL-MALFORMED');
      expect(html).toContain(`>${labels[relation]}</h2>`);
      const progress = html.match(/<div[^>]*role="progressbar"[^>]*>/)?.[0];
      expect(progress).toContain('aria-label="Confidence"');
      expect(progress).toContain('aria-valuenow="91"');
      expect(html).toContain('style="transform:translateX(-9%)"');
      expect(html).not.toContain('<meter');
      expect(html).toContain('Recorded plain reason');
      expect(html).not.toContain('Mark orphaned');
      expect(html).not.toContain('now outdated');
      expect(html).not.toContain('>Superseded</span>');
      expect(html).not.toContain('project ·');
      expect(html).not.toContain('Judged by agent');
      if (relation === 'supersedes') expect(html).toContain('Source supersedes Target.');
      if (relation === 'scoped') expect(html).toContain('Scoped relationship recorded');
      if (relation === 'not_conflict') expect(html).toContain('judged not to conflict');
    },
  );
  it.each([0, 1])(
    'shows recorded boundary confidence %s rather than hiding it',
    async (confidence) => {
      t.handle.raw
        .prepare('UPDATE memory_relations SET confidence = ? WHERE id = ?')
        .run(confidence, 'REL-MALFORMED');
      const html = await renderJudgmentDetail('REL-MALFORMED');
      const progress = html.match(/<div[^>]*role="progressbar"[^>]*>/)?.[0];
      expect(progress).toContain(`aria-valuenow="${confidence * 100}"`);
      expect(html).toContain(`style="transform:translateX(-${100 - confidence * 100}%)"`);
      expect(html).toContain(`>${confidence.toFixed(2)}</span>`);
    },
  );
  it.each(['pending', 'judged', 'orphaned'] as const)(
    'does not invent verdict, confidence or actor for a null %s row',
    async (status) => {
      t.handle.raw
        .prepare('UPDATE memory_relations SET status = ? WHERE id = ?')
        .run(status, 'REL-MALFORMED');
      const html = await renderJudgmentDetail('REL-MALFORMED');
      expect(html).toContain(
        status === 'pending' ? '>Awaiting verdict</h2>' : '>No verdict recorded</h2>',
      );
      expect(html).not.toContain('<meter');
      expect(html).not.toContain('role="progressbar"');
      expect(html).not.toContain('Marked by agent');
      expect(html).not.toContain('claude-code');
      expect(html).not.toContain('>Compatible</h2>');
      expect(html).toContain('No reason recorded.');
    },
  );
  it('keeps recorded agent, creator kind, time and unsafe content literal', async () => {
    t.handle.raw
      .prepare(
        'UPDATE memory_relations SET marked_by_kind = ?, marked_by_actor = ?, judged_at = ? WHERE id = ?',
      )
      .run('agent_topic_key', '<b>actor</b>', 2000, 'REL-MALFORMED');
    const html = await renderJudgmentDetail('REL-MALFORMED');
    expect(html).toContain('agent_topic_key');
    expect(html).toContain('&lt;b&gt;actor&lt;/b&gt;');
    expect(html).not.toContain('<b>actor</b>');
    expect(html).toContain('1970-01-01T00:00:02.000Z');
  });
});

describe('judgment evidence fallback', () => {
  it('renders a malformed stored evidence value escaped instead of throwing', async () => {
    const html = await renderJudgmentDetail('REL-MALFORMED');
    expect(html).toContain('{not json &lt;b&gt;raw&lt;/b&gt;');
    expect(html).toMatch(/<pre tabindex="0"[^>]*whitespace-pre-wrap!/);
    expect(html).toContain('wrap-anywhere!');
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
  it('renders the pending verdict pill and the row actions menu trigger', async () => {
    const html = await renderJudgments();
    expect(html).toContain('</span>pending</span>');
    expect(html).toContain('Actions for judgment widget RS');
    expect(html).not.toContain('/dashboard/relations');
  });

  it('links the judgment title to its detail instead of the source memory', async () => {
    const html = await renderJudgments();
    expect(html).toMatch(/<a[^>]*href="\/dashboard\/judgments\/REL-MALFORMED"[^>]*>widget RS<\/a>/);
    expect(html).not.toContain('href="/dashboard/memories/RS"');
  });

  it('keeps the row menu content client-only, so menu labels and orphan controls stay out of the SSR document', async () => {
    const html = await renderJudgments();
    expect(html).toContain('Actions for judgment widget RS');
    expect(html).not.toContain('View details');
    expect(html).not.toContain('Mark orphaned');
  });

  it('exposes the search box, the status pills and the selection checkboxes', async () => {
    const html = await renderJudgments();
    expect(html).toContain('aria-label="Filter by status"');
    expect(html).toContain('Orphaned');
    expect(html).toContain('Search judgments…');
    expect(html).toContain('Select all rows on this page');
    expect(html).toContain('Select widget RS → widget RT"');
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
    expect(html).toContain(`1–${PAGE_SIZE} of ${SEEDED + 1}`);
    expect(html).not.toContain(`${SEEDED} ROWS`);
  });
});

describe('relation chip tone schema', () => {
  it('tones supersedes lime, conflicts_with amber and pending dim', async () => {
    t.handle.db
      .insert(memory)
      .values([widget('RS2'), widget('RT2'), widget('RS3'), widget('RT3')])
      .run();
    t.handle.db
      .insert(memoryRelations)
      .values([
        {
          id: 'REL-LIME',
          judgmentId: 'J-LIME',
          sourceId: 'RS2',
          targetId: 'RT2',
          relation: 'supersedes',
          status: 'judged',
          createdAt: new Date(1_000),
          judgedAt: new Date(2_000),
        },
        {
          id: 'REL-AMBER',
          judgmentId: 'J-AMBER',
          sourceId: 'RS3',
          targetId: 'RT3',
          relation: 'conflicts_with',
          status: 'judged',
          createdAt: new Date(1_000),
          judgedAt: new Date(2_000),
        },
      ])
      .run();

    const html = await renderJudgments();

    expect(relationChipClass(html, 'supersedes')).toContain(
      'border-primary/40 bg-primary/10 text-primary',
    );
    expect(relationChipClass(html, 'conflicts_with')).toContain(
      'border-warn/40 bg-warn/10 text-warn',
    );
    expect(relationChipClass(html, 'pending')).toContain(
      'border-border bg-input/60 text-muted-foreground',
    );
  });
});

describe('judgment bulk orphan action', () => {
  it('consults the server guard before touching any relation', async () => {
    const { bulkOrphanJudgments } = await import('../../app/dashboard/judgments/page');
    const formData = new FormData();
    formData.set('csrf', 'test-csrf-token');
    formData.set('judgmentId', 'J-MALFORMED');

    const result = await bulkOrphanJudgments({ error: null }, formData);

    expect(result).toEqual({ error: null });
    const services = servicesRef.current as Services;
    expect(services.repos.relations.findByJudgmentId('J-MALFORMED')?.status).toBe('pending');
  });
});
