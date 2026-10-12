import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createTestDb, type TestDb } from '../db';

import { buildDashboardServices, installViewMocks, renderToHtml, servicesRef } from './harness';

installViewMocks();

let t: TestDb;

beforeEach(() => {
  t = createTestDb();
  servicesRef.current = { ...buildDashboardServices(t.handle), db: t.handle };
  vi.stubEnv('REMBRIC_DATA_DIR', t.dataDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  t.cleanup();
});

it.each([
  ['Consolidation', () => import('../../app/dashboard/consolidation/page')],
  ['Maintenance', () => import('../../app/dashboard/maintenance/page')],
] as const)('shows a visible, consistently styled %s heading', async (title, loadPage) => {
  const { default: Page } = await loadPage();
  const html = await renderToHtml(await Page({ searchParams: Promise.resolve({}) }));
  const headings = html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/g) ?? [];

  expect(headings).toHaveLength(1);
  expect(headings[0]).toContain(`>${title}</h1>`);
  expect(headings[0]).toContain('text-3xl font-semibold tracking-tight text-foreground');
  expect(headings[0]).not.toContain('sr-only');
});
