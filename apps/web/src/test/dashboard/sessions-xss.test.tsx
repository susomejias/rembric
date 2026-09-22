import { agentSessions, prompts, projects, tokens } from '@rembric/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../db';

import { buildDashboardServices, installViewMocks, renderToHtml, servicesRef } from './harness';

installViewMocks('/dashboard/sessions');

const MALICIOUS_TAG = '<img src=x onerror=alert(1)>';
const MALICIOUS_SCRIPT = '<script>alert(1)</script>';

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
      { id: 'S1', tokenId: 'tk1', agent: 'claude-code', status: 'ended', startedAt: new Date(500) },
      {
        id: 'S-RAW-XSS',
        tokenId: 'tk1',
        agent: 'claude-code',
        status: 'ended',
        startedAt: new Date(500),
        description: 'seed goal here',
        summary: `${MALICIOUS_SCRIPT}\n\n**Fixed it.**`,
        summaryFinal: false,
      },
      {
        id: 'S-CURATED-XSS',
        tokenId: 'tk1',
        agent: 'claude-code',
        status: 'ended',
        startedAt: new Date(500),
        summary: `${MALICIOUS_SCRIPT}\n\n**Accomplished**`,
        summaryFinal: true,
      },
    ])
    .run();
  t.handle.db
    .insert(prompts)
    .values([
      {
        id: 'P1',
        sessionId: 'S1',
        content: 'deploy notes',
        title: 'deploy',
        tags: [MALICIOUS_TAG],
        createdAt: new Date(1_000),
      },
    ])
    .run();
});

afterEach(() => t.cleanup());

async function renderSessionDetail(id: string): Promise<string> {
  const page = (await import('../../app/dashboard/sessions/[id]/page')).default;
  return renderToHtml(await page({ params: Promise.resolve({ id }) }));
}

async function renderSessionsList(): Promise<string> {
  const page = (await import('../../app/dashboard/sessions/page')).default;
  return renderToHtml(await page({ searchParams: Promise.resolve({}) }));
}

describe('dashboard sessions XSS regression (#252)', () => {
  it('escapes a malicious prompt tag on the session-detail page', async () => {
    const html = await renderSessionDetail('S1');
    expect(html).not.toContain(MALICIOUS_TAG);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapes a legacy (pre-regex) project slug on the session-list page', async () => {
    t.handle.db
      .insert(projects)
      .values([{ id: 'PR1', slug: 'legit-slug', createdAt: new Date(500) }])
      .run();
    t.handle.raw
      .prepare("UPDATE projects SET slug = '<script>alert(1)</script>' WHERE id = 'PR1'")
      .run();
    t.handle.raw.prepare("UPDATE sessions SET project_id = 'PR1' WHERE id = 'S1'").run();

    const html = await renderSessionsList();
    expect(html).not.toContain(MALICIOUS_SCRIPT);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes a raw (uncurated) summary inside the <pre> boundary', async () => {
    const html = await renderSessionDetail('S-RAW-XSS');
    expect(html).toContain('>RAW<');
    expect(html).toMatch(/<pre[^>]*>[\s\S]*&lt;script&gt;alert\(1\)&lt;\/script&gt;[\s\S]*<\/pre>/);
    expect(html).not.toContain(MALICIOUS_SCRIPT);
    expect(html).toContain('**Fixed it.**');
    expect(html).not.toContain('<strong>Fixed it.</strong>');
  });

  it('never renders raw HTML from a curated markdown summary', async () => {
    const html = await renderSessionDetail('S-CURATED-XSS');
    expect(html).not.toContain(MALICIOUS_SCRIPT);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('<strong class="font-medium text-primary">Accomplished</strong>');
  });
});
