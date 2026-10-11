import { createRepositories, memory } from '@rembric/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestDb, type TestDb } from '../../../test/db';

import WrappedPage from './page';

const state = vi.hoisted((): { scope: string | null; services: object } => ({
  scope: '*',
  services: {},
}));
vi.mock('@/lib/session', () => ({
  resolveDashboardSession: () =>
    state.scope === null ? null : { session: { scope: state.scope } },
}));
vi.mock('@/lib/services', () => ({ getServices: () => state.services }));
vi.mock('next/navigation', () => ({
  redirect: (href: string) => {
    throw new Error(`REDIRECT:${href}`);
  },
}));
vi.mock('@/components/dashboard/wrapped', () => ({ Wrapped: () => null }));
let t: TestDb;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(Date.UTC(2026, 5, 1)));
  t = createTestDb();
  state.scope = '*';
  vi.stubEnv('REMBRIC_WRAPPED_FORCE', undefined);
  state.services = { repos: createRepositories(t.handle.db) };
});
afterEach(() => {
  t.cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('Wrapped server-to-client boundary', () => {
  it.each([
    ['2026-12-31T23:59:59.999Z', 2026],
    ['2027-01-01T00:00:00.000Z', 2026],
    ['2027-01-31T23:59:59.999Z', 2026],
    ['2027-02-01T00:00:00.000Z', 2027],
  ])('defaults the direct route at %s to %i without requiring promotion', async (date, year) => {
    vi.setSystemTime(new Date(date));
    const page = await WrappedPage({ searchParams: Promise.resolve({}) });
    expect(page.props).toMatchObject({ data: { year } });
  });
  it('honors explicit years in January but replaces invalid years with the previous year', async () => {
    vi.setSystemTime(new Date('2027-01-15T12:00:00Z'));
    const explicit = await WrappedPage({ searchParams: Promise.resolve({ year: '2027' }) });
    expect(explicit.props).toMatchObject({ data: { year: 2027 } });
    for (const year of ['2028', 'bad', '1969', ['2025', '2026']]) {
      const page = await WrappedPage({ searchParams: Promise.resolve({ year }) });
      expect(page.props).toMatchObject({ data: { year: 2026 } });
    }
  });
  it('requires an instance-admin session even when promotion is forced', async () => {
    vi.stubEnv('REMBRIC_WRAPPED_FORCE', 'true');
    for (const scope of [null, 'project:test']) {
      state.scope = scope;
      await expect(WrappedPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
        'REDIRECT:/dashboard/login',
      );
    }
    state.scope = '*';
    await expect(WrappedPage({ searchParams: Promise.resolve({}) })).resolves.toBeDefined();
  });
  it('selects an earlier year and passes aggregates rather than private records', async () => {
    t.handle.db
      .insert(memory)
      .values({
        id: 'private-id',
        scope: 'global',
        type: 'project',
        title: 'private-title',
        content: 'private-content',
        tags: ['private-tag'],
        createdAt: new Date(Date.UTC(2025, 11, 31)),
      })
      .run();
    const page = await WrappedPage({ searchParams: Promise.resolve({ year: '2025' }) });
    expect(page.props).toMatchObject({
      data: { year: 2025, memories: 1, yearToDate: false },
      years: [2026, 2025],
    });
    expect(JSON.stringify(page.props)).not.toContain('private');
  });
  it('defaults invalid, repeated and future year parameters to the current UTC year', async () => {
    for (const year of ['2027', 'bad', '1969', '2025.0', ['2025', '2026']]) {
      const page = await WrappedPage({ searchParams: Promise.resolve({ year }) });
      expect(page.props).toMatchObject({ data: { year: 2026 } });
    }
  });
});
