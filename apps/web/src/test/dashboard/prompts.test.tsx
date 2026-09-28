import { agentSessions, projects, prompts, tokens, type NewPrompt } from '@rembric/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../db';

import { buildDashboardServices, installViewMocks, renderToHtml, servicesRef } from './harness';

import { PAGE_SIZE } from '@/components/dashboard/support';

installViewMocks('/dashboard/prompts');

const CLIENT_PAGE_SIZE = 10;
const GLOBAL_COUNT = 52;
const PROJECT_COUNT = 3;
const DELETED_COUNT = 2;

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
      status: 'active',
      startedAt: new Date(500),
    })
    .run();

  const rows: NewPrompt[] = [];
  for (let i = 0; i < GLOBAL_COUNT; i++)
    rows.push(
      prompt({
        id: `G${i}`,
        content: `widget ${i}`,
        // The newest live row, so it lands deterministically on the first page.
        ...(i === 0 ? { createdAt: new Date(1_500), sessionId: 'S1', agent: 'claude-code' } : {}),
      }),
    );
  for (let i = 0; i < PROJECT_COUNT; i++)
    rows.push(prompt({ id: `PR${i}`, content: `scoped ${i}`, projectId: 'p1' }));
  for (let i = 0; i < DELETED_COUNT; i++)
    rows.push(
      prompt({
        id: `D${i}`,
        content: `deleted ${i}`,
        createdAt: new Date(9_000 + i * 500),
        deletedAt: new Date(9_500 + i * 500),
      }),
    );
  t.handle.db.insert(prompts).values(rows).run();
});

afterEach(() => t.cleanup());

async function renderPrompts(params: Record<string, string> = {}): Promise<string> {
  const page = (await import('../../app/dashboard/prompts/page')).default;
  return renderToHtml(await page({ searchParams: Promise.resolve(params) }));
}

describe('prompts list (client data-table)', () => {
  it('loads one server page (50 rows) with the true non-deleted total', async () => {
    const html = await renderPrompts();
    expect(html).toContain(`1–${PAGE_SIZE} of ${GLOBAL_COUNT + PROJECT_COUNT}`);
    expect(html).not.toContain(`1–${CLIENT_PAGE_SIZE} of 50`);
  });

  it('offers the lifecycle pills (live vs soft-deleted) with counts', async () => {
    const html = await renderPrompts();
    expect(html).toContain('aria-label="Filter by lifecycle"');
    expect(html).toContain('Deleted');
    expect(html).toContain('All');
  });

  it('exposes the search box and the row checkboxes without window-local chips', async () => {
    const html = await renderPrompts();
    expect(html).toContain('Search prompts…');
    expect(html).toContain('Select all rows on this page');
    expect(html).toContain('Select prompt prompt G0"');
  });

  it('renders the sr-only Actions header and a per-row actions menu trigger', async () => {
    const html = await renderPrompts();
    expect(html).toContain('sr-only">Actions</span>');
    expect(html).toContain('Actions for prompt prompt G0');
  });

  it('links a prompt to its session when the row carries one', async () => {
    const html = await renderPrompts();
    expect(html).toContain('href="/dashboard/sessions/S1"');
  });

  it('loads no soft-deleted row by default', async () => {
    const html = await renderPrompts();
    expect(html).not.toContain('Select prompt prompt D0"');
  });

  it('include_deleted adds the deleted rows and flips the total', async () => {
    const html = await renderPrompts({ include_deleted: '1' });
    expect(html).toContain('Select prompt prompt D1"');
    expect(html).toContain('aria-pressed="true"');
  });

  it('the lifecycle pills start on Live and offer the deleted view', async () => {
    const html = await renderPrompts();
    expect(html).toContain('All');
    expect(html).toContain('Deleted');
    expect(html).toContain('aria-pressed="true"');
  });
});

describe('prompts flash outcomes', () => {
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
