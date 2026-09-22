import { pageParam, singleParam } from '@/components/dashboard/support';

export type SearchParams = Record<string, string | string[] | undefined>;

export const DEFAULT_PROJECT_STATUS = 'all' as const;

export interface ProjectsFilters {
  status: string;
  page: number;
}

export function readProjectsFilters(searchParams: SearchParams): ProjectsFilters {
  return {
    status:
      searchParams['status'] === undefined
        ? DEFAULT_PROJECT_STATUS
        : singleParam(searchParams['status']),
    page: pageParam(searchParams['page']),
  };
}

export function projectsQuery(searchParams: SearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(searchParams)) {
    if (key === 'page') continue;
    out[key] = singleParam(raw);
  }
  return out;
}
