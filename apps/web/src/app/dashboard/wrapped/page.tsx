import { redirect } from 'next/navigation';

import { Wrapped } from '@/components/dashboard/wrapped';
import { getServices } from '@/lib/services';
import { resolveDashboardSession } from '@/lib/session';
import { getWrappedSeason } from '@/lib/wrapped-season';

export const dynamic = 'force-dynamic';

export default async function WrappedPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string | string[] }>;
}) {
  const session = await resolveDashboardSession();
  if (!session || session.session.scope !== '*') redirect('/dashboard/login');
  const now = Date.now();
  const currentYear = new Date(now).getUTCFullYear();
  const defaultYear = getWrappedSeason(now).year;
  const params = await searchParams;
  const raw = typeof params.year === 'string' ? params.year : '';
  const requested = /^\d{4}$/.test(raw) ? Number(raw) : defaultYear;
  const year = requested >= 1970 && requested <= currentYear ? requested : defaultYear;
  const { repos } = getServices();
  const years = [...new Set([currentYear, year, ...repos.wrapped.adminYears(now)])].sort(
    (a, b) => b - a,
  );
  const data = repos.wrapped.adminYear(year, now);
  return <Wrapped key={year} data={data} years={years} />;
}
