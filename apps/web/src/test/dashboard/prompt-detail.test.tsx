import { agentSessions, projects, prompts, tokens, type NewPrompt } from '@rembric/db';
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../db';

import { buildDashboardServices, installViewMocks, renderToHtml, servicesRef } from './harness';

import { DetailCopy } from '@/components/dashboard/detail-copy';
import { DetailImageCard } from '@/components/dashboard/detail-image-card';
import type { DetailLayout } from '@/components/dashboard/detail-layout';
import { DetailShare } from '@/components/dashboard/detail-share';
import { MarkdownPanel } from '@/components/dashboard/markdown-panel';

installViewMocks('/dashboard/prompts');

let t: TestDb;

beforeEach(() => {
  t = createTestDb();
  servicesRef.current = buildDashboardServices(t.handle);
  t.handle.db
    .insert(projects)
    .values({ id: 'p1', slug: 'proj-one', createdAt: new Date(500) })
    .run();
  t.handle.db
    .insert(tokens)
    .values({ id: 'tk1', name: 'test', hash: 'x', scope: '*', createdAt: new Date(500) })
    .run();
  t.handle.db
    .insert(agentSessions)
    .values({
      id: 'S1',
      tokenId: 'tk1',
      agent: 'claude-code',
      status: 'ended',
      startedAt: new Date(500),
    })
    .run();
});

afterEach(() => t.cleanup());

function seed(overrides: Partial<NewPrompt> = {}) {
  t.handle.db
    .insert(prompts)
    .values({
      id: 'P1',
      title: 'Captured request',
      content: 'Original body',
      createdAt: new Date(1_000),
      ...overrides,
    })
    .run();
}

async function detail(id = 'P1'): Promise<ReactElement<ComponentProps<typeof DetailLayout>>> {
  const page = (await import('../../app/dashboard/prompts/[id]/page')).default;
  return page({ params: Promise.resolve({ id }) });
}

function markdownProps(node: ReactNode): Record<string, unknown> | undefined {
  if (Array.isArray(node)) {
    return node.map((child: ReactNode) => markdownProps(child)).find(Boolean);
  }
  if (!isValidElement<{ children?: ReactNode }>(node)) return undefined;
  if (node.type === MarkdownPanel) return node.props;
  return markdownProps(node.props.children);
}

function descendants(node: ReactNode): ReactElement<{ children?: ReactNode }>[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<{ children?: ReactNode }>(child)
      ? [child, ...descendants(child.props.children)]
      : [],
  );
}

describe('prompt detail', () => {
  it('uses Ficha with one exact copy, complete share data, primary agent badge and direct lifecycle action', async () => {
    const content = '  Original request in proj-one\n\n**Keep Markdown** and whitespace.\n';
    seed({
      content,
      projectId: 'p1',
      agent: 'codex-cli',
      sessionId: 'S1',
      tags: ['private', 'complete'],
    });
    const page = await detail();
    const controls = descendants(page.props.primaryActions);
    const copy = controls.find((child) => child.type === DetailCopy);
    const share = controls.find((child) => child.type === DetailShare);
    if (
      !isValidElement<ComponentProps<typeof DetailCopy>>(copy) ||
      !isValidElement<ComponentProps<typeof DetailShare>>(share)
    )
      throw new Error('Missing primary controls');
    expect(copy.props.text).toBe(content);
    expect(share.props.data).toEqual({
      kind: 'prompt',
      label: 'Prompt',
      title: 'Captured request',
      date: new Date(1_000),
      byline: 'Captured by codex-cli',
      projectName: 'proj-one',
      tags: ['private', 'complete'],
      content: { text: content, mode: 'markdown', label: 'Full content' },
    });
    const html = await renderToHtml(page);
    expect(html).toContain('detail-layout detail-ficha');
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html.match(/aria-label="Copy"/g)).toHaveLength(1);
    expect(html).toMatch(/data-slot="badge"[^>]*bg-primary[^>]*>codex-cli<\/span>/);
    expect(html).not.toContain('detail-actions-panel');
    expect(html).toContain('>Delete</button>');
    expect(html).toMatch(/<details[^>]*aria-label="Properties"/);
    expect(html).not.toMatch(/<details[^>]*\bopen/);
    const card = await renderToHtml(
      <DetailImageCard
        data={share.props.data}
        options={{ content: true, project: false, stats: true }}
        logo="/logo.png"
      />,
    );
    expect(card).toContain('Original request in proj-one');
    expect(card).toContain('Keep Markdown');
    expect(card).not.toContain('Captured by codex-cli in proj-one');
    expect(card).not.toContain('detail-image-stats');
  });

  it('keeps more than six header tags available through one in-place disclosure without duplicating them in properties', async () => {
    seed({ tags: Array.from({ length: 8 }, (_, i) => `tag-${i}`) });
    const page = await detail();
    const html = await renderToHtml(page);
    expect(html).toContain('role="group" aria-label="Tags"');
    expect(html).toContain('aria-label="Show all 8 tags" aria-expanded="false"');
    expect(html).toContain('hidden=""');
    for (let i = 0; i < 8; i++) expect(html.match(new RegExp(`tag-${i}`, 'g'))).toHaveLength(1);
  });

  it('normalizes absent metadata for sharing without inventing statistics or an agent', async () => {
    seed();
    const page = await detail();
    const share = descendants(page.props.primaryActions).find(
      (child) => child.type === DetailShare,
    );
    if (!isValidElement<ComponentProps<typeof DetailShare>>(share))
      throw new Error('Missing Share');
    expect(share.props.data.byline).toBe('Captured prompt');
    expect(share.props.data.projectName).toBe('—');
    expect(share.props.data.tags).toEqual([]);
    expect(share.props.data.stats).toBeUndefined();
    expect(share.props.data.duration).toBeUndefined();
    expect(await renderToHtml(page)).not.toContain('data-slot="badge"');
  });

  it('renders the full long body safely in the shared reading layout and copies the exact original', async () => {
    const content = `  # Request\n\n${'Long paragraph with spaces. '.repeat(150)}\n\nLAST LINE\n\n<script>alert("unsafe")</script>\n\n[unsafe](javascript:alert(1))\n`;
    seed({ content });
    const page = await detail();
    const html = await renderToHtml(page);
    expect(html).toContain('detail-layout');
    expect(html).toContain('>Prompts</a>');
    expect(html.match(/Captured request/g)).toHaveLength(1);
    expect(html).toContain('LAST LINE');
    expect(html.match(/Long paragraph with spaces\./g)).toHaveLength(150);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('href="javascript:');
    expect(markdownProps(page)).toMatchObject({
      presentation: 'reading',
      hideToolbar: true,
      markdown: content,
    });
    expect(markdownProps(page)).not.toHaveProperty('eyebrow');
  });

  it('shows metadata and links to the project, session and every predecessor', async () => {
    seed({
      projectId: 'p1',
      sessionId: 'S1',
      agent: 'claude-code',
      tags: ['dashboard', 'navigation'],
      replaces: ['OLD-1', 'OLD-2'],
    });
    const html = await renderToHtml(await detail());
    expect(html).toContain('P1');
    expect(html).toContain('claude-code');
    expect(html).toContain('dashboard');
    expect(html).toContain('navigation');
    expect(html).toContain('proj-one');
    expect(html).toContain('href="/dashboard/projects?q=proj-one"');
    expect(html).toContain('href="/dashboard/sessions/S1"');
    expect(html).toContain('href="/dashboard/prompts/OLD-1"');
    expect(html).toContain('href="/dashboard/prompts/OLD-2"');
    expect(html).toContain('data-rembric-ts');
    expect(html).toContain('refined');
  });

  it('handles null optional metadata and offers only the guarded delete confirmation', async () => {
    seed();
    const html = await renderToHtml(await detail());
    for (const label of [
      'ID',
      'Project',
      'Agent',
      'Tags',
      'Created',
      'Session',
      'Replaces',
      'Status',
    ])
      expect(html).toContain(label);
    expect(html).toContain('—');
    expect(html).toContain('active');
    expect(html).not.toContain('href="/dashboard/sessions/');
    expect(html).not.toContain('href="/dashboard/projects');
    expect(html).toContain('aria-label="Prompt actions"');
    expect(html).toContain('>Delete</button>');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('name="csrf" value="test-csrf-token"');
    expect(html).toContain('name="id" value="P1"');
    expect(html).not.toContain('>Undelete</button>');
  });

  it('keeps deleted content readable with a deletion notice and restore only', async () => {
    seed({ deletedAt: new Date(2_000) });
    const html = await renderToHtml(await detail());
    expect(html).toContain('Original body');
    expect(html).toContain('SOFT-DELETED');
    expect(html).toContain('deleted');
    expect(html).toContain('>Undelete</button>');
    expect(html).not.toContain('>Delete</button>');
    expect(html).not.toContain('data-slot="alert-dialog-trigger"');
    expect(html).toContain('name="csrf" value="test-csrf-token"');
    expect(html).toContain('name="id" value="P1"');
  });

  it('returns notFound for an unknown id', async () => {
    await expect(detail('MISSING')).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
