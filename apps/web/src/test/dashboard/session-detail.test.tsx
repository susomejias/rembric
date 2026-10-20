import { AgentSessionsService } from '@rembric/core';
import { agentSessions, createRepositories, memory, prompts, tokens } from '@rembric/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../db';

import { buildDashboardServices, installViewMocks, renderToHtml, servicesRef } from './harness';

installViewMocks('/dashboard/sessions');

let t: TestDb;

beforeEach(() => {
  t = createTestDb();
  servicesRef.current = buildDashboardServices(t.handle);
  t.handle.db
    .insert(tokens)
    .values([{ id: 'tk1', name: 'test', hash: 'x', scope: '*', createdAt: new Date(500) }])
    .run();
  t.handle.db
    .insert(agentSessions)
    .values([
      {
        id: 'S-CURATED',
        tokenId: 'tk1',
        agent: 'claude-code',
        status: 'ended',
        startedAt: new Date(500),
        description: 'seed goal here',
        summary: 'Goal: fix the bug.\n\n**Accomplished**: fixed it.\n\n> Evidence with spaces.',
        summaryFinal: true,
      },
      {
        id: 'S-RAW',
        tokenId: 'tk1',
        agent: 'claude-code',
        status: 'ended',
        startedAt: new Date(500),
        description: 'seed goal here',
        summary: 'user: fix the bug\nassistant: **Fixed it.**',
        summaryFinal: false,
      },
      {
        id: 'S-EMPTY',
        tokenId: 'tk1',
        agent: 'claude-code',
        status: 'active',
        startedAt: new Date(500),
      },
    ])
    .run();
});

afterEach(() => t.cleanup());

async function renderSessionDetail(id: string): Promise<string> {
  const page = (await import('../../app/dashboard/sessions/[id]/page')).default;
  return renderToHtml(await page({ params: Promise.resolve({ id }) }));
}

describe('session detail curation-state rendering', () => {
  it('uses the shared reading layout with a unique title and secondary tables after prose', async () => {
    const html = await renderSessionDetail('S-CURATED');
    expect(html).toContain('detail-layout');
    expect(html.match(/seed goal here/g)).toHaveLength(1);
    expect(html).not.toContain('Prompts captured');
    expect(html.indexOf('Details</summary>')).toBeLessThan(html.indexOf('Accomplished'));
    expect(html.indexOf('Accomplished')).toBeLessThan(html.indexOf('MEMORIES (0)'));
    expect(html.indexOf('MEMORIES (0)')).toBeLessThan(html.indexOf('PROMPTS (0)'));
    expect(html).toContain('aria-label="Session actions"');
  });
  it('renders a curated summary as Markdown with no RAW chip', async () => {
    const html = await renderSessionDetail('S-CURATED');
    expect(html).toContain('<strong class="font-medium text-primary">Accomplished</strong>');
    expect(html).not.toContain('>RAW<');
    expect(html).toContain('seed goal here');
    expect(html).toContain('text-sm leading-7 text-foreground');
    expect(html).toMatch(/<blockquote[^>]*text-foreground[^>]*>/);
    expect(html).toContain('Evidence with spaces.');
  });

  it('renders an uncurated summary as escaped preformatted text with a RAW chip', async () => {
    const html = await renderSessionDetail('S-RAW');
    expect(html).toContain('>RAW<');
    expect(html).toMatch(/<pre[^>]*text-foreground[^>]*>[\s\S]*fix the bug[\s\S]*<\/pre>/);
    expect(html).not.toContain('<strong>Fixed it.</strong>');
    expect(html).toContain('**Fixed it.**');
    expect(html).toContain('seed goal here');
  });

  it.each([
    'Migration local es único DDL persistente. Pruebas existentes ROLLBACK.',
    'Migration local es únicoDDLpersistente. Pruebasexistentes ROLLBACK.',
  ])('preserves stored summary text through writing and rendering: %s', async (body) => {
    const repos = createRepositories(t.handle.db);
    const sessions = new AgentSessionsService(repos, t.handle.db);
    const summary = `## Verified+how\n\n${body}`;
    sessions.writeSummary('S-EMPTY', { tokenId: 'tk1', summary, final: true });
    expect(repos.agentSessions.adminGetDetail('S-EMPTY')?.summary).toBe(summary);
    const html = await renderSessionDetail('S-EMPTY');
    expect(html).toContain(`<p class="mb-3 leading-7 last:mb-0">${body}</p>`);
  });

  it('renders meaningful content and no chip for an empty session', async () => {
    const html = await renderSessionDetail('S-EMPTY');
    expect(html).not.toContain('>RAW<');
    expect(html).toContain('No summary has been recorded for this session.');
    expect(html).toContain('NO MEMORY WAS WRITTEN DURING THIS RUN');
    expect(html).toContain('NO PROMPT WAS CAPTURED');
  });

  it.each([
    ['active', false, ['Abandon', 'Delete']],
    ['ended', false, ['Delete']],
    ['abandoned', false, ['Delete']],
    ['active', true, ['Undelete']],
  ] as const)('preserves actions for %s with deleted=%s', async (status, deleted, labels) => {
    t.handle.raw
      .prepare('UPDATE sessions SET status = ?, deleted_at = ? WHERE id = ?')
      .run(status, deleted ? 2_000 : null, 'S-EMPTY');
    const html = await renderSessionDetail('S-EMPTY');
    for (const label of ['Abandon', 'Delete', 'Undelete']) {
      expect(html.includes(`>${label}</button>`)).toBe(
        labels.some((expected) => expected === label),
      );
    }
    expect(html.match(/name="csrf"/g)).toHaveLength(labels.length);
    expect(html.match(/name="id" value="S-EMPTY"/g)).toHaveLength(labels.length);
    expect(html.includes('SOFT-DELETED')).toBe(deleted);
    const ids = [...html.matchAll(/<form id="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(labels.length);
    expect((html.match(/aria-haspopup="dialog"/g) ?? []).length).toBe(deleted ? 0 : labels.length);
  });

  it('retains semantic memories then prompts tables and revoked-token metadata without prompt links', async () => {
    t.handle.raw.prepare('UPDATE tokens SET revoked_at = ? WHERE id = ?').run(2_000, 'tk1');
    t.handle.db
      .insert(memory)
      .values({
        id: 'SESSION-MEM',
        sessionId: 'S-CURATED',
        title: 'Saved memory',
        content: 'Durable body',
        type: 'project',
        tags: [],
        scope: 'project',
        status: 'active',
        replaces: [],
        createdAt: new Date(1_000),
        lastSeenAt: new Date(1_000),
      })
      .run();
    t.handle.db
      .insert(prompts)
      .values({
        id: 'SESSION-PROMPT',
        sessionId: 'S-CURATED',
        title: 'Captured prompt',
        content: 'Prompt body',
        tags: ['dashboard'],
        createdAt: new Date(1_000),
      })
      .run();
    const html = await renderSessionDetail('S-CURATED');
    expect(html.match(/<table\b/g)).toHaveLength(2);
    expect(html.match(/<div[^>]*data-slot="table-container"[^>]*tabindex="0"/g)).toHaveLength(2);
    expect(html).toMatch(
      /<summary>MEMORIES \(1\)<\/summary>[\s\S]*<table[\s\S]*Saved memory[\s\S]*<\/table>/,
    );
    expect(html).toMatch(
      /<summary>PROMPTS \(1\)<\/summary>[\s\S]*<table[\s\S]*Captured prompt[\s\S]*Prompt body[\s\S]*<\/table>/,
    );
    expect(html.indexOf('Saved memory')).toBeLessThan(html.indexOf('Captured prompt'));
    expect(html).toContain('href="/dashboard/memories/SESSION-MEM"');
    expect(html).not.toContain('href="/dashboard/prompts/');
    expect(html).toContain('test (revoked)');
    expect(html).not.toContain('Prompts captured');
  });
});
