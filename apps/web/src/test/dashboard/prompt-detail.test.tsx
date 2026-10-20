import { agentSessions, projects, prompts, tokens, type NewPrompt } from '@rembric/db';
import { isValidElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../db';

import { buildDashboardServices, installViewMocks, renderToHtml, servicesRef } from './harness';

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

async function detail(id = 'P1') {
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

describe('prompt detail', () => {
  it('renders the full long body safely in the shared reading layout and copies the exact original', async () => {
    const content = `  # Request\n\n${'Long paragraph with spaces. '.repeat(150)}\n\nLAST LINE\n\n<script>alert("unsafe")</script>\n\n[unsafe](javascript:alert(1))\n`;
    seed({ content });
    const page = await detail();
    const html = await renderToHtml(page);
    expect(html).toContain('detail-layout');
    expect(html).toContain('BACK TO PROMPTS');
    expect(html.match(/Captured request/g)).toHaveLength(1);
    expect(html).toContain('LAST LINE');
    expect(html.match(/Long paragraph with spaces\./g)).toHaveLength(150);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('href="javascript:');
    expect(markdownProps(page)).toMatchObject({
      presentation: 'reading',
      hideTitle: true,
      markdown: content,
      copyMarkdown: content,
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
