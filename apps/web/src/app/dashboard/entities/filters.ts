import { pageParam, singleParam } from '@/components/dashboard/support';

export type SearchParams = Record<string, string | string[] | undefined>;

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

export function entitiesQuery(searchParams: SearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(searchParams)) {
    if (key === 'page') continue;
    out[key] = singleParam(raw);
  }
  return out;
}
