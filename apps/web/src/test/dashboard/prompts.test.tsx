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
    rows.push(
      prompt({
        id: `D${i}`,
        content: `deleted ${i}`,
        createdAt: new Date(9_000),
        deletedAt: new Date(9_500),
      }),
    );
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

describe('prompts row actions', () => {
  function firstBodyRow(html: string): string {
    const bodyAt = html.indexOf('</thead>');
    if (bodyAt === -1) throw new Error('rendered table has no thead');
    const start = html.indexOf('<tr', bodyAt);
    if (start === -1) throw new Error('rendered table has no body row');
    return html.slice(start, html.indexOf('</tr>', start));
  }

  it('renders a Delete control on a live row and no Undelete on it', async () => {
    const liveRow = firstBodyRow(await renderPrompts());

    expect(liveRow).toContain('>Delete<');
    expect(liveRow).not.toContain('>Undelete<');
  });

  it('renders the actions column header', async () => {
    const html = await renderPrompts();
    expect(html).toContain('>Actions<');
  });

  it('renders an Undelete control on the soft-deleted row and no Delete on it', async () => {
    const deletedRow = firstBodyRow(await renderPrompts({ include_deleted: '1' }));

    expect(deletedRow).toContain('>Undelete<');
    expect(deletedRow).not.toContain('>Delete<');
  });

  it('gates the Delete control behind the confirmation dialog and leaves Undelete ungated', async () => {
    const liveRow = firstBodyRow(await renderPrompts());
    const deleteAt = liveRow.indexOf('>Delete<');
    const deleteTag = liveRow.slice(liveRow.lastIndexOf('<button', deleteAt), deleteAt);
    expect(deleteTag).toContain('data-slot="alert-dialog-trigger"');
    expect(deleteTag).toContain('type="button"');

    const deletedRow = firstBodyRow(await renderPrompts({ include_deleted: '1' }));
    const undeleteAt = deletedRow.indexOf('>Undelete<');
    const undeleteTag = deletedRow.slice(deletedRow.lastIndexOf('<button', undeleteAt), undeleteAt);
    expect(undeleteTag).not.toContain('alert-dialog-trigger');
    expect(undeleteTag).toContain('type="submit"');
  });

  it('submits the hidden row id alongside the per-form CSRF field', async () => {
    const html = await renderPrompts();
    expect(html).toContain('name="csrf"');
    expect(html).toContain('name="id"');
  });

  it('flashes the soft-delete outcome with the link to the deleted view', async () => {
    const html = await renderPrompts({ deleted: 'D0' });
    expect(html).toContain('soft-deleted.');
    expect(html).toContain('/dashboard/prompts?include_deleted=1');
  });

  it('flashes the restore outcome', async () => {
    const html = await renderPrompts({ undeleted: 'D0' });
    expect(html).toContain('restored.');
  });
});
