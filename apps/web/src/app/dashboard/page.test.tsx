import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildDashboardServices,
  installViewMocks,
  renderToHtml,
  servicesRef,
} from '../../test/dashboard/harness';
import { createTestDb, type TestDb } from '../../test/db';

import DashboardOverviewPage from './page';

import { TooltipProvider } from '@/components/ui/tooltip';

installViewMocks('/dashboard');
let t: TestDb;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  t = createTestDb();
  servicesRef.current = { ...buildDashboardServices(t.handle), db: t.handle };
});
afterEach(() => {
  t.cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('Wrapped overview promotion', () => {
  it.each([
    ['2026-11-30T23:59:59.999Z', undefined, false],
    ['2026-12-01T00:00:00.000Z', undefined, true],
    ['2026-12-31T23:59:59.999Z', undefined, true],
    ['2027-01-01T00:00:00.000Z', undefined, true],
    ['2027-01-31T23:59:59.999Z', undefined, true],
    ['2027-02-01T00:00:00.000Z', undefined, false],
    ['2026-06-01T00:00:00.000Z', 'true', true],
    ['2026-06-01T00:00:00.000Z', 'false', false],
    ['2026-06-01T00:00:00.000Z', '1', false],
    ['2026-06-01T00:00:00.000Z', 'TRUE', false],
    ['2026-12-01T00:00:00.000Z', 'false', true],
  ])('at %s with force=%s shows card=%s', async (date, force, visible) => {
    vi.setSystemTime(new Date(date));
    vi.stubEnv('REMBRIC_WRAPPED_FORCE', force);
    const html = await renderToHtml(<TooltipProvider>{DashboardOverviewPage()}</TooltipProvider>);
    expect(html).toContain('Overview');
    expect(html.includes('id="wrapped-entry"')).toBe(visible);
    expect(html.includes('href="/dashboard/wrapped"')).toBe(visible);
  });
});
