import { projects, prompts, type NewPrompt } from '@rembric/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../db';

import { buildDashboardServices, installViewMocks, renderToHtml, servicesRef } from './harness';

installViewMocks('/dashboard/prompts');

const PAGE_SIZE = 50;
const GLOBAL_COUNT = PAGE_SIZE + 2;
const PROJECT_COUNT = 3;
const DELETED_COUNT = 2;
const NON_DELETED_TOTAL = GLOBAL_COUNT + PROJECT_COUNT;
const ALL_TOTAL = NON_DELETED_TOTAL + DELETED_COUNT;

let t: TestDb;

function prompt(overrides: Partial<NewPrompt> & { id: string; content: string }): NewPrompt {
  return {
    title: `prompt ${overrides.id}`,
    createdAt: new Date(1_000),
    ...overrides,
  };
}

beforeEach(() => {
  t = createTestDb();
  servicesRef.current = buildDashboardServices(t.handle);
  t.handle.db
    .insert(projects)
    .values({ id: 'p1', slug: 'proj-one', createdAt: new Date(500) })
    .run();

  const rows: NewPrompt[] = [];
  for (let i = 0; i < GLOBAL_COUNT; i++) rows.push(prompt({ id: `G${i}`, content: `widget ${i}` }));
  for (let i = 0; i < PROJECT_COUNT; i++)
    rows.push(prompt({ id: `PR${i}`, content: `scoped ${i}`, projectId: 'p1' }));
  for (let i = 0; i < DELETED_COUNT; i++)
    rows.push(prompt({ id: `D${i}`, content: `deleted ${i}`, deletedAt: new Date(9_000) }));
  t.handle.db.insert(prompts).values(rows).run();
});

afterEach(() => t.cleanup());

async function renderPrompts(params: Record<string, string> = {}): Promise<string> {
  const page = (await import('../../app/dashboard/prompts/page')).default;
  return renderToHtml(await page({ searchParams: Promise.resolve(params) }));
}

describe('prompts dashboard totals and page slice', () => {
  it(`shows the true non-deleted total (${NON_DELETED_TOTAL}), not the page slice`, async () => {
    const html = await renderPrompts();
    expect(html).toContain(`${NON_DELETED_TOTAL} MATCHING`);
    expect(html).toContain(`${PAGE_SIZE} ROWS`);
    expect(html).not.toContain(`${PAGE_SIZE + 1} ROWS`);
  });

  it('the total honors the project filter', async () => {
    const html = await renderPrompts({ project: 'proj-one' });
    expect(html).toContain(`${PROJECT_COUNT} MATCHING`);
  });

  it('include_deleted flips the total to the full row count', async () => {
    const html = await renderPrompts({ include_deleted: '1' });
    expect(html).toContain(`${ALL_TOTAL} MATCHING`);
  });

  it('a text query renders a lower-bound "+"-suffixed matching count', async () => {
    const html = await renderPrompts({ q: 'widget' });
    expect(html).toMatch(/\d+\+ MATCHING/);
  });
});
