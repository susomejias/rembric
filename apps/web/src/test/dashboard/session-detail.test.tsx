import { agentSessions, tokens } from '@rembric/db';
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
        summary: 'Goal: fix the bug.\n\n**Accomplished**: fixed it.',
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
  it('renders a curated summary as Markdown with no RAW chip', async () => {
    const html = await renderSessionDetail('S-CURATED');
    expect(html).toContain('<strong class="font-medium text-primary">Accomplished</strong>');
    expect(html).not.toContain('>RAW<');
    expect(html).toContain('seed goal here');
  });

  it('renders an uncurated summary as escaped preformatted text with a RAW chip', async () => {
    const html = await renderSessionDetail('S-RAW');
    expect(html).toContain('>RAW<');
    expect(html).toMatch(/<pre[^>]*>[\s\S]*fix the bug[\s\S]*<\/pre>/);
    expect(html).not.toContain('<strong>Fixed it.</strong>');
    expect(html).toContain('**Fixed it.**');
    expect(html).toContain('seed goal here');
  });

  it('renders no summary and no chip for an empty session', async () => {
    const html = await renderSessionDetail('S-EMPTY');
    expect(html).not.toContain('>RAW<');
  });
});
