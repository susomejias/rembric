import { pageParam, singleParam } from '@/components/dashboard/support';

export type SearchParams = Record<string, string | string[] | undefined>;

/**
 * The entities list's filter model: `kind` is passed through as sent so an
 * unknown kind matches no row in SQL, and `single_ref=1` is the only truthy
 * spelling of the checkbox.
 */
export interface EntitiesFilters {
  kind: string;
  singleReferenceOnly: boolean;
  page: number;
}

export function readEntitiesFilters(searchParams: SearchParams): EntitiesFilters {
  return {
    kind: singleParam(searchParams['kind']),
    singleReferenceOnly: singleParam(searchParams['single_ref']) === '1',
    page: pageParam(searchParams['page']),
  };
}

/**
 * Every param the current URL carries, except `page` — the set the pager and the
 * filter form round-trip.
 */
export function entitiesQuery(searchParams: SearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(searchParams)) {
    if (key === 'page') continue;
    out[key] = singleParam(raw);
  }
  return out;
}
