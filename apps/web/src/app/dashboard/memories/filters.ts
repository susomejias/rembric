import { pageParam, RETIRED_PROJECT_FILTER, singleParam } from '@/components/dashboard/support';

export type SearchParams = Record<string, string | string[] | undefined>;

export const DEFAULT_STATUS = 'active' as const;

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

export function resolveProjectFilter(
  slug: string,
  projectRows: readonly { id: string; slug: string }[],
): { projectId?: string; unknown: boolean } {
  if (slug === '') return { unknown: false };
  const row = projectRows.find((p) => p.slug === slug);
  return row ? { projectId: row.id, unknown: false } : { unknown: true };
}
