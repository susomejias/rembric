import { pageParam, singleParam } from '@/components/dashboard/support';

export type SearchParams = Record<string, string | string[] | undefined>;

/** The status a projects listing shows when the URL names none. */
export const DEFAULT_PROJECT_STATUS = 'all' as const;

/**
 * The projects list's filter model: `status` collapses an active and an archived
 * table into one URL-driven table.
 */
export interface ProjectsFilters {
  status: string;
  page: number;
}

export function readProjectsFilters(searchParams: SearchParams): ProjectsFilters {
  return {
    // Absent means "all"; an unrecognised value is kept as sent so the page can
    // filter it to nothing rather than silently widening back to "all".
    status:
      searchParams['status'] === undefined
        ? DEFAULT_PROJECT_STATUS
        : singleParam(searchParams['status']),
    page: pageParam(searchParams['page']),
  };
}

/**
 * Every param the current URL carries, except `page` — the set the pager and the
 * filter form round-trip. Rebuilt from the raw params (not the normalised
 * filters) so a submitted `status=active` survives into the next page's href
 * exactly as the browser sent it.
 */
export function projectsQuery(searchParams: SearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(searchParams)) {
    if (key === 'page') continue;
    out[key] = singleParam(raw);
  }
  return out;
}
