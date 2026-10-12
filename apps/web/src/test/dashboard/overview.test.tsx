import { afterEach, beforeEach, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../db';

import { buildDashboardServices, installViewMocks, renderToHtml, servicesRef } from './harness';

import { TooltipProvider } from '@/components/ui/tooltip';

installViewMocks('/dashboard');

let t: TestDb;

beforeEach(() => {
  t = createTestDb();
  servicesRef.current = { ...buildDashboardServices(t.handle), db: t.handle };
});

afterEach(() => t.cleanup());

it('offers an accessible manual refresh beside the Overview heading', async () => {
  const { default: Overview } = await import('../../app/dashboard/page');
  const html = await renderToHtml(<TooltipProvider>{Overview()}</TooltipProvider>);

  expect(html).toContain('>Overview</h1>');
  expect(html).toContain('aria-label="Refresh overview"');
});
