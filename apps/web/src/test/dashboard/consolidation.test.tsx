import { createRepositories } from '@rembric/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../db';

import { buildDashboardServices, installViewMocks, renderToHtml, servicesRef } from './harness';

installViewMocks('/dashboard/consolidation');

const PAGE_SIZE = 50;
const SEEDED = PAGE_SIZE + 2;

const MALFORMED_SUMMARY = '{not json <b>raw</b>';

let t: TestDb;

beforeEach(() => {
  t = createTestDb();
  servicesRef.current = buildDashboardServices(t.handle);
  const repos = createRepositories(t.handle.db);
  repos.consolidation.insertRun({
    id: 'RUN-MALFORMED',
    startedAt: new Date(1_000),
    scope: 'global',
    summary: MALFORMED_SUMMARY,
  });
  repos.consolidation.insertRun({
    id: 'RUN-STRUCTURED',
    startedAt: new Date(2_000),
    scope: 'global',
    summary: JSON.stringify({ archives: 2, orphaned: 1 }),
  });
});

afterEach(() => t.cleanup());

async function renderRunDetail(id: string): Promise<string> {
  const page = (await import('../../app/dashboard/consolidation/[id]/page')).default;
  return renderToHtml(await page({ params: Promise.resolve({ id }) }));
}

async function renderConsolidation(): Promise<string> {
  const page = (await import('../../app/dashboard/consolidation/page')).default;
  return renderToHtml(await page({ searchParams: Promise.resolve({}) }));
}

describe('consolidation run summary fallback', () => {
  it('renders a malformed stored summary escaped instead of throwing', async () => {
    const html = await renderRunDetail('RUN-MALFORMED');
    expect(html).toContain('{not json &lt;b&gt;raw&lt;/b&gt;');
    expect(html).not.toContain('<b>raw</b>');
  });

  it('decodes a structured sweep summary into prose inside the same <pre>', async () => {
    const html = await renderRunDetail('RUN-STRUCTURED');
    expect(html).toMatch(/<pre[^>]*>[\s\S]*2 archived · 1 orphaned[\s\S]*<\/pre>/);
  });
});

describe('consolidation list page slice', () => {
  it(`caps the runs list at PAGE_SIZE for ${SEEDED} seeded runs`, async () => {
    const repos = createRepositories(t.handle.db);
    for (let i = 0; i < SEEDED; i++) {
      repos.consolidation.insertRun({
        id: `RUN${i}`,
        startedAt: new Date(1_000 + i),
        scope: 'global',
      });
    }

    const html = await renderConsolidation();
    expect(html).toContain(`${PAGE_SIZE} OF ${SEEDED + 2}`);
    expect(html).not.toContain(`${PAGE_SIZE + 1} OF`);
  });
});
