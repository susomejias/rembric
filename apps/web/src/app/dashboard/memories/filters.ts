import { pageParam, RETIRED_PROJECT_FILTER, singleParam } from '@/components/dashboard/format';

export type SearchParams = Record<string, string | string[] | undefined>;

/** The status a memories listing shows when the URL names none. */
export const DEFAULT_STATUS = 'active' as const;

/**
 * The memories list's filter model. Reading is deliberately the same shape the
 * Hono handler used (`apps/server/src/dashboard/memories.ts`): `status` defaults
 * to `active` only when the param is absent, the retired `__global__` project
 * sentinel normalises to "no filter", and every other filter is empty-string
 * "unset".
 */
export interface MemoriesFilters {
  project: string;
  status: string;
  type: string;
  review: string;
  q: string;
  page: number;
}

export function readMemoriesFilters(searchParams: SearchParams): MemoriesFilters {
  const project = singleParam(searchParams['project']);
  return {
    project: project === RETIRED_PROJECT_FILTER ? '' : project,
    status:
      searchParams['status'] === undefined ? DEFAULT_STATUS : singleParam(searchParams['status']),
    type: singleParam(searchParams['type']),
    review: singleParam(searchParams['review']),
    q: singleParam(searchParams['q']),
    page: pageParam(searchParams['page']),
  };
}

/**
 * Every param the current URL carries, except `page` and the retired project
 * sentinel — the set the pager and the filter form round-trip. Rebuilt from the
 * raw params (not from the normalised filters) so a submitted `status=active`
 * survives into the next page's href exactly as the browser sent it.
 */
export function memoriesQuery(searchParams: SearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(searchParams)) {
    if (key === 'page') continue;
    const value = singleParam(raw);
    if (key === 'project' && value === RETIRED_PROJECT_FILTER) continue;
    out[key] = value;
  }
  return out;
}

/**
 * A project slug that names no live project filters to NOTHING rather than
 * silently dropping the filter: it is a stale or hand-edited URL, and the
 * operator should see the emptiness. Same rule every list view in the retired
 * dashboard shared.
 */
export function resolveProjectFilter(
  slug: string,
  projectRows: readonly { id: string; slug: string }[],
): { projectId?: string; unknown: boolean } {
  if (slug === '') return { unknown: false };
  const row = projectRows.find((p) => p.slug === slug);
  return row ? { projectId: row.id, unknown: false } : { unknown: true };
}
